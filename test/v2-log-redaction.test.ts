// A v2 login reply must never reach a log line, a cache file, or an accessory
// context — at any log level, `debug: true` included.
//
// This is not a stylistic rule. One reply carries, in clear text: every unit's local
// adapter `password` and `cryptoSerial` (the two values that authenticate a command
// to the hardware), a session token, and the account holder's name, phone number,
// email address and every site's full postal address. The plugin already logs API
// payloads verbatim in debug mode in several places — `RAW Zone JSON`, request and
// error BODIES inside makeAuthenticatedRequest, `Zone adapter data` — and it needed an
// explicit strip of one field to keep `adapter_update` safe. Any of those patterns
// applied to a v2 reply would empty the lot into homebridge.log.
//
// Note the rule is "never hand a v2 object to a log call", not "never stringify one":
// the Homebridge logger util.inspects its extra arguments, so `log.debug('x', obj)`
// leaks just as thoroughly as JSON.stringify does.
//
// The test is written to fail LOUDLY rather than vacuously: it first proves each
// sentinel really is in the payload, so a renamed field cannot make it pass by
// finding nothing.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoV3Platform } from '../dist/platform.js';
import { parseV2Login } from '../dist/kumo-v2.js';
import type { DeviceProfileCallback, DeviceUpdateCallback } from '../dist/kumo-api.js';
import type { LocalDeviceCreds, SerialCreds } from '../dist/local-api.js';
import type { Commands, DeviceProfile, DeviceStatus } from '../dist/settings.js';
import { Characteristic, Service, makeAccessory } from './helpers';
import type { FakeAccessory, FakeService } from './helpers';
import { SENTINELS, makeV2Reply, sentinelValues } from './v2-fixture';

class FakePlatformAccessory {
  private readonly fake: FakeAccessory;
  readonly context: FakeAccessory['context'];
  constructor(public displayName: string, public UUID: string) {
    this.fake = makeAccessory(displayName, 'PLACEHOLDER');
    this.context = this.fake.context;
  }

  getService(type: string) {
    return this.fake.getService(type);
  }

  getServiceById(type: string, subtype: string) {
    return this.fake.getServiceById(type, subtype);
  }

  addService(type: string, name?: string, subtype?: string) {
    return this.fake.addService(type, name, subtype);
  }

  removeService(svc: FakeService) {
    this.fake.removeService(svc);
  }
}

