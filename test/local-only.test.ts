// Regression tests for local-only mode (`localOnly: true`).
//
// Why the mode exists: the v3 cloud is not usable for everyone. Canadian accounts
// are served by a separate v2 backend (mesca-prod.kumocloud.com), so POST
// /v3/login answers 500 for them and discovery never starts at all; and since
// about 2026-07-31 the v3 cloud serves neither of the two per-device secrets the
// LAN adapter authenticates with (pykumo issue #78). A user holding both secrets
// can still drive their units over the LAN — but only if the plugin reaches for
// the cloud on NO path whatsoever.
//
// That last clause is the whole point, and it is what these tests are mostly
// about. It is easy to satisfy on the discovery path (nothing there calls the
// cloud) and easy to miss everywhere else: sendDeviceCommand was local-FIRST with
// an unconditional cloud fallback, so the first LAN hiccup — and the adapter
// tolerates about one concurrent connection, so hiccups are routine — turned into
// a real POST /v3/login with credentials that do not exist, a 10s rate-limit sleep
// inside the HomeKit setter, and a cluster of misleading 500s.
//
// Conventions in here:
//   * The KumoAPI stub records login/getSites/getZones/startStreaming rather than
//     omitting them, so a leak is reported by name instead of as a TypeError. The
//     assertion that those recorders stay empty is the point of several tests.
//   * setupLocalOnly honours a pre-assigned localClient, so no test puts HTTP on
//     the wire. Where the platform is driven end to end, startLocalPolling is
//     stubbed out as well — it polls once immediately.
//   * The rejection table for the config (missing secrets, short cryptoSerial, and
//     so on) lives with its siblings in config-validation.test.ts; only the
//     headline "the objective config is accepted" claim is repeated here.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoV3Platform, validatePlatformConfig } from '../dist/platform.js';
import { KumoAPI } from '../dist/kumo-api.js';
import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { DeviceProfileCallback, DeviceUpdateCallback } from '../dist/kumo-api.js';
import type { LocalDeviceCreds, LocalKumoClient } from '../dist/local-api.js';
import type {
  Commands, DeviceProfile, DeviceStatus, KumoConfig, LocalDeviceConfig, Site, Zone,
} from '../dist/settings.js';
import { HAPStatus, HapStatusError } from '@homebridge/hap-nodejs';
import { Characteristic, Service, makeAccessory, makeLog } from './helpers';
import type { FakeAccessory, FakeService } from './helpers';

const SERIAL = '1234A5678901234B';
const SERIAL_B = '1234A5678901235C';

/**
 * The unit from the field report, at the address local control was proven against.
 * 10 bytes of cryptoSerial (the floor is 9); the token algorithm that consumes it
 * is local-api.test.ts's subject, not this file's.
 */
const DEVICE: LocalDeviceConfig = {
  deviceSerial: SERIAL,
  name: 'Salon',
  ip: '192.168.6.11',
  password: 'cGFzc3dvcmQ=',
  cryptoSerial: '0123456789abcdef0123',
  hasModeDry: true,
  hasModeVent: true,
};

const DEVICE_B: LocalDeviceConfig = {
  deviceSerial: SERIAL_B,
  name: 'Chambre',
  ip: '192.168.6.12',
  password: 'cGFzc3dvcmQy',
  cryptoSerial: 'abcdef01234567890123',
};

// ---- fakes ----------------------------------------------------------------

/**
 * Homebridge's `platformAccessory`, as the platform `new`s it.
 *
 * Unlike the other platform tests, local-only builds REAL
 * KumoThermostatAccessory instances — that is the mode, and whether the synthetic
 * profile reaches them is under test — so this needs working service
 * bookkeeping. Delegated to the shared HAP fake so the enum values stay
 * hap-nodejs's own.
 */
