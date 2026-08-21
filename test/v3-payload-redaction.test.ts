// No vendor payload may carry a per-device secret into homebridge.log — the v3 cloud
// included, and with `debug: true` on.
//
// test/v2-log-redaction.test.ts makes this claim for the v2 sign-in, whose reply is
// known to hold both LAN secrets. The v3 side had no such test, and it is the side
// that dumps whole payloads: `RAW Zone JSON` (info level as soon as debug is on), the
// stream and adapter-update details, the request body, the error body — which is NOT
// debug-gated for a 400 — and the accessory's `Zone adapter data`. The only protection
// any of them ever had was one destructured field name in the `adapter_update`
// handler (`const { password, ...safeData } = data`).
//
// A one-field deny-list cannot hold a line whose SHAPE belongs to the vendor. The
// cloud has already served `cryptoSerial` from `/devices/{serial}/status`, so "it is
// not in this payload today" was never a property of this code — and the configuration
// this plugin now recommends for a US account (`localCredentialSource: 'v2'`) keeps v3
// streaming and zone polling running, which is exactly where these lines live.
//
// So the rule under test is by FIELD NAME, applied at every site that stringifies a
// cloud object: whatever the vendor decides to put in `adapter_update` or in a zone
// tomorrow, a field called `cryptoSerial`/`password`/`token` is masked. Each test
// below scans EVERY recorded line at EVERY level, never a line it picked out first.

import test from 'node:test';
import assert from 'node:assert';

// `import ... = require`: see cloud-failure-paths.test.ts. A namespace import of
// socket.io-client under esModuleInterop is a copy, so patching it would leave
// kumo-api.js dialling the real socket endpoint.
import sioc = require('socket.io-client');

import { KumoAPI, redactBodyText, redactPayload } from '../dist/kumo-api.js';
import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

/**
 * The values that must never be printed. Each is unmistakable, so an assertion
 * cannot pass by looking for something that is not in the payload at all.
 */
const SECRET = {
  password: 'SENTINELADAPTERPASSWORD00000000000000==',
  cryptoSerial: 'dec0dedec0dedec0de',
  token: 'SENTINELSESSIONTOKEN000000000000',
  refresh: 'SENTINELREFRESHTOKEN000000000000',
  mac: '8c:8b:5b:7b:18:48',
};

function secretValues(): string[] {
  return Object.values(SECRET);
}

