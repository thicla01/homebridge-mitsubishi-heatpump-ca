#!/usr/bin/env node
// A fake Kumo LAN adapter: enough of the local protocol to stand in for a real
// indoor unit, so the multi-unit paths can be exercised without owning multiple
// heat pumps.
//
// WHAT THIS CAN PROVE
//   Everything on our side of the wire that needs more than one unit, or a unit
//   that misbehaves on cue: LAN discovery matching each device to the adapter
//   that authenticates its token, per-unit command routing, localControlIps
//   pinning, an address that answers nothing, the auth-failure streak warning,
//   the per-device request mutex, `localOnly` bootstrapping, and what several
//   accessories look like in the Home app at once.
//
// WHAT THIS CANNOT PROVE
//   That the protocol is right. The simulator signs with this repo's own
//   computeLocalToken and answers the shapes this repo expects, so it agrees
//   with us by construction — including anywhere we are both wrong. Only real
//   firmware settles that, and one real unit is enough to settle it. Keep the
//   division clear: hardware answers "does the adapter accept this?", the
//   simulator answers "do we do the right thing with N of them?".
//
// USAGE
//   npm run build            # the simulator imports dist/local-api.js
//   node tools/kumo-adapter-sim.mjs --units 3
//
//   Prints a ready-to-paste `localOnly` platform block, then serves the units
//   until interrupted, logging every request it answers. Credentials are derived
//   from the unit index, so the printed block stays valid across restarts.
//
// OPTIONS
//   --units N        how many units to simulate (default 3)
//   --port P         first TCP port; unit i listens on P+i (default 8180)
//   --bind ADDR      interface to listen on (default 127.0.0.1). Use the LAN
//                    address to drive a Homebridge on another machine — which is
//                    also the honest way to rehearse the "is it reachable from
//                    the Homebridge host?" question the config form asks.
//   --config-only    print the platform block as JSON and exit, serving nothing.
//                    For scripting the config edit: the credentials are derived
//                    from the unit index, so the block matches what a later run
//                    with the same --units/--port/--bind will actually serve.
//   --humidity       report a humidity sensor (exercises the sensor lookup)
//   --strict         reject overlapping requests to one unit with
//                    `serializer_error`, like an adapter that tolerates a single
//                    connection. Turns a mutex regression into a visible failure.
//   --fault i=KIND   misbehave on unit i. KIND is one of:
//                      mute      never answer (an address nothing lives at)
//                      authfail  always reject the token
//                      busy      always answer `__no_memory` (retryable)
//                      slow:MS   answer after MS milliseconds
//
// Not shipped to npm — `files` in package.json covers dist/ only.

import http from 'node:http';
import crypto from 'node:crypto';
// The token has to be computed the way the plugin computes it, so the simulator
// borrows the real implementation rather than restating it. Two places to find it:
// a repo checkout (where this file normally lives), or the package as installed on
// a Homebridge host — this tool is not shipped to npm, so on the machine where the
// multi-unit test actually matters it gets copied in beside an installed plugin
// rather than sitting inside a checkout.
let computeLocalToken;
for (const specifier of ['../dist/local-api.js', 'homebridge-mitsubishi-heatpump-ca/dist/local-api.js']) {
  try {
    ({ computeLocalToken } = await import(specifier));
    break;
  } catch { /* try the next one */ }
}
if (!computeLocalToken) {
  console.error(
    'Cannot find the plugin\'s local-api module.\n'
    + '  In a repo checkout: run `npm run build` first.\n'
    + '  On a Homebridge host: copy this file somewhere the installed plugin resolves from,\n'
    + '  e.g. /var/lib/homebridge/ (which has node_modules alongside it).',
  );
  process.exit(1);
}

// ---- arguments ------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const UNITS = Math.max(1, Number(flag('units', 3)) || 3);
const BASE_PORT = Number(flag('port', 8180)) || 8180;
const BIND = flag('bind', '127.0.0.1');
const HUMIDITY = has('humidity');
const STRICT = has('strict');

const faults = new Map();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--fault') {
    const [idx, kind] = String(argv[i + 1] ?? '').split('=');
    faults.set(Number(idx), kind ?? '');
  }
}