class FakePlatformAccessory {
  private readonly fake: FakeAccessory;
  readonly context: FakeAccessory['context'];
  constructor(public displayName: string, public UUID: string) {
    // The serial here is never read: setupLocalOnly overwrites context.device
    // before it constructs the handler.
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

/**
 * The slice of KumoAPI local-only touches, plus recorders for the cloud calls it
 * must never make.
 *
 * `emitDeviceProfile` is the real relay (it drives the accessory's own
 * subscription), because the synthetic profile actually reaching the accessory is
 * what half of this file is about.
 */
interface KumoStub {
  cloudCalls: string[];
  cloudCommands: Array<{ serial: string; commands: Commands }>;
  profiles: Array<{ serial: string; profile: DeviceProfile }>;
  subscribeToDevice(serial: string, cb: DeviceUpdateCallback): void;
  unsubscribeFromDevice(serial: string): void;
  onDeviceProfileUpdate(cb: DeviceProfileCallback): void;
  emitDeviceProfile(serial: string, profile: DeviceProfile): void;
  sendCommand(serial: string, commands: Commands): Promise<boolean>;
  login(): Promise<boolean>;
  getSites(): Promise<Site[]>;
  getZones(siteId: string): Promise<Zone[]>;
  startStreaming(serials: string[]): Promise<boolean>;
  destroy(): void;
}

function makeKumoStub(): KumoStub {
  const profileCbs: DeviceProfileCallback[] = [];
  const stub: KumoStub = {
    cloudCalls: [],
    cloudCommands: [],
    profiles: [],
    subscribeToDevice: () => {},
    unsubscribeFromDevice: () => {},
    onDeviceProfileUpdate: (cb: DeviceProfileCallback) => {
      profileCbs.push(cb);
    },
    emitDeviceProfile: (serial: string, profile: DeviceProfile) => {
      stub.profiles.push({ serial, profile });
      for (const cb of profileCbs) {
        cb(serial, profile);
      }
    },
    sendCommand: async (serial: string, commands: Commands) => {
      stub.cloudCalls.push('sendCommand');
      stub.cloudCommands.push({ serial, commands });
      return true;
    },
    login: async () => {
      stub.cloudCalls.push('login');
      return true;
    },
    getSites: async () => {
      stub.cloudCalls.push('getSites');
      return [];
    },
    getZones: async () => {
      stub.cloudCalls.push('getZones');
      return [];
    },
    startStreaming: async () => {
      stub.cloudCalls.push('startStreaming');
      return true;
    },
    destroy: () => {},
  };
  return stub;
}

interface LocalClientStub extends Pick<LocalKumoClient,
  'setCreds' | 'clearCreds' | 'hasLocal' | 'getIp' | 'getStatus' | 'sendCommand'> {
  creds: Map<string, LocalDeviceCreds>;
  statusResult: Partial<DeviceStatus> | null;
  reads: string[];
}

function makeLocalClientStub(over: Partial<LocalClientStub> = {}): LocalClientStub {
  const creds = new Map<string, LocalDeviceCreds>();
  const stub: LocalClientStub = {
    creds,
    reads: [],
    // A unit that answers, so the startup reachability pass reports success.
    statusResult: { roomTemp: 22, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20 },
    setCreds(serial: string, c: LocalDeviceCreds) {
      creds.set(serial, c);
    },
    clearCreds(serial: string) {
      creds.delete(serial);
    },
    hasLocal(serial: string) {
      return creds.has(serial);
    },
    getIp(serial: string) {
      return creds.get(serial)?.ip;
    },
    async getStatus(serial: string) {
      stub.reads.push(serial);
      return stub.statusResult;
    },
    async sendCommand() {
      return true;
    },
    ...over,
  };
  return stub;
}

/** A DeviceProfile with the two mode capabilities under test, defaults elsewhere. */
function profileWith(caps: { hasModeDry: boolean; hasModeVent: boolean }): DeviceProfile {
  return {
    numberOfFanSpeeds: 4, hasFanSpeedAuto: true, usesSetPointInDryMode: true,
    hasModeHeat: true, hasVaneDir: true, hasVaneSwing: true, hasDefrost: true, hasStandby: true,
    minimumSetPoints: { cool: 16, heat: 16, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    ...caps,
  };
}

/**
 * A CLOUD-mode accessory (no `localOnly`, no display options) handed a profile that
 * reports dry and vent. The control for the local-only tile implication: there the
 * capability is hand-declared per unit, here it is discovered for every unit that
 * has it, so the tiles stay opt-in.
 */
function makeCloudProfileHarness(caps: { hasModeDry: boolean; hasModeVent: boolean }) {
  const profileCbs: DeviceProfileCallback[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { username: 'user@example.com', password: 'secret' },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb: DeviceProfileCallback) {
      profileCbs.push(cb);
    },
    async sendCommand() {
      return true;
    },
  };
  const accessory = makeAccessory('Salon', SERIAL);
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  for (const cb of profileCbs) {
    cb(SERIAL, profileWith(caps));
  }
  return { handler, accessory };
}

interface Spies {
  register: unknown[][];
  update: unknown[][];
  unregister: unknown[][];
}

function makeApi(spies: Spies) {
  return {
    hap: {
      Service,
      Characteristic,
      uuid: { generate: (s: string) => `uuid-${s}` },
    },
    platformAccessory: FakePlatformAccessory,
    on: () => {},
    registerPlatformAccessories: (...a: unknown[]) => spies.register.push(a),
    updatePlatformAccessories: (...a: unknown[]) => spies.update.push(a),
    unregisterPlatformAccessories: (...a: unknown[]) => spies.unregister.push(a),
  };
}

/**
 * A platform in local-only mode, with the cloud client stubbed and the LAN client
 * pre-assigned so nothing reaches the network.
 *
 * The config is the objective one VERBATIM — no username or password (that a
 * local-only block runs without them is part of what is under test) and, just as
 * importantly, no `showDrySwitch`/`showFanOnlySwitch`. Those two were injected here
 * once, which quietly made every test run a config the user was never given: the
 * tests said the declared dry/vent tiles appeared while the documented config
 * produced neither. Anything a test needs beyond the objective config it now asks
 * for by name.
 *
 * `startLocalPolling` is stubbed out (its immediate poll is not most tests' subject,
 * and a live interval would hang the runner) but RECORDS its calls: it is the only
 * status source in this mode, so "the poller was started" is a claim worth
 * asserting rather than a no-op. Pass `{ realPoller: true }` to exercise the real
 * one; `cleanup()` disarms the interval.
 */
function makePlatform(
  overrides: Partial<KumoConfig> = {},
  opts: { realPoller?: boolean } = {},
) {
  const spies: Spies = { register: [], update: [], unregister: [] };
  const config = {
    name: 'test',
    platform: 'KumoV3',
    localOnly: true,
    localDevices: [DEVICE],
    localPollInterval: 15,
    ...overrides,
  } as unknown as PlatformConfig;

  const platform = new KumoV3Platform(makeLog() as never, config, makeApi(spies) as never);
  const kumo = makeKumoStub();
  (platform as unknown as { kumoAPI: KumoStub }).kumoAPI = kumo;
  const local = makeLocalClientStub();
  platform.localClient = local as never;
  const pollerStarts: number[] = [];
  if (!opts.realPoller) {
    platform['startLocalPolling'] = () => {
      pollerStarts.push(Date.now());
    };
  }

  return { platform, kumo, local, spies, pollerStarts };
}

/** The accessories handed to registerPlatformAccessories, flattened. */
function registered(spies: Spies): FakePlatformAccessory[] {
  return spies.register.flatMap((call) => call[2] as FakePlatformAccessory[]);
}

// ---- the config is usable as written -------------------------------------

test('the objective config validates with no cloud credentials at all', () => {
  // The full rejection table lives in config-validation.test.ts; this pins the
  // one case the mode exists for.
  const config = {
    name: 'test',
    platform: 'KumoV3',
    localOnly: true,
    localDevices: [DEVICE],
    localPollInterval: 15,
  } as unknown as KumoConfig;

  assert.strictEqual(validatePlatformConfig(config), null);
});

// ---- registration --------------------------------------------------------

test('every declared unit becomes an accessory', async () => {
  const { platform, spies } = makePlatform({ localDevices: [DEVICE, DEVICE_B] });
  try {
    await platform.discoverDevices();

    assert.deepStrictEqual(
      registered(spies).map((a) => a.displayName),
      ['Salon', 'Chambre'],
      'both units reached the bridge, named from config',
    );
    assert.strictEqual(platform['accessoryHandlers'].length, 2);
    assert.strictEqual(platform['discoveryRetryTimer'], null, 'discovery counted as a success');
  } finally {
    platform['cleanup']();
  }
});

test('a unit with no name falls back to its serial', async () => {
  const { platform, spies } = makePlatform({
    localDevices: [{ ...DEVICE, name: undefined }],
  });
  try {
    await platform.discoverDevices();
    assert.deepStrictEqual(registered(spies).map((a) => a.displayName), [SERIAL]);
  } finally {
    platform['cleanup']();
  }
});

test('the LAN credentials are seeded from config, per unit', async () => {
  const { platform, local } = makePlatform({ localDevices: [DEVICE, DEVICE_B] });
  try {
    await platform.discoverDevices();

    assert.deepStrictEqual(local.creds.get(SERIAL), {
      ip: DEVICE.ip, password: DEVICE.password, cryptoSerial: DEVICE.cryptoSerial,
    }, 'all three values, straight from the declaration');
    assert.deepStrictEqual(local.creds.get(SERIAL_B), {
      ip: DEVICE_B.ip, password: DEVICE_B.password, cryptoSerial: DEVICE_B.cryptoSerial,
    });
    assert.deepStrictEqual(platform['localSerials'], [SERIAL, SERIAL_B]);
  } finally {
    platform['cleanup']();
  }
});

test('credentials are seeded before the accessory exists, so its first read can be local', async () => {
  // Ordering, not bookkeeping: the handler is constructed inside the same loop and
  // its first getStatus goes out over the LAN. Seeding after construction would
  // route that read (and any command in the same tick) nowhere.
  const seededAt: string[] = [];
  const { platform, local } = makePlatform();
  local.setCreds = (serial: string, c: LocalDeviceCreds) => {
    seededAt.push('setCreds');
    local.creds.set(serial, c);
  };
  const realCtor = platform['accessoryHandlers'].push.bind(platform['accessoryHandlers']);
  platform['accessoryHandlers'].push = ((...args: KumoThermostatAccessory[]) => {
    seededAt.push('handler');
    return realCtor(...args);
  }) as never;
  try {
    await platform.discoverDevices();
    assert.deepStrictEqual(seededAt, ['setCreds', 'handler']);
  } finally {
    platform['cleanup']();
  }
});

test('excludeDevices hides a declared unit', async () => {
  const { platform, local, spies } = makePlatform({
    localDevices: [DEVICE, DEVICE_B],
    excludeDevices: [SERIAL],
  });
  try {
    await platform.discoverDevices();

    assert.deepStrictEqual(registered(spies).map((a) => a.displayName), ['Chambre']);
    assert.strictEqual(local.creds.has(SERIAL), false, 'an excluded unit gets no credentials either');
    assert.deepStrictEqual(platform['localSerials'], [SERIAL_B],
      'and is not counted as a unit awaiting credentials');
  } finally {
    platform['cleanup']();
  }
});

test('excluding every unit is reported as a config fault, not retried forever', async () => {
  // `false` from attemptDiscovery means "transient, try again", and no amount of
  // retrying un-excludes a device. Cached accessories are deliberately left alone:
  // an excludeDevices typo must not cost the user their rooms and automations.
  const errors: string[] = [];
  const { platform, spies } = makePlatform({ excludeDevices: [SERIAL] });
  platform.log.error = (...args: unknown[]) => errors.push(args.join(' '));
  platform.accessories.push(new FakePlatformAccessory('Salon', `uuid-${SERIAL}`) as never);
  try {
    await platform.discoverDevices();

    assert.strictEqual(platform['discoveryRetryTimer'], null, 'no retry is queued');
    assert.strictEqual(spies.unregister.length, 0, 'and nothing is unregistered');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /every declared device is excluded/i);
  } finally {
    platform['cleanup']();
  }
});

test('a cached accessory for a unit no longer declared is unregistered exactly once', async () => {
  const { platform, spies } = makePlatform();
  platform.accessories.push(new FakePlatformAccessory('Gone', 'uuid-OLD') as never);
  try {
    await platform.discoverDevices();

    assert.strictEqual(spies.unregister.length, 1);
    assert.deepStrictEqual(
      (spies.unregister[0][2] as FakePlatformAccessory[]).map((a) => a.displayName),
      ['Gone'],
    );
    assert.ok(
      !platform.accessories.some((a) => a.UUID === 'uuid-OLD'),
      'dropped from our own list too — HAP THROWS on a second removal of the same accessory',
    );

    // A second pass must not hand it back.
    await platform.discoverDevices();
    assert.strictEqual(spies.unregister.length, 1);
  } finally {
    platform['cleanup']();
  }
});

test('a cached accessory for a still-declared unit is restored, not duplicated', async () => {
  const { platform, spies } = makePlatform();
  const cached = new FakePlatformAccessory('Salon', `uuid-${SERIAL}`);
  platform.accessories.push(cached as never);
  try {
    await platform.discoverDevices();

    assert.strictEqual(spies.register.length, 0, 'the cached accessory is reused');
    assert.strictEqual(spies.update.length >= 1, true, 'and re-published');
    assert.strictEqual(platform['accessoryHandlers'].length, 1);
    assert.strictEqual(cached.context.device.deviceSerial, SERIAL,
      'its context is refreshed from config');
  } finally {
    platform['cleanup']();
  }
});

test('a second discovery pass does not create a second handler for the same unit', async () => {
  // Discovery retries, and the guard is what keeps a retry from double-registering.
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    await platform.discoverDevices();

    assert.strictEqual(platform['accessoryHandlers'].length, 1);
    assert.strictEqual(spies.register.length, 1);
  } finally {
    platform['cleanup']();
  }
});