/** Records every line at every level, the way util.inspect would render it. */
function makeRecordingLog(): { lines: string[]; log: Record<string, (...a: unknown[]) => void> } {
  const lines: string[] = [];
  const push = (level: string) => (...args: unknown[]) => {
    lines.push(`[${level}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return {
    lines,
    log: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') },
  };
}

/**
 * Assert that nothing in `lines` quotes a secret, and that the run logged at all.
 *
 * The second half is what keeps these tests from passing vacuously: a site that stops
 * logging entirely, or a harness that never reaches it, would otherwise look like a
 * clean redaction.
 */
function assertNoSecrets(lines: string[], mustMention: RegExp): void {
  assert.ok(lines.some((l) => mustMention.test(l)),
    `the site under test really did log (looking for ${mustMention})`);
  for (const value of secretValues()) {
    assert.deepStrictEqual(lines.filter((l) => l.includes(value)), [],
      `${value} must not appear in any log line`);
  }
}

// ---- the walk itself -----------------------------------------------------

test('every known secret field name is masked, whatever its casing or nesting', () => {
  const redacted = JSON.stringify(redactPayload({
    deviceSerial: SERIAL,
    password: SECRET.password,
    crypto_serial: SECRET.cryptoSerial,
    CryptoSerial: SECRET.cryptoSerial,
    token: { access: SECRET.token, refresh: SECRET.refresh },
    accessToken: SECRET.token,
    refreshToken: SECRET.refresh,
    idToken: SECRET.token,
    apiKey: SECRET.token,
    authorization: `Bearer ${SECRET.token}`,
    secret: SECRET.token,
    mac: SECRET.mac,
    adapter: { nested: { deeper: { password: SECRET.password } } },
    units: [{ password: SECRET.password }, { cryptoSerial: SECRET.cryptoSerial }],
  }));

  for (const value of secretValues()) {
    assert.ok(!redacted.includes(value), `${value} is masked`);
  }
  assert.match(redacted, /\[redacted\]/, 'and the field is marked rather than dropped');
});

test('the diagnostic fields these lines exist for survive untouched', () => {
  // A redactor that blanked the payload would be indistinguishable from deleting the
  // log line, which is the failure mode of an allow-list: the lines are what a user is
  // asked for when the plugin stops working.
  const zone = {
    name: 'Living room',
    adapter: {
      deviceSerial: SERIAL, roomTemp: 21.5, spHeat: 20, spCool: 22.5, spAuto: null,
      operationMode: 'autoCool', power: 1, connected: true, rssi: -37,
      humidity: null, fanSpeed: 'auto', displayConfig: { filter: false, standby: true },
    },
  };
  assert.deepStrictEqual(redactPayload(zone), zone);
});

test('a malformed payload cannot spin the walk', () => {
  const cyclic: Record<string, unknown> = { deviceSerial: SERIAL };
  cyclic.self = cyclic;
  assert.match(JSON.stringify(redactPayload(cyclic)), /\[circular\]/);

  // 12 levels against a cap of 8.
  let deep: Record<string, unknown> = { password: SECRET.password };
  for (let i = 0; i < 12; i++) {
    deep = { level: deep };
  }
  const walked = JSON.stringify(redactPayload(deep));
  assert.match(walked, /\[deep\]/);
  assert.ok(!walked.includes(SECRET.password), 'and the cap does not let a secret out');

  // Primitives and null pass through, so a caller never has to pre-check.
  for (const value of [null, undefined, 0, '', 'text', false]) {
    assert.strictEqual(redactPayload(value), value);
  }
});

test('a text body is redacted when it is JSON and left alone when it is not', () => {
  const body = redactBodyText(JSON.stringify({ cryptoSerial: SECRET.cryptoSerial }));
  assert.ok(!body.includes(SECRET.cryptoSerial));
  // The 400-validation message is the single most useful line in the log and is not
  // JSON at all; mangling it would trade a real diagnostic for a theoretical leak.
  assert.strictEqual(redactBodyText('modeRequiredWhenDeviceOff'), 'modeRequiredWhenDeviceOff');
  assert.strictEqual(redactBodyText(''), '');
  assert.strictEqual(redactBodyText('"just a string"'), '"just a string"');
});

// ---- wiring: the v3 REST paths ------------------------------------------

/** A KumoAPI with debug on, a live token, and `fetch` answering `reply`. */
function debugApi(reply: (url: string) => { status?: number; body?: unknown; text?: string }) {
  const { lines, log } = makeRecordingLog();
  const api = new KumoAPI('user@example.com', 'secret', log as never, true);
  // Seeded so nothing on these paths tries to authenticate.
  api['accessToken'] = 'test-token';
  api['tokenExpiresAt'] = Date.now() + 3600000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const answer = reply(String(input));
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (answer.text !== undefined ? JSON.parse(answer.text) : answer.body),
      text: async () => answer.text ?? JSON.stringify(answer.body),
    };
  }) as never;
  return {
    api,
    lines,
    restore: () => {
      globalThis.fetch = realFetch;
      api.destroy();
    },
  };
}

test('RAW Zone JSON prints the zone without its secrets', async () => {
  // The loudest site: info level, one whole zone per unit, every poll, as soon as
  // `debug: true` is set. `cryptoSerial` sitting on an adapter is not hypothetical —
  // the cloud serves that exact field from /devices/{serial}/status.
  const { api, lines, restore } = debugApi(() => ({
    body: [{
      id: 'zone-1',
      name: 'Living room',
      isActive: true,
      adapter: {
        deviceSerial: SERIAL, roomTemp: 21.5, spHeat: 20, spCool: 22.5, spAuto: null,
        operationMode: 'cool', power: 1, connected: true, rssi: -37, humidity: null,
        password: SECRET.password,
        cryptoSerial: SECRET.cryptoSerial,
        mac: SECRET.mac,
      },
    }],
  }));
  try {
    const zones = await api.getZones('site-1');

    assert.strictEqual(zones.length, 1, 'the payload still reaches the caller intact');
    assertNoSecrets(lines, /RAW Zone JSON/);
    assert.ok(lines.some((l) => l.includes('21.5')), 'and the useful values are still printed');
  } finally {
    restore();
  }
});

test('a failed zone fetch redacts the error body', async () => {
  const { api, lines, restore } = debugApi(() => ({
    status: 500,
    text: JSON.stringify({ error: 'boom', cryptoSerial: SECRET.cryptoSerial, token: SECRET.token }),
  }));
  try {
    assert.deepStrictEqual(await api.getZones('site-1'), []);
    assertNoSecrets(lines, /Failed to fetch zones/);
  } finally {
    restore();
  }
});

test('the request body and the error body of an authenticated request are both redacted', async () => {
  // The error branch is NOT debug-gated for a 400 (that is deliberate: the validation
  // message is the most useful line the plugin ever logs), so the field-name walk is
  // the only thing standing between it and homebridge.log.
  const { api, lines, restore } = debugApi(() => ({
    status: 400,
    text: JSON.stringify({ message: 'invalidSpHeatRange', cryptoSerial: SECRET.cryptoSerial }),
  }));
  try {
    const sent = await api['makeAuthenticatedRequest']('/devices/send-command', 'POST', {
      deviceSerial: SERIAL,
      commands: { spHeat: 99 },
      // Not a field the v3 API is asked for today. It is here because the logged body
      // is whatever a caller passes, and the site is generic.
      token: SECRET.token,
    });

    assert.strictEqual(sent, null);
    assertNoSecrets(lines, /Error response/);
    assert.ok(lines.some((l) => l.includes('invalidSpHeatRange')),
      'the validation message itself must survive — it is why the line is not debug-gated');
    assert.ok(lines.some((l) => /Body:/.test(l)), 'and the request body was logged too');
  } finally {
    restore();
  }
});

test('a failed login and a failed token refresh do not print their bodies verbatim', async () => {
  // These two bodies come from the authentication endpoints, which are the likeliest
  // of all to echo an account identifier or a token back. `Login error response` was
  // debug-gated and nothing more, and `Token refresh failed` was not even that.
  const { api, lines, restore } = debugApi(() => ({
    status: 403,
    text: JSON.stringify({ error: 'nope', token: SECRET.token, refresh: SECRET.refresh }),
  }));
  try {
    // One call reaches both: a refresh that fails for anything but a 429 falls through
    // to a full login, which fails the same way. Calling login() again here would only
    // buy a 10s wait from the minLoginInterval rate-limit guard.
    api['refreshToken'] = 'stale-refresh-token';
    assert.strictEqual(await api['refreshAccessToken'](), false);

    assertNoSecrets(lines, /Token refresh failed/);
    assert.ok(lines.some((l) => /Login error response/.test(l)), 'the login body line ran too');
  } finally {
    restore();
  }
});

// ---- wiring: the streaming events ---------------------------------------

type SocketHandler = (data?: unknown) => void;

interface FakeSocket {
  connected: boolean;
  id: string;
  on(event: string, fn: SocketHandler): FakeSocket;
  once(event: string, fn: SocketHandler): FakeSocket;
  emit(): FakeSocket;
  disconnect(): FakeSocket;
  removeAllListeners(): FakeSocket;
  fire(event: string, data?: unknown): void;
}

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, SocketHandler[]>();
  const socket: FakeSocket = {
    connected: false,
    id: 'fake-socket',
    on(event: string, fn: SocketHandler) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(fn);
      return socket;
    },
    once(event: string, fn: SocketHandler) {
      return socket.on(event, fn);
    },
    emit() {
      return socket;
    },
    disconnect() {
      socket.connected = false;
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    fire(event: string, data?: unknown) {
      for (const fn of handlers.get(event) || []) {
        fn(data);
      }
    },
  };
  return socket;
}

/** A streaming KumoAPI, debug on, wired to a socket that never connects. */
async function debugStreamingApi(): Promise<{
  api: KumoAPI; socket: FakeSocket; lines: string[]; restore: () => void;
}> {
  const socket = makeFakeSocket();
  const realIo = sioc.io;
  sioc.io = (() => socket) as never;
  const { lines, log } = makeRecordingLog();
  const api = new KumoAPI('user@example.com', 'secret', log as never, true);
  api['accessToken'] = 'test-token';
  const started = api.startStreaming([SERIAL]);
  // Settles startStreaming's promise; the listeners are registered before it awaits.
  socket.fire('connect_error', new Error('listeners only'));
  await started;
  return {
    api,
    socket,
    lines,
    restore: () => {
      api.destroy();
      sioc.io = realIo;
    },
  };
}

test('the adapter_update detail line survives a payload with more than one secret in it', async () => {
  // The site whose old protection was one destructured field name. `password` was
  // covered; `cryptoSerial`, `token` and `mac` in the same event were not — and the
  // shape of this event is the vendor's to change.
  const { api, socket, lines, restore } = await debugStreamingApi();
  try {
    socket.fire('adapter_update', {
      deviceSerial: SERIAL,
      firmwareVersion: '02.02.00',
      routerRssi: -48,
      password: SECRET.password,
      cryptoSerial: SECRET.cryptoSerial,
      token: SECRET.token,
      mac: SECRET.mac,
    });

    assertNoSecrets(lines, /Adapter update detail/);
    assert.ok(lines.some((l) => l.includes('02.02.00')), 'the firmware version is still reported');
    // The capture path is untouched by the redaction: it reads the event, not the log.
    assert.strictEqual(api.getAdapterPassword(SERIAL), SECRET.password);
  } finally {
    restore();
  }
});

test('the device_update detail line is redacted too', async () => {
  const { socket, lines, restore } = await debugStreamingApi();
  try {
    socket.fire('device_update', {
      deviceSerial: SERIAL,
      roomTemp: 21.5,
      operationMode: 'cool',
      power: 1,
      cryptoSerial: SECRET.cryptoSerial,
      password: SECRET.password,
    });

    assertNoSecrets(lines, /Stream update detail/);
  } finally {
    restore();
  }
});

// ---- wiring: the accessory ----------------------------------------------

test('the accessory prints a rejected zone without its secrets', async () => {
  // Reached when `roomTemp` is missing, which is what a half-populated payload looks
  // like — so the one zone dump that fires on a MALFORMED payload is also the one most
  // likely to carry fields nobody expected.
  const { lines, log } = makeRecordingLog();
  const platform = {
    Service,
    Characteristic,
    log,
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    unsubscribeFromDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(_serial: string, _commands: Commands) {
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never, makeAccessory() as never, kumoAPI as never, 30,
  );
  try {
    handler.updateFromZone({
      id: 'zone-1',
      adapter: {
        deviceSerial: SERIAL,
        roomTemp: undefined,
        power: 1, operationMode: 'cool', spCool: 22, spHeat: 20, spAuto: null,
        fanSpeed: null, airDirection: null, humidity: null, rssi: -37,
        password: SECRET.password,
        cryptoSerial: SECRET.cryptoSerial,
      } as unknown as Adapter,
    } as unknown as Zone);

    assertNoSecrets(lines, /Zone adapter data/);
  } finally {
    handler.destroy();
  }
});