/** Records every line at every level, the way util.inspect would render it. */
function makeRecordingLog() {
  const lines: string[] = [];
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`[${level}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return {
    lines,
    log: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') },
  };
}

/**
 * A platform in `cloudRegion: 'ca'` with `debug: true`, the REAL v2 client (so its
 * own logging is under test too), and a stubbed global fetch answering the fixture.
 *
 * Only the two things that would put real traffic on the wire are stubbed out: the
 * LAN client and the /24 sweep.
 */
async function runDiscovery(answer: { status?: number; body?: unknown; text?: string }) {
  const { lines, log } = makeRecordingLog();
  const registeredAccessories: FakePlatformAccessory[] = [];
  const api = {
    hap: { Service, Characteristic, uuid: { generate: (s: string) => `uuid-${s}` } },
    platformAccessory: FakePlatformAccessory,
    on: () => {},
    registerPlatformAccessories: (_p: string, _n: string, list: FakePlatformAccessory[]) => {
      registeredAccessories.push(...list);
    },
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };

  const config = {
    name: 'test',
    platform: 'KumoV3',
    username: SENTINELS.email,
    password: 'the-account-password',
    cloudRegion: 'ca',
    // The setting whose whole purpose is to log more. The rule has to hold here.
    debug: true,
  } as unknown as PlatformConfig;

  const platform = new KumoV3Platform(log as never, config, api as never);

  const profileCbs: DeviceProfileCallback[] = [];
  (platform as unknown as { kumoAPI: unknown }).kumoAPI = {
    subscribeToDevice: (_s: string, _cb: DeviceUpdateCallback) => {},
    unsubscribeFromDevice: () => {},
    onDeviceProfileUpdate: (cb: DeviceProfileCallback) => profileCbs.push(cb),
    emitDeviceProfile: (serial: string, profile: DeviceProfile) => {
      for (const cb of profileCbs) {
        cb(serial, profile);
      }
    },
    async sendCommand() {
      return true;
    },
    destroy: () => {},
  };

  const creds = new Map<string, LocalDeviceCreds>();
  platform.localClient = {
    setCreds: (serial: string, c: LocalDeviceCreds) => creds.set(serial, c),
    clearCreds: (serial: string) => creds.delete(serial),
    hasLocal: (serial: string) => creds.has(serial),
    getIp: (serial: string) => creds.get(serial)?.ip,
    async getStatus(): Promise<Partial<DeviceStatus> | null> {
      return { roomTemp: 22, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20 };
    },
    async sendCommand(_serial: string, _commands: Commands) {
      return true;
    },
  } as never;
  platform['admitLocalDevices'] = async (_c: Map<string, SerialCreds>) => {};
  platform['startLocalPolling'] = () => {};

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (answer.text !== undefined ? JSON.parse(answer.text) : answer.body),
      text: async () => answer.text ?? JSON.stringify(answer.body),
    };
  }) as never;
  try {
    await platform.discoverDevices();
  } finally {
    globalThis.fetch = realFetch;
    platform['cleanup']();
  }

  return { lines, platform, accessories: registeredAccessories };
}

test('the fixture really does contain every sentinel (anti-vacuity)', () => {
  // Without this, renaming a field in the fixture would make every assertion below
  // pass by searching for something that is no longer there.
  const payload = JSON.stringify(makeV2Reply());
  for (const value of sentinelValues()) {
    assert.ok(payload.includes(value), `the payload carries ${value}`);
  }
  // And the parser really does pick the secrets up, so "no secret was logged" is a
  // statement about logging rather than about a parse that quietly failed.
  const inventory = parseV2Login(makeV2Reply());
  assert.strictEqual(inventory.creds.size, 2);
});

test('not one secret or personal detail is logged, with debug ON', async () => {
  const { lines } = await runDiscovery({ body: makeV2Reply() });

  assert.ok(lines.length > 5, 'the run really did log (otherwise this proves nothing)');
  for (const value of sentinelValues()) {
    const offenders = lines.filter((line) => line.includes(value));
    assert.deepStrictEqual(offenders, [], `${value} must not appear in any log line`);
  }
  // The account password is not a fixture value, so it is checked on its own.
  assert.deepStrictEqual(lines.filter((l) => l.includes('the-account-password')), [],
    'nor the account password that was posted');
});

test('what IS logged is the derived summary: host, counts, serials, room names', async () => {
  const { lines } = await runDiscovery({ body: makeV2Reply() });
  const summary = lines.filter((l) => /signed in to/.test(l));
  assert.strictEqual(summary.length, 1);
  assert.match(summary[0], /mesca-prod\.kumocloud\.com/, 'the host is safe and useful');
  assert.match(summary[0], /3 unit\(s\)/);
  assert.match(summary[0], /2 with local secrets/);
});

test('the secrets are not persisted into the accessory cache either', async () => {
  // accessory.context is written to accessories/cachedAccessories.<username> on
  // disk, so a secret parked there would outlive the config change that removed it —
  // and it is a natural place to want to keep one.
  const { accessories } = await runDiscovery({ body: makeV2Reply() });
  assert.ok(accessories.length > 0, 'accessories were registered');
  for (const accessory of accessories) {
    const context = JSON.stringify(accessory.context);
    for (const value of sentinelValues()) {
      assert.ok(!context.includes(value), `${value} must not be cached on disk`);
    }
  }
});

test('a rejected sign-in logs the status and the host, and not the error body', async () => {
  // A v2 error body can echo the account address back, so it is never read at all.
  //
  // The sentinel scan runs over EVERY recorded line, at every level, and NOT over
  // the single `[error]` line this test used to isolate. That narrowing made the
  // test blind to the most plausible mutation there is on this path: one
  // `log.debug(`V2 error body: ${await response.text()}`)` added while chasing a 401
  // — the first reflex when debugging one — empties the account's email address and
  // a session token into homebridge.log, and the suite stayed green through it.
  // Anything the failure path decides to log has to be sentinel-free, not just the
  // line the assertions below happen to name.
  const { lines } = await runDiscovery({
    status: 401,
    text: JSON.stringify({ error: `no such account: ${SENTINELS.email}`, token: SENTINELS.token }),
  });

  const errors = lines.filter((l) => l.startsWith('[error]'));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /401/);
  assert.match(errors[0], /mesca-prod\.kumocloud\.com/);
  for (const value of sentinelValues()) {
    assert.deepStrictEqual(lines.filter((line) => line.includes(value)), [],
      `${value} must not reach ANY line on the failure path`);
  }
  // The credentials that were POSTed are not a fixture value, so they are named.
  assert.deepStrictEqual(lines.filter((l) => l.includes('the-account-password')), [],
    'nor the account password that was posted');
});