// ---- the local poller: the only status source in this mode ---------------

test('discovery starts the local poller, once', async () => {
  // Nothing asserted this, and deleting the call from setupLocalOnly left the whole
  // suite green: in local-only there is no streaming and no site polling, and the
  // startup reachability read throws its result away, so this poller is the entire
  // read path. Without it every tile freezes at its initial value forever.
  const { platform, pollerStarts } = makePlatform({ localDevices: [DEVICE, DEVICE_B] });
  try {
    await platform.discoverDevices();
    assert.strictEqual(pollerStarts.length, 1, 'started once for the platform, not once per unit');
  } finally {
    platform['cleanup']();
  }
});

test('the real poller feeds the units status into HomeKit', async () => {
  // The stub above proves the call happens; this proves the call does something.
  // startLocalPolling polls immediately, so one turn of the event loop is enough to
  // see the LAN reading arrive on the characteristic. cleanup() disarms the interval.
  const { platform, local, spies } = makePlatform({}, { realPoller: true });
  try {
    await platform.discoverDevices();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const heaterCooler = registered(spies)[0].getService(Service.HeaterCooler);
    assert.strictEqual(
      heaterCooler?.chars.get(Characteristic.CurrentTemperature)?.value,
      local.statusResult?.roomTemp,
      'the temperature HomeKit shows came from the local read',
    );
  } finally {
    platform['cleanup']();
  }
});

