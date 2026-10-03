#!/usr/bin/env node
// A read-ONLY probe for a Kumo LAN adapter: asks your own unit what it reports,
// and prints the raw reply before this plugin's mapping throws anything away.
//
// WHY IT EXISTS
//   `mapLocalStatus` keeps the dozen fields the plugin uses and discards the rest,
//   so the only way to see what a given unit actually declares is to look at the
//   tree it sends back. That is how the undocumented fields in docs/protocol.md
//   were found, and how the next ones will be.
//
// WHAT "READ-ONLY" MEANS HERE, STRUCTURALLY
//   A read in this protocol is a body of nested EMPTY objects, which the adapter
//   fills in: `{"c":{"indoorUnit":{"status":{}}}}` comes back as the whole status
//   under `"r"`. This tool can only build that shape — `body()` puts `{}` at the
//   leaf and there is no code path that puts a value there. It cannot write even
//   if asked to, which matters because some writes on this adapter DO change real
//   state: `tempSource`, `roomTempOffset`, and `runState: "reboot"`.
//
// WHAT IT CANNOT TELL YOU
//   Whether a field is WRITABLE, or what writing it would do. The adapter answers
//   HTTP 200 and silently ignores values it does not recognise, so a write probe
//   cannot distinguish "accepted" from "ignored" without a second read — and for
//   the fields above, finding out costs you a changed unit. Read first, decide
//   later, deliberately.
//
// IT IS GENTLE ON PURPOSE
//   One request at a time, a fresh connection each time, and a pause between them
//   (default 1s). These adapters hold roughly one connection and a very small
//   amount of memory; they degrade under back-to-back traffic (pykumo #79), and
//   this plugin spent weeks learning that the hard way. There is no node scanning
//   and no fuzzing: it asks for the nodes you name, nothing more.
//
// USAGE
//   npm run build                     # this tool imports dist/local-api.js
//   node tools/kumo-probe.mjs --creds-file unit.json
//
//   unit.json is one entry of the `localDevices` block that `exportLocalSecrets`
//   prints — `{"ip": "...", "password": "...", "cryptoSerial": "..."}` — so the
//   copy you keep in a password manager feeds this directly. Extra keys are fine
//   and ignored.
//
//   Credentials can also come from KUMO_IP / KUMO_PASSWORD / KUMO_CRYPTO_SERIAL.
//   Passing them as flags works too, and warns: command lines land in shell
//   history and in the process list.
//
// OPTIONS
//   --creds-file PATH   JSON with ip / password / cryptoSerial
//   --ip HOST[:PORT]    the adapter's LAN address (warns; prefer the file)
//   --password B64      the adapter's local password (warns)
//   --cryptoSerial HEX  the adapter's crypto serial (warns)
//   --node PATH         a node to read, dot-separated, repeatable. `.` is the root,
//                       `{"c":{}}` — a parent asked empty may enumerate its children,
//                       which beats guessing names. Bracket a run of unknown nodes
//                       with one that works (indoorUnit.status first and last) and the
//                       summary will say whether the adapter stayed healthy throughout.
//                       A node this
//                       adapter does not have answers `serializer_error`, the same
//                       code it uses for "busy" — see the note at that message.
//                       Default: the
//                       five nodes this plugin knows — indoorUnit.status,
//                       indoorUnit.profile, adapter.status, sensors.0, mhk2.status
//   --pause MS          between requests (default 1000, floor 250)
//   --timeout MS        per request (default 6000, the plugin's own)
//
// WHAT COMES BACK MAY IDENTIFY YOU
//   Replies carry the unit's serial, its MAC and your wifi SSID. Review the output
//   before pasting it anywhere public. Credentials are never printed by this tool.

import http from 'node:http';
import { readFileSync } from 'node:fs';