// ---- the simulated units --------------------------------------------------

/**
 * Credentials are derived from the index rather than random, so a restart does
 * not invalidate the config block printed by the previous run. They are fake by
 * construction and grant nothing anywhere.
 */
function credsFor(i) {
  const seed = crypto.createHash('sha256').update(`kumo-adapter-sim:${i}`).digest();
  return {
    password: seed.subarray(0, 12).toString('base64'),
    cryptoSerial: seed.subarray(12, 22).toString('hex'), // 10 bytes; the adapter's is >= 9
  };
}

const units = Array.from({ length: UNITS }, (_, i) => {
  const { password, cryptoSerial } = credsFor(i);
  return {
    index: i,
    serial: `SIM${String(i + 1).padStart(13, '0')}`,
    name: `Sim unit ${i + 1}`,
    port: BASE_PORT + i,
    password,
    cryptoSerial,
    fault: faults.get(i) ?? '',
    inFlight: false,
    // The status leaves this repo reads back. Starting cold and off is the
    // honest initial state: it is what a unit that nobody has touched reports.
    status: {
      mode: 'off',
      roomTemp: 21 + i * 0.4,
      spHeat: 20,
      spCool: 24,
      fanSpeed: 'auto',
      vaneDir: 'auto',
      filterDirty: false,
      defrost: false,
      standby: false,
      // The client only spends a request on the sensor leaves when the unit says
      // a paired sensor is driving the reading, so --humidity has to declare it
      // here too; a unit on its own thermistor reports 'unset'.
      tempSource: HUMIDITY ? 'sensor0' : 'unset',
      activeThermistor: HUMIDITY ? 'sensor0' : 'unset',
    },
  };
});

// ---- physics --------------------------------------------------------------

// Just enough for the room temperature to move in the direction the mode implies,
// so a setpoint change is visible in the Home app instead of a frozen number.
// Not a thermal model and not trying to be one.
const round1 = (n) => Math.round(n * 10) / 10;

function tick(u) {
  const s = u.status;
  const target = s.mode === 'heat' ? s.spHeat
    : s.mode === 'cool' || s.mode === 'dry' ? s.spCool
      : s.mode === 'auto' ? (s.roomTemp < s.spHeat ? s.spHeat : s.roomTemp > s.spCool ? s.spCool : s.roomTemp)
        : null;
  if (target === null || s.mode === 'vent') {
    s.standby = false;
    return;
  }
  const gap = target - s.roomTemp;
  s.standby = Math.abs(gap) <= 0.3;
  if (!s.standby) {
    s.roomTemp = round1(s.roomTemp + Math.sign(gap) * 0.1);
  }
}

setInterval(() => units.forEach(tick), 2000).unref?.();

// ---- protocol -------------------------------------------------------------