test('a unit that keeps failing its local polls is named in a warning, once', async () => {
  // A null status is how a wrong cryptoSerial or a moved DHCP lease actually
  // presents: the adapter answers HTTP 200 with `{"_api_error": ...}`, or a body
  // with no roomTemp, and getStatus returns null. The poll loop had no else branch
  // at all, so after the single startup warning the failure was invisible for the
  // life of the process while the tile went on showing fabricated healthy values.
  const warns: string[] = [];
  // The real poll pass, driven one turn at a time: `pollLocalDevices` is a method
  // precisely so a test can run a pass without arming (or waiting out) the 15s
  // interval. Anything that stubbed the counter instead would keep passing if the
  // poll loop stopped calling it, which is the failure being fixed.
  const { platform, local } = makePlatform();
  local.statusResult = null; // the unit answers, but with nothing usable
  platform.log.warn = (...args: unknown[]) => warns.push(args.join(' '));
  const poll = () => platform['pollLocalDevices']();
  const named = () => warns.filter((w) => /polls in a row/.test(w));
  try {
    await platform.discoverDevices();

    await poll();
    await poll();
    assert.strictEqual(
      named().length, 0,
      'a single dropped read is routine on an adapter that takes one connection at a time',
    );

    await poll();
    assert.strictEqual(named().length, 1);
    assert.match(named()[0], new RegExp(SERIAL));
    assert.match(named()[0], /192\.168\.6\.11/, 'and the address to check');
    assert.match(named()[0], /cryptoSerial/, 'and the other thing it is usually');

    // Latched: the outage must not turn into one warning every 15s.
    await poll();
    await poll();
    assert.strictEqual(named().length, 1);

    // And it re-arms once the unit has answered again.
    local.statusResult = { roomTemp: 22, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20 };
    await poll();
    local.statusResult = null;
    await poll();
    await poll();
    await poll();
    assert.strictEqual(named().length, 2);
  } finally {
    platform['cleanup']();
  }
});