// The token must be computed the way the plugin computes it — borrowed, not
// restated, so a probe that authenticates proves the plugin's credentials and
// algorithm work against this unit. Same two locations as the simulator: a repo
// checkout, or beside an installed plugin on a Homebridge host.
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
const flags = (name) => argv.reduce(
  (out, a, i) => (a === `--${name}` && argv[i + 1] ? [...out, argv[i + 1]] : out), [],
);

const DEFAULT_NODES = [
  'indoorUnit.status',   // the one the plugin polls; mapLocalStatus keeps ~12 of its fields
  'indoorUnit.profile',  // capabilities as the UNIT states them, next to the cloud's profile
  'adapter.status',      // the wifi module itself — firmware, signal, runState
  'sensors.0',           // a paired wireless sensor, if slot 0 holds one
  'mhk2.status',         // an MHK2 wall thermostat, if there is one
];

const creds = { ip: undefined, password: undefined, cryptoSerial: undefined };
const credsFile = flag('creds-file');
if (credsFile) {
  try {
    const parsed = JSON.parse(readFileSync(credsFile, 'utf8'));
    // Accept a bare object or a one-element array, so either shape of the
    // exportLocalSecrets block can be pasted into the file unedited.
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    creds.ip = entry?.ip;
    creds.password = entry?.password;
    creds.cryptoSerial = entry?.cryptoSerial;
  } catch (err) {
    console.error(`Cannot read ${credsFile}: ${err.message}`);
    process.exit(1);
  }
}
for (const [key, env] of [['ip', 'KUMO_IP'], ['password', 'KUMO_PASSWORD'], ['cryptoSerial', 'KUMO_CRYPTO_SERIAL']]) {
  creds[key] ??= process.env[env];
}
let fromFlags = false;
for (const key of ['ip', 'password', 'cryptoSerial']) {
  const v = flag(key);
  if (v !== undefined) {
    creds[key] = v;
    fromFlags = key !== 'ip' || fromFlags; // an address is not a secret
  }
}
if (fromFlags) {
  console.warn(
    'Warning: secrets passed on the command line are in your shell history and visible\n'
    + '         in the process list. --creds-file or the KUMO_* environment variables avoid both.\n',
  );
}

const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(
    `Missing: ${missing.join(', ')}.\n\n`
    + 'Give one entry of the localDevices block that exportLocalSecrets printed:\n'
    + '  node tools/kumo-probe.mjs --creds-file unit.json\n',
  );
  process.exit(1);
}

const nodes = flags('node').length > 0 ? flags('node') : DEFAULT_NODES;
const pauseMs = Math.max(250, Number(flag('pause', 1000)) || 1000);
const timeoutMs = Number(flag('timeout', 6000)) || 6000;

// ---- the read ------------------------------------------------------------

/**
 * A read body for `path`: nested objects ending in `{}`.
 *
 * The leaf is a literal empty object and takes no argument. That is the whole
 * read-only guarantee — there is nowhere to pass a value.
 */
function body(path) {
  // `.` is the root: `{"c":{}}`, asking the adapter to fill in everything it has.
  // A read is an empty leaf the adapter completes, so a PARENT asked empty may
  // enumerate its children — which beats guessing node names. Worth trying at
  // every level: `.`, then `adapter`, then `adapter.status`.
  let leaf = {};
  if (path !== '.') {
    for (const key of path.split('.').reverse()) {
      leaf = { [key]: leaf };
    }
  }
  return Buffer.from(JSON.stringify({ c: leaf }), 'utf8');
}