const reply = (res, payload, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const apiError = (res, code) => reply(res, { _api_error: code });

/** Answer one signed request for one unit. */
function handle(u, req, res, rawBody) {
  const url = new URL(req.url ?? '/', 'http://sim');
  const token = url.searchParams.get('m') ?? '';

  if (u.fault === 'authfail') {
    return apiError(res, 'device_authentication_error');
  }
  if (u.fault === 'busy') {
    return apiError(res, '__no_memory');
  }

  // The token covers the body, so it has to be recomputed against the bytes that
  // actually arrived — this is what makes the simulator useful for discovery:
  // probing unit B with unit A's credentials must fail exactly the way real
  // hardware fails it, or the sweep's identity matching proves nothing.
  const expected = computeLocalToken(u.password, u.cryptoSerial, rawBody);
  if (token !== expected) {
    log(u, 'rejected a token that does not match this unit');
    return apiError(res, 'device_authentication_error');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return apiError(res, 'serializer_error');
  }
  const c = parsed?.c ?? {};

  if (c.indoorUnit?.status) {
    const write = c.indoorUnit.status;
    const applied = Object.keys(write);
    for (const [k, v] of Object.entries(write)) {
      // A real adapter answers 200 and silently ignores a field it does not
      // know, so the simulator does too rather than validating.
      u.status[k] = v;
    }
    if (applied.length > 0) {
      log(u, `applied ${JSON.stringify(write)}`);
    }
    return reply(res, { r: { indoorUnit: { status: { ...u.status } } } });
  }

  if (c.sensors) {
    const slot = Object.keys(c.sensors)[0];
    // Slot 0 carries the sensor when one is configured; every other slot is
    // empty, which is how the client learns the list has ended.
    if (HUMIDITY && slot === '0') {
      return reply(res, {
        r: { sensors: { 0: { uuid: `sim-sensor-${u.index}`, humidity: 44 + u.index, temperature: u.status.roomTemp } } },
      });
    }
    return reply(res, { r: { sensors: {} } });
  }

  if (c.mhk2) {
    return reply(res, { r: { mhk2: { status: {} } } });
  }

  return apiError(res, 'serializer_error');
}

const log = (u, msg) => console.log(`  [${u.serial} :${u.port}] ${msg}`);

/**
 * Start one unit's listener, resolving only once the port is actually bound.
 *
 * `server.listen()` is asynchronous, so an earlier version printed the whole
 * "listening on ..." banner and the config block before any bind had been
 * confirmed, then died later on an unhandled 'error' event. That is worse than a
 * plain crash: on a host where one of the ports was already taken, the banner
 * said three units were up while only two were, and the reads against the dead
 * ports came back as transport failures that looked like a platform difference in
 * the plugin. A tool used to verify behaviour has to fail loudly or not at all.
 */
function serve(u) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      if (u.fault === 'mute') {
        return; // hold the socket open and never answer
      }
      if (STRICT && u.inFlight) {
        log(u, 'two requests at once — a real adapter would drop one');
        return apiError(res, 'serializer_error');
      }
      u.inFlight = true;

      const delay = u.fault.startsWith('slow:') ? Number(u.fault.slice(5)) || 0 : 0;
      setTimeout(() => {
        try {
          handle(u, req, res, rawBody);
        } finally {
          u.inFlight = false;
        }
      }, delay);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(u.port, BIND, () => {
      // Past the bind: a later error must not take the process down with a stack
      // trace, but it must still be visible.
      server.removeListener('error', reject);
      server.on('error', (err) => log(u, `server error: ${err.message}`));
      resolve(server);
    });
  });
}

// ---- start ----------------------------------------------------------------

const platformBlock = {
  platform: 'KumoV3',
  name: 'Kumo simulator',
  localOnly: true,
  localControl: true,
  localPollInterval: 15,
  debug: true,
  localDevices: units.map((u) => ({
    deviceSerial: u.serial,
    name: u.name,
    ip: `${BIND === '0.0.0.0' ? '<this machine\u2019s LAN address>' : BIND}:${u.port}`,
    password: u.password,
    cryptoSerial: u.cryptoSerial,
    hasModeHeat: true,
    hasModeDry: true,
    hasModeVent: true,
    usesSetPointInDryMode: true,
  })),
};

if (has('config-only')) {
  // Nothing is bound in this mode: the caller wants the block, not the servers.
  console.log(JSON.stringify(platformBlock, null, 2));
  process.exit(0);
}

try {
  await Promise.all(units.map(serve));
} catch (err) {
  const taken = err?.port ?? '?';
  console.error(
    `Cannot listen on ${BIND}:${taken} — ${err?.code ?? err?.message}.\n`
    + `  Ports ${BASE_PORT}..${BASE_PORT + UNITS - 1} must all be free; something already holds one of them.\n`
    + `  Pick another range with --port, e.g. --port ${BASE_PORT + 1000}.`,
  );
  process.exit(1);
}

console.log(`\n${units.length} simulated unit(s) listening on ${BIND}:${BASE_PORT}-${BASE_PORT + units.length - 1}`);
for (const u of units) {
  console.log(`  ${u.serial}  ${BIND}:${u.port}${u.fault ? `  [fault: ${u.fault}]` : ''}`);
}
if (BIND === '0.0.0.0') {
  console.log('\n  Bound to every interface: these fake units are reachable from the whole LAN.');
}
console.log('\nPaste into config.json as its own platform block (give it a distinct _bridge to');
console.log('keep it away from the real units):\n');
console.log(JSON.stringify(platformBlock, null, 2));
console.log('\nRequests will be logged below. Ctrl-C to stop.\n');