// ---- no cloud, on any path ----------------------------------------------

test('discovery makes no cloud call whatsoever', async () => {
  const { platform, kumo } = makePlatform({ localDevices: [DEVICE, DEVICE_B] });
  try {
    await platform.discoverDevices();
    assert.deepStrictEqual(kumo.cloudCalls, [],
      'login/getSites/getZones/startStreaming must all stay untouched');
  } finally {
    platform['cleanup']();
  }
});

test('no site poller is started, since LOCAL_ONLY_SITE_ID is not a real site', async () => {
  // Reachable only through degraded mode today, but a GET /sites/local-only/zones
  // would break the promise, so the guard is on the poller itself.
  const { platform, kumo } = makePlatform({ disablePolling: false });
  try {
    await platform.discoverDevices();
    platform['startSitePoller']('local-only');
    await platform['pollSite']('local-only');

    assert.strictEqual(platform['sitePollers'].size, 0);
    assert.deepStrictEqual(kumo.cloudCalls, []);
  } finally {
    platform['cleanup']();
  }
});

/** Run `fn` with global fetch replaced by a recorder that refuses every request. */
async function withNoNetwork(fn: (calls: string[]) => Promise<void>): Promise<void> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    calls.push(String(input));
    return Promise.reject(new Error('the cloud must not be contacted in local-only mode'));
  }) as never;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('the real KumoAPI issues no HTTP even when credentials ARE present', async () => {
  // The kill switch lives in the transport rather than at each caller, so the
  // guarantee does not depend on every present and future call site remembering
  // the mode.
  //
  // Credentials are passed deliberately. Refusing when there are none is a
  // different (and much weaker) guard, and it would mask this one: the realistic
  // local-only config is a user who already had cloud credentials in config.json
  // and switched the mode on, leaving them in place. Without the kill switch every
  // call below reaches Mitsubishi.
  await withNoNetwork(async (calls) => {
    const api = new KumoAPI('user@example.com', 'secret', makeLog() as never, false, true, true);
    try {
      assert.strictEqual(await api.login(), false, 'login refuses');
      assert.strictEqual(await api.startStreaming([SERIAL]), false, 'streaming refuses');
      assert.strictEqual(await api.sendCommand(SERIAL, { operationMode: 'off' }), false);
      assert.deepStrictEqual(await api.getSites(), []);
      assert.deepStrictEqual(await api.getZones('site-1'), []);
      assert.deepStrictEqual(calls, [], 'not one request left the process');
    } finally {
      api.destroy();
    }
  });
});

test('a KumoAPI built with no credentials refuses to post an empty login', async () => {
  // The belt to the kill switch's braces, and the state local-only actually leaves
  // behind: KumoConfig types both fields as optional now, so `undefined` reaching
  // the constructor is expected rather than a type error waiting to happen.
  await withNoNetwork(async (calls) => {
    const api = new KumoAPI(undefined, undefined, makeLog() as never);
    try {
      assert.strictEqual(await api.login(), false);
      assert.deepStrictEqual(calls, [], 'no request with an undefined username');
    } finally {
      api.destroy();
    }
  });
});

// ---- the synthetic profile ----------------------------------------------

test('a profile is emitted per unit, since no profile_update will ever arrive', async () => {
  const { platform, kumo } = makePlatform({ localDevices: [DEVICE, DEVICE_B] });
  try {
    await platform.discoverDevices();
    assert.deepStrictEqual(kumo.profiles.map((p) => p.serial), [SERIAL, SERIAL_B]);
  } finally {
    platform['cleanup']();
  }
});

test('the declared capabilities and bounds are what the profile carries', async () => {
  const { platform, kumo } = makePlatform({
    localDevices: [{
      ...DEVICE, hasModeHeat: false, minSetPoint: 18, maxSetPoint: 28,
      hasVaneSwing: false, hasFanSpeedAuto: false, numberOfFanSpeeds: 3,
    }],
  });
  try {
    await platform.discoverDevices();
    const profile = kumo.profiles[0].profile;

    assert.strictEqual(profile.hasModeDry, true);
    assert.strictEqual(profile.hasModeVent, true);
    assert.strictEqual(profile.hasModeHeat, false);
    assert.strictEqual(profile.hasVaneSwing, false, 'over-declaring a vane yields an inert control');
    assert.strictEqual(profile.hasFanSpeedAuto, false);
    assert.strictEqual(profile.numberOfFanSpeeds, 3);
    assert.deepStrictEqual(profile.minimumSetPoints, { cool: 18, heat: 18, auto: 18 });
    assert.deepStrictEqual(profile.maximumSetPoints, { cool: 28, heat: 28, auto: 28 });
  } finally {
    platform['cleanup']();
  }
});