/** One signed PUT, on its own connection, never reused. */
function read(path) {
  const payload = body(path);
  const token = computeLocalToken(creds.password, creds.cryptoSerial, payload);
  return new Promise((resolve) => {
    const req = http.request(
      `http://${creds.ip}/api?m=${token}`,
      {
        method: 'PUT',
        // keep-alive off, one socket: a parked connection occupies a slot on an
        // adapter that has very few. Same discipline as the plugin's LOCAL_AGENT.
        agent: new http.Agent({ keepAlive: false, maxSockets: 1 }),
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          // Nothing here can inflate a compressed reply, so do not advertise it.
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 64 * 1024) {
            req.destroy(new Error('reply exceeded 64KB'));
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', (err) => resolve({ error: err.message }));
    req.end(payload);
  });
}

// ---- run -----------------------------------------------------------------

console.log(`Probing ${creds.ip} — read-only, ${nodes.length} node(s), ${pauseMs}ms apart.\n`);

let authFailures = 0;
let anySucceeded = false;
/** Per-node outcome, so the run can be summarised and the ambiguity resolved. */
const outcomes = [];
for (const [i, path] of nodes.entries()) {
  if (i > 0) {
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  console.log(`── ${path}`);
  const out = await read(path);

  if (out.error) {
    console.log(`   no answer: ${out.error}`);
    outcomes.push('silent');
    continue;
  }
  if (out.status !== 200) {
    console.log(`   HTTP ${out.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out.text);
  } catch {
    // Discovery means seeing unexpected things; show them rather than hiding them.
    console.log(`   not JSON (${out.text.length} bytes): ${out.text.slice(0, 400)}`);
    outcomes.push('odd');
    continue;
  }
  if (parsed._api_error) {
    const code = String(parsed._api_error);
    console.log(`   adapter said: ${code}`);
    if (code === 'device_authentication_error') {
      authFailures++;
      console.log('   → the token was rejected. Both secrets must belong to the unit at THIS address.');
    } else if (code === '__no_memory') {
      console.log('   → out of memory: resource pressure, not a wrong request. Raise --pause.');
    } else if (code === 'serializer_error') {
      // Two causes, one string — and a probe is exactly where that bites, because
      // exploring means asking for nodes that may not exist. The plugin maps this
      // to "busy" and is right to: it only ever asks for nodes it knows are there.
      // Here it can also mean "no such node". Found while testing this tool against
      // tools/kumo-adapter-sim.mjs, whose fall-through for an unimplemented node is
      // this same code.
      console.log(
        '   → ambiguous: either this adapter has no such node, or it was busy.'
        + (anySucceeded
          ? ' Another node answered in this run, so an absent node is the likelier of the two.'
          : ' Nothing has answered yet this run, so a busy or wedged adapter is likelier — raise --pause and retry.'),
      );
    }
    outcomes.push(code === 'serializer_error' ? 'ambiguous' : 'refused');
    continue;
  }
  if (parsed.r === undefined) {
    console.log(`   answered without an "r" node: ${JSON.stringify(parsed).slice(0, 400)}`);
    outcomes.push('odd');
    continue;
  }
  anySucceeded = true;
  outcomes.push('ok');
  console.log(JSON.stringify(parsed.r, null, 2).split('\n').map((l) => `   ${l}`).join('\n'));
}

const count = (kind) => outcomes.filter((o) => o === kind).length;
console.log(
  `\n${count('ok')}/${nodes.length} answered`
  + (count('ambiguous') > 0 ? `, ${count('ambiguous')} ambiguous (serializer_error)` : '')
  + (count('silent') > 0 ? `, ${count('silent')} silent` : '')
  + (count('refused') > 0 ? `, ${count('refused')} refused` : '')
  + (count('odd') > 0 ? `, ${count('odd')} unexpected` : '') + '.',
);
// The point of bracketing a run with a node known to work: it turns the ambiguity
// into a decision. An adapter that answered both before and after the unknowns was
// not busy in between, so a serializer_error in the middle means the node is absent.
if (nodes.length > 2 && outcomes[0] === 'ok' && outcomes[outcomes.length - 1] === 'ok' && count('ambiguous') > 0) {
  console.log(
    'The first and last reads both answered, so the adapter was healthy throughout —'
    + ' read the ambiguous ones above as nodes this adapter does not have.',
  );
}
console.log(
  'Replies can carry the unit serial, its MAC and your SSID — review before sharing.',
);
if (authFailures === nodes.length) {
  console.log('Every node was rejected: the credentials or the address are wrong for this unit.');
  process.exit(1);
}