test('an undeclared unit gets the same defaults the cloud path falls back to', async () => {
  const { platform, kumo } = makePlatform({
    localDevices: [{
      deviceSerial: SERIAL, ip: DEVICE.ip, password: DEVICE.password,
      cryptoSerial: DEVICE.cryptoSerial,
    }],
  });
  try {
    await platform.discoverDevices();
    const profile = kumo.profiles[0].profile;

    assert.deepStrictEqual(profile.minimumSetPoints, { cool: 16, heat: 16, auto: 16 });
    assert.deepStrictEqual(profile.maximumSetPoints, { cool: 31, heat: 31, auto: 31 });
    assert.strictEqual(profile.hasModeHeat, true);
    assert.strictEqual(profile.hasModeDry, false, 'dry and vent are opt-in');
    assert.strictEqual(profile.hasModeVent, false);
    assert.strictEqual(profile.usesSetPointInDryMode, true);
  } finally {
    platform['cleanup']();
  }
});

test('the objective config, verbatim, gets the dry and fan-only tiles it declares', async () => {
  // No showDrySwitch/showFanOnlySwitch anywhere — this is the config the user was
  // handed. Two things have to hold for the declaration to mean anything:
  //   * The emit MUST follow the handler construction: the accessory subscribes in
  //     its own constructor, so emitting first drops the profile silently — leaving
  //     default setpoint bounds, every mode offered, and no Dry or Fan switch.
  //   * In local-only the capability is DECLARED, not discovered, and the tile is
  //     the only thing hasModeDry/hasModeVent gate (HeaterCooler has no dehumidify
  //     or fan-only state), so the declaration implies the tile. Requiring the
  //     platform-level display option on top made both flags inert: dry and vent
  //     were unreachable on the very config that asks for them.
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    const accessory = registered(spies)[0];

    assert.ok(accessory.getServiceById(Service.Switch, 'dry'), 'hasModeDry -> Dry switch');
    assert.ok(accessory.getServiceById(Service.Switch, 'fan-only'), 'hasModeVent -> Fan switch');

    const heaterCooler = accessory.getService(Service.HeaterCooler);
    assert.ok(heaterCooler, 'the climate service was published');
    const cool = heaterCooler.chars.get(Characteristic.CoolingThresholdTemperature);
    assert.deepStrictEqual(cool?.props, { minValue: 16, maxValue: 31, minStep: 0.1 },
      'the declared bounds reached HomeKit');
  } finally {
    platform['cleanup']();
  }
});

test('a unit that declares neither dry nor vent gets neither switch', async () => {
  const { platform, spies } = makePlatform({
    localDevices: [{ ...DEVICE, hasModeDry: false, hasModeVent: false }],
  });
  try {
    await platform.discoverDevices();
    const accessory = registered(spies)[0];

    assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null);
    assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null);
  } finally {
    platform['cleanup']();
  }
});

test('an explicit showDrySwitch: false still wins, and says the mode is unreachable', async () => {
  // The declaration implies the tile only where the display option is ABSENT. Set
  // it explicitly and that choice stands — with one INFO line naming the option,
  // because the consequence (dry cannot be selected at all) is not obvious.
  const infos: string[] = [];
  const { platform, spies } = makePlatform({ showDrySwitch: false });
  platform.log.info = (...args: unknown[]) => infos.push(args.join(' '));
  try {
    await platform.discoverDevices();
    const accessory = registered(spies)[0];

    assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'no tile');
    assert.ok(accessory.getServiceById(Service.Switch, 'fan-only'), 'vent is unaffected');

    const notice = infos.filter((line) => /showDrySwitch/.test(line));
    assert.strictEqual(notice.length, 1, 'said once, naming the option');
    assert.match(notice[0], /cannot be selected/i);
  } finally {
    platform['cleanup']();
  }
});

test('the display options are still opt-in on the cloud path', async () => {
  // The control for the implication above: on a cloud account the profile reports
  // the capability for every unit that has one, so an automatic tile would clutter
  // the Home app of everyone whose units merely support dry. Nothing about
  // hasModeDry is a user declaration there.
  const { handler, accessory } = makeCloudProfileHarness({ hasModeDry: true, hasModeVent: true });

  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null);
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null);
  assert.ok(handler, 'the accessory itself is fine — only the two tiles are withheld');
});

test('a throwing profile consumer does not stop the others', async () => {
  const api = new KumoAPI(undefined, undefined, makeLog() as never, false, false, true);
  const seen: string[] = [];
  try {
    api.onDeviceProfileUpdate(() => {
      throw new Error('boom');
    });
    api.onDeviceProfileUpdate((serial) => seen.push(serial));

    api.emitDeviceProfile(SERIAL, {
      numberOfFanSpeeds: 4, hasFanSpeedAuto: true, hasModeDry: false,
      usesSetPointInDryMode: true, hasModeHeat: true, hasModeVent: false,
      hasVaneDir: true, hasVaneSwing: true, hasDefrost: true, hasStandby: true,
      minimumSetPoints: { cool: 16, heat: 16, auto: 16 },
      maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    });

    assert.deepStrictEqual(seen, [SERIAL]);
  } finally {
    api.destroy();
  }
});

// ---- startup reachability ------------------------------------------------
//
// Everything above trusts config completely. With no cloud fallback left, a wrong
// cryptoSerial or a moved DHCP lease is a tile that never updates and never
// responds, and the only other symptom is a debug-level poll error.

test('a unit that does not answer is named in a warning, and not counted as active', async () => {
  const warns: string[] = [];
  const { platform, local } = makePlatform();
  local.statusResult = null;
  const infos: string[] = [];
  platform.log.warn = (...args: unknown[]) => warns.push(args.join(' '));
  platform.log.info = (...args: unknown[]) => infos.push(args.join(' '));
  try {
    await platform.discoverDevices();

    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /Salon/);
    assert.match(warns[0], /192\.168\.6\.11/);
    assert.match(warns[0], /no cloud fallback/i);
    assert.ok(
      infos.some((line) => /0\/1 device/.test(line)),
      'the summary must not claim success for a unit that never answered',
    );
  } finally {
    platform['cleanup']();
  }
});

test('a unit that answers is reported as active', async () => {
  const infos: string[] = [];
  const warns: string[] = [];
  const { platform } = makePlatform();
  platform.log.info = (...args: unknown[]) => infos.push(args.join(' '));
  platform.log.warn = (...args: unknown[]) => warns.push(args.join(' '));
  try {
    await platform.discoverDevices();

    assert.deepStrictEqual(warns, []);
    assert.ok(infos.some((line) => /1\/1 device\(s\) — cloud never contacted/.test(line)));
  } finally {
    platform['cleanup']();
  }
});

test('a reachability read that throws is survivable', async () => {
  const { platform, local } = makePlatform();
  local.getStatus = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    // The read is diagnostic; a thrown error must not fail discovery and send the
    // whole platform into the retry loop.
    await platform.discoverDevices();
    assert.strictEqual(platform['discoveryRetryTimer'], null);
    assert.strictEqual(platform['accessoryHandlers'].length, 1);
  } finally {
    platform['cleanup']();
  }
});

// ---- mirroring still works ----------------------------------------------

test('device mirroring is set up in local-only mode too', async () => {
  // MirrorController is transport-agnostic — it listens on the handlers and writes
  // through sendDeviceCommand — so it works over the LAN, and better than over the
  // cloud (no 7-10s lag). It used to sit after the local-only early return, so a
  // configured `mirror` was silently ignored.
  const { platform } = makePlatform({
    localDevices: [DEVICE, DEVICE_B],
    mirror: [{ source: SERIAL, target: SERIAL_B }],
  });
  try {
    await platform.discoverDevices();
    assert.ok(platform['mirror'], 'a mirror controller was constructed');
  } finally {
    platform['cleanup']();
  }
});

// ---- commands never leak to the cloud -----------------------------------
//
// The accessory is exercised directly here: sendDeviceCommand is the single funnel
// for every write, and this is the path the whole mode's promise turned on.

interface AccessoryHarness {
  handler: KumoThermostatAccessory;
  cloudCommands: Array<{ serial: string; commands: Commands }>;
  localCommands: Commands[];
}

function makeAccessoryHarness(
  { localOnly = true, localSendSucceeds = true, hasLocal = true, withHap = false }:
  { localOnly?: boolean; localSendSucceeds?: boolean; hasLocal?: boolean; withHap?: boolean } = {},
): AccessoryHarness {
  const cloudCommands: Array<{ serial: string; commands: Commands }> = [];
  const localCommands: Commands[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    // `withHap` supplies the real hap-nodejs error classes, as Homebridge does
    // (api.hap IS the hap-nodejs module — dist/api.js: `hap = hapNodeJs`). Off by
    // default so the other cases also cover the fallback for a platform fake
    // without them.
    api: {
      updatePlatformAccessories() {},
      // HAPStatus is a `const` enum, so the enum object cannot be referenced from
      // TypeScript — only its members, which inline. hap-nodejs emits the runtime
      // object regardless (verified: `require('@homebridge/hap-nodejs').HAPStatus
      // .SERVICE_COMMUNICATION_FAILURE` is -70402), which is what the plugin reads.
      ...(withHap
        ? {
          hap: {
            HapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
          },
        }
        : {}),
    },
    kumoConfig: { localOnly, showDrySwitch: true, showFanOnlySwitch: true },
    localClient: {
      hasLocal: () => hasLocal,
      async sendCommand(_serial: string, commands: Commands) {
        localCommands.push(commands);
        return localSendSucceeds;
      },
      async getStatus() {
        return null;
      },
    },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    async sendCommand(serial: string, commands: Commands) {
      cloudCommands.push({ serial, commands });
      return true;
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    makeAccessory('Salon', SERIAL) as never,
    kumoAPI as never,
    30,
  );
  return { handler, cloudCommands, localCommands };
}

test('a failed local command does NOT fall back to the cloud in local-only mode', async () => {
  const h = makeAccessoryHarness({ localSendSucceeds: false });

  // It also does not pretend to have worked. The harness never feeds a status, so
  // there is no real state to revert the characteristic to — the case where a
  // silently-resolving setter left the Home app showing the value the user set on a
  // unit that never received it, forever — nothing in the plugin marks an accessory
  // Not Responding, so the rejection is the only signal available.
  await assert.rejects(() => h.handler.setActive(Characteristic.Active.INACTIVE));

  assert.strictEqual(h.localCommands.length, 1, 'local was attempted');
  assert.deepStrictEqual(h.cloudCommands, [],
    'the fallback would POST /v3/login with credentials that do not exist',
  );
});

test('a unit with no local credentials is not quietly routed to the cloud either', async () => {
  const h = makeAccessoryHarness({ hasLocal: false });

  await assert.rejects(() => h.handler.setActive(Characteristic.Active.INACTIVE),
    'the command went nowhere at all, so HomeKit must hear about it');

  assert.deepStrictEqual(h.localCommands, []);
  assert.deepStrictEqual(h.cloudCommands, []);
});

test('an unrevertable failure reaches HomeKit as a communication failure', async () => {
  // Not just any rejection: HAP maps the status onto the wire, and this is the one
  // that makes the Home app show the write as failed rather than accepting it.
  const h = makeAccessoryHarness({ localSendSucceeds: false, withHap: true });

  await assert.rejects(
    () => h.handler.setActive(Characteristic.Active.INACTIVE),
    (err: unknown) => {
      assert.strictEqual(
        (err as { hapStatus?: number }).hapStatus,
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      return true;
    },
  );
});

test('a failed write on a unit whose state IS known reverts instead of throwing', async () => {
  // The control for the two above: with a cached status the revert is the feedback,
  // and the setter resolving normally is correct — the characteristic is pushed back
  // to the unit's real state 100ms later. Only an unknowable state is reported as a
  // failure, so this is not a blanket "throw on every failed write".
  const h = makeAccessoryHarness({ localSendSucceeds: false });
  h.handler.updateFromLocal({ roomTemp: 22, operationMode: 'cool', power: 1, spCool: 24, spHeat: 20 });

  await h.handler.setActive(Characteristic.Active.INACTIVE);

  assert.strictEqual(h.localCommands.length, 1);
  assert.deepStrictEqual(h.cloudCommands, []);
});

test('the cloud fallback is intact when localOnly is NOT set', async () => {
  // The control: `localControl: true` on a cloud account still wants a failed LAN
  // write to reach the cloud, which is what local-integration.test.ts pins.
  const h = makeAccessoryHarness({ localOnly: false, localSendSucceeds: false });

  await h.handler.setActive(Characteristic.Active.INACTIVE);

  assert.strictEqual(h.localCommands.length, 1);
  assert.strictEqual(h.cloudCommands.length, 1, 'the cloud path is untouched by the local-only guard');
});

test('a setpoint write is sent even before any status has been read', async () => {
  // The two thresholds are the only setpoint controls on HeaterCooler, in every
  // mode. This used to bail out with "no current status" — logging an error,
  // sending nothing, and reverting nothing, so the tile showed a setpoint the unit
  // had never received. In local-only mode the cache is filled only by the local
  // poll (15s, and never at all if the unit was unreachable at startup), so the
  // window is wide open rather than the sub-second one streaming leaves.
  const h = makeAccessoryHarness();

  await h.handler.setCoolingThresholdTemperature(23);

  assert.strictEqual(h.localCommands.length, 1, 'the write reached the unit');
  assert.ok(
    typeof (h.localCommands[0] as { spCool?: number }).spCool === 'number',
    'and carried the cooling setpoint',
  );
  assert.deepStrictEqual(h.cloudCommands, []);
});

test('localOnly hand-edited to a truthy string disables the cloud on EVERY path', async () => {
  // `localOnly` was read two ways: by truthiness in validatePlatformConfig and
  // attemptDiscovery, but by `=== true` for the KumoAPI kill switch and the
  // per-command cloud fallback. A hand-edited `"localOnly": "true"` therefore
  // passed validation with no credentials and took the local-only branch, while
  // the fallback stayed armed — so the first failed LAN write posted /v3/login
  // with the Canadian credentials still sitting in config.json (a 10s rate-limit
  // sleep inside the HomeKit setter, then a cluster of 500s). The value is
  // normalized once now, so the mode cannot be half on.
  const { platform, kumo, local } = makePlatform({
    localOnly: 'true' as never,
    username: 'user@example.com',
    password: 'secret',
  });
  local.sendCommand = async () => false; // the LAN write fails, as it routinely can
  try {
    await platform.discoverDevices();

    assert.strictEqual(platform.kumoConfig.localOnly, true, 'normalized to a real boolean, once');

    const handler = platform['accessoryHandlers'][0];
    await assert.rejects(
      () => handler.setActive(Characteristic.Active.INACTIVE),
      'with no status ever read there is nothing to revert to, so HomeKit is told the write failed',
    );

    assert.deepStrictEqual(kumo.cloudCalls, [], 'and not one cloud call was made');
  } finally {
    platform['cleanup']();
  }
});
