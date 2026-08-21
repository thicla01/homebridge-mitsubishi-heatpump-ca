// The v2 bootstrap as the platform uses it: `cloudRegion: 'ca'`, where one v2
// sign-in supplies the whole inventory and the LAN does everything after that.
//
// Two claims carry most of this file:
//
//  * The v3 API is contacted on NO path, exactly as in local-only mode — the kill
//    switch is armed for this region too. What IS different, and stated here rather
//    than implied, is that ONE v2 POST happens at startup. That is the whole cloud
//    footprint of the mode.
//  * The REAL device profile replaces the hand-declared stand-in, and with it the
//    per-mode setpoint floors. The heating floor is the concrete win: a synthetic
//    profile collapses one `minSetPoint` across all three modes, so a unit that can
//    hold 10 °C is published as 16 °C — and hap-nodejs REJECTS a client write below
//    minValue (-70410) rather than clamping, so the whole 50-61 °F band that freeze
//    protection and vacation setback live in becomes unreachable from HomeKit.
//
// The mode is NOT local-only, and the tile rule is where that matters: there the
// capabilities are hand-declared per unit, so the declaration implies the Dry/Fan
// switch; here they are discovered, and both are true on real hardware, so the
// tiles stay opt-in as on the cloud path.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoAPI } from '../dist/kumo-api.js';
import { KumoV3Platform, validatePlatformConfig } from '../dist/platform.js';
import { KumoThermostatAccessory } from '../dist/accessory.js';
import { parseV2Login } from '../dist/kumo-v2.js';
import type { V2Inventory, V2LoginOutcome } from '../dist/kumo-v2.js';
import type { DeviceProfileCallback, DeviceUpdateCallback } from '../dist/kumo-api.js';
import type { LocalDeviceCreds } from '../dist/local-api.js';
import type { SerialCreds } from '../dist/local-api.js';
import type { Commands, DeviceProfile, DeviceStatus, KumoConfig, Site, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeAccessory, makeLog } from './helpers';
import type { FakeAccessory, FakeService } from './helpers';
import {
  ADDRESS_B, SENTINELS, SERIAL_A, SERIAL_B, SERIAL_NO_SECRETS, makeV2Reply,
} from './v2-fixture';

/** The minimal Canadian config: credentials, a region, and nothing else. */
const CA_CONFIG = {
  name: 'test',
  platform: 'KumoV3',
  username: 'user@example.com',
  password: 'secret',
  cloudRegion: 'ca',
};

// ---- fakes ---------------------------------------------------------------

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

interface KumoStub {
  cloudCalls: string[];
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
  requestAdapterStatus(serial: string): void;
  getAdapterPassword(serial: string): string | undefined;
  getDeviceCryptoSerial(serial: string): Promise<string | undefined>;
  destroy(): void;
}

function makeKumoStub(): KumoStub {
  const profileCbs: DeviceProfileCallback[] = [];
  const stub: KumoStub = {
    cloudCalls: [],
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
    sendCommand: async () => {
      stub.cloudCalls.push('sendCommand');
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
    requestAdapterStatus: () => {
      stub.cloudCalls.push('requestAdapterStatus');
    },
    getAdapterPassword: () => {
      stub.cloudCalls.push('getAdapterPassword');
      return undefined;
    },
    getDeviceCryptoSerial: async () => {
      stub.cloudCalls.push('getDeviceCryptoSerial');
      return undefined;
    },
    destroy: () => {},
  };
  return stub;
}

interface LocalClientStub {
  creds: Map<string, LocalDeviceCreds>;
  statusResult: Partial<DeviceStatus> | null;
  setCreds(serial: string, c: LocalDeviceCreds): void;
  clearCreds(serial: string): void;
  hasLocal(serial: string): boolean;
  getIp(serial: string): string | undefined;
  getStatus(serial: string): Promise<Partial<DeviceStatus> | null>;
  sendCommand(serial: string, commands: Commands): Promise<boolean>;
}

function makeLocalClientStub(): LocalClientStub {
  const creds = new Map<string, LocalDeviceCreds>();
  const stub: LocalClientStub = {
    creds,
    statusResult: { roomTemp: 22, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20 },
    setCreds(serial, c) {
      creds.set(serial, c);
    },
    clearCreds(serial) {
      creds.delete(serial);
    },
    hasLocal(serial) {
      return creds.has(serial);
    },
    getIp(serial) {
      return creds.get(serial)?.ip;
    },
    async getStatus() {
      return stub.statusResult;
    },
    async sendCommand() {
      return true;
    },
  };
  return stub;
}

interface Spies {
  register: unknown[][];
  update: unknown[][];
  unregister: unknown[][];
}

function makeApi(spies: Spies) {
  return {
    hap: { Service, Characteristic, uuid: { generate: (s: string) => `uuid-${s}` } },
    platformAccessory: FakePlatformAccessory,
    on: () => {},
    registerPlatformAccessories: (...a: unknown[]) => spies.register.push(a),
    updatePlatformAccessories: (...a: unknown[]) => spies.update.push(a),
    unregisterPlatformAccessories: (...a: unknown[]) => spies.unregister.push(a),
  };
}

/** The inventory the fixture parses to — the real parser, not a hand-built map. */
function fixtureInventory(): V2Inventory {
  return parseV2Login(makeV2Reply());
}

/**
 * A platform in `cloudRegion: 'ca'` with three things pre-assigned so nothing
 * reaches the network: the cloud client (a recorder, so a leak is named rather
 * than thrown), the LAN client, and the v2 client.
 *
 * `admitLocalDevices` is stubbed but RECORDS its argument. That is not laziness:
 * the real one sweeps the host's /24 with live HTTP, and the claim under test is
 * that the v2 path hands the existing seam the right credentials rather than
 * reimplementing discovery.
 */
function makePlatform(
  overrides: Partial<KumoConfig> = {},
  opts: { outcome?: V2LoginOutcome } = {},
) {
  const spies: Spies = { register: [], update: [], unregister: [] };
  const config = { ...CA_CONFIG, ...overrides } as unknown as PlatformConfig;
  const platform = new KumoV3Platform(makeLog() as never, config, makeApi(spies) as never);

  const kumo = makeKumoStub();
  (platform as unknown as { kumoAPI: KumoStub }).kumoAPI = kumo;
  const local = makeLocalClientStub();
  platform.localClient = local as never;

  const logins: number[] = [];
  const outcome = opts.outcome ?? { fatal: false, inventory: fixtureInventory() };
  platform['v2Client'] = {
    login: async () => {
      logins.push(Date.now());
      return outcome;
    },
  } as never;

  const swept: Array<Map<string, SerialCreds>> = [];
  platform['admitLocalDevices'] = async (creds: Map<string, SerialCreds>) => {
    swept.push(creds);
  };
  const pollerStarts: number[] = [];
  platform['startLocalPolling'] = () => {
    pollerStarts.push(Date.now());
  };

  return { platform, kumo, local, spies, logins, swept, pollerStarts };
}

function registered(spies: Spies): FakePlatformAccessory[] {
  return spies.register.flatMap((call) => call[2] as FakePlatformAccessory[]);
}

function unregistered(spies: Spies): FakePlatformAccessory[] {
  return spies.unregister.flatMap((call) => call[2] as FakePlatformAccessory[]);
}

/**
 * An accessory as Homebridge hands it back from disk at startup, through the real
 * `configureAccessory`. That is what carries the user's room assignment, the name
 * they typed, and every scene and automation that references the accessory — none
 * of which survives an unregister.
 */
function restoreFromCache(platform: KumoV3Platform, name: string, serial: string): void {
  platform.configureAccessory(new FakePlatformAccessory(name, `uuid-${serial}`) as never);
}

// ---- the config ----------------------------------------------------------

test('the Canadian config is a region and nothing else — no localDevices, no secrets', () => {
  // The point of the whole feature: what a user has to write shrinks from a
  // hand-copied secret per unit to one line.
  assert.strictEqual(validatePlatformConfig(CA_CONFIG as unknown as KumoConfig), null);
  assert.strictEqual((CA_CONFIG as unknown as KumoConfig).localDevices, undefined);
});

test('the region and credential source are normalized once, and the source is derived', () => {
  const { platform } = makePlatform({ cloudRegion: ' CA ' as never });
  try {
    assert.strictEqual(platform.cloudRegion, 'ca', 'case and whitespace forgiven');
    assert.strictEqual(platform.kumoConfig.cloudRegion, 'ca', 'and normalized in place');
    assert.strictEqual(platform.localCredentialSource, 'v2', 'ca implies the v2 source');
    assert.strictEqual(platform.v3Unavailable, true);
    assert.strictEqual(platform.inventoryFromV2, true);
    assert.strictEqual(platform.kumoConfig.localOnly, false, 'this is NOT local-only mode');
  } finally {
    platform['cleanup']();
  }
});

test('a US account can take the v2 secrets while keeping v3 control', () => {
  const { platform } = makePlatform({ cloudRegion: undefined, localCredentialSource: 'v2' });
  try {
    assert.strictEqual(platform.cloudRegion, 'us');
    assert.strictEqual(platform.localCredentialSource, 'v2');
    assert.strictEqual(platform.v3Unavailable, false, 'v3 still does discovery and streaming');
    assert.strictEqual(platform.inventoryFromV2, false);
  } finally {
    platform['cleanup']();
  }
});

// ---- registration from the v2 inventory ---------------------------------

test('every v2 unit with usable secrets becomes an accessory, named from its room label', async () => {
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();

    assert.deepStrictEqual(registered(spies).map((a) => a.displayName), ['Salon', 'Chambre']);
    assert.strictEqual(platform['accessoryHandlers'].length, 2);
    assert.strictEqual(platform['discoveryRetryTimer'], null, 'discovery counted as a success');
  } finally {
    platform['cleanup']();
  }
});

test('a unit whose secrets did not come back is skipped and named', async () => {
  const warns: string[] = [];
  const { platform, spies } = makePlatform();
  platform.log.warn = (...args: unknown[]) => warns.push(args.join(' '));
  try {
    await platform.discoverDevices();

    assert.ok(!registered(spies).some((a) => a.displayName === 'Bureau'),
      'with no cloud control path in this region it would be a permanently dead tile');
    const named = warns.filter((w) => w.includes(SERIAL_NO_SECRETS));
    assert.strictEqual(named.length, 1, 'said once, by serial');
    assert.ok(!named[0].includes(SENTINELS.passwordA), 'and never quotes a value');
  } finally {
    platform['cleanup']();
  }
});

test('the secrets are handed to the LAN transport, and never touch config.json', async () => {
  const { platform, local, swept } = makePlatform();
  try {
    await platform.discoverDevices();

    // The unit whose tree carried an `address` is seeded outright.
    assert.deepStrictEqual(local.creds.get(SERIAL_B), {
      ip: ADDRESS_B,
      password: SENTINELS.passwordB,
      cryptoSerial: SENTINELS.cryptoSerialB,
    });
    // The one without goes to the existing sweep, with its credentials.
    assert.strictEqual(local.creds.has(SERIAL_A), false);
    assert.strictEqual(swept.length, 1, 'the existing discovery seam is reused, not replaced');
    assert.deepStrictEqual([...swept[0].keys()], [SERIAL_A]);
    assert.deepStrictEqual(swept[0].get(SERIAL_A), {
      password: SENTINELS.passwordA,
      cryptoSerial: SENTINELS.cryptoSerialA,
    });

    assert.strictEqual(platform.kumoConfig.localDevices, undefined,
      'nothing is written back: a restart signs in again');
  } finally {
    platform['cleanup']();
  }
});

test('a configured IP override wins over the address the cloud reported', async () => {
  const { platform, local, swept } = makePlatform({
    localControlIps: { [SERIAL_B]: '192.168.9.99' },
  });
  try {
    await platform.discoverDevices();
    assert.strictEqual(local.creds.get(SERIAL_B)?.ip, '192.168.9.99');
    assert.deepStrictEqual([...swept[0].keys()], [SERIAL_A], 'and it still skips the sweep');
  } finally {
    platform['cleanup']();
  }
});

test('the LAN poller is started, since it is the only status source in this mode', async () => {
  const { platform, pollerStarts } = makePlatform();
  try {
    await platform.discoverDevices();
    assert.strictEqual(pollerStarts.length, 1);
  } finally {
    platform['cleanup']();
  }
});

test('excludeDevices hides a v2-discovered unit, credentials and all', async () => {
  const { platform, local, spies } = makePlatform({ excludeDevices: [SERIAL_B] });
  try {
    await platform.discoverDevices();
    assert.deepStrictEqual(registered(spies).map((a) => a.displayName), ['Salon']);
    assert.strictEqual(local.creds.has(SERIAL_B), false);
    assert.deepStrictEqual(platform['localSerials'], [SERIAL_A]);
  } finally {
    platform['cleanup']();
  }
});

// ---- the real profile ---------------------------------------------------

test('the REAL profile replaces the synthetic one, per unit', async () => {
  const { platform, kumo } = makePlatform();
  try {
    await platform.discoverDevices();

    assert.deepStrictEqual(kumo.profiles.map((p) => p.serial), [SERIAL_A, SERIAL_B]);
    const salon = kumo.profiles[0].profile;
    assert.strictEqual(salon.numberOfFanSpeeds, 5, 'discovered, not declared');
    assert.strictEqual(salon.hasModeDry, true);
    assert.strictEqual(salon.hasModeVent, true);
    assert.strictEqual(salon.usesSetPointInDryMode, true);

    const chambre = kumo.profiles[1].profile;
    assert.strictEqual(chambre.hasModeHeat, false, 'a cooling-only unit, per unit');
    assert.deepStrictEqual(chambre.minimumSetPoints, { cool: 15, heat: 9, auto: 15 });
  } finally {
    platform['cleanup']();
  }
});

test('the heating floor reaches HomeKit as 10 °C, not as the cooling floor', async () => {
  // End to end, and the reason the mapping is per-mode. A synthetic profile has one
  // `minSetPoint` for all three modes, so this characteristic was published with
  // minValue 16 (60.8 °F) on a unit that can hold 10 °C (50 °F) — and hap-nodejs
  // answers a client write below minValue with -70410 rather than clamping it, so
  // "hold 50 °F while away" simply cannot be asked for.
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    const heaterCooler = registered(spies)[0].getService(Service.HeaterCooler);
    assert.ok(heaterCooler, 'the climate service was published');

    const heat = heaterCooler.chars.get(Characteristic.HeatingThresholdTemperature);
    assert.deepStrictEqual(heat?.props, { minValue: 10, maxValue: 31, minStep: 0.1 });

    const cool = heaterCooler.chars.get(Characteristic.CoolingThresholdTemperature);
    assert.deepStrictEqual(cool?.props, { minValue: 16, maxValue: 31, minStep: 0.1 },
      'and the cooling floor is untouched by the heating one');
  } finally {
    platform['cleanup']();
  }
});

test('the Dry and Fan tiles stay OPT-IN even though the v2 profile reports both', async () => {
  // The rule that separates this mode from local-only. There the capability is
  // hand-written per unit, so the declaration implies the tile; here it is
  // discovered, and dry and vent are true on ordinary hardware — so an implicit
  // tile would give every Canadian user two tiles they never asked for, which is
  // exactly the Home-app clutter the cloud path was made opt-in to avoid.
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    const salon = registered(spies)[0];
    assert.strictEqual(salon.getServiceById(Service.Switch, 'dry'), null);
    assert.strictEqual(salon.getServiceById(Service.Switch, 'fan-only'), null);
  } finally {
    platform['cleanup']();
  }
});

test('asking for the Dry tile still gets it', async () => {
  const { platform, spies } = makePlatform({ showDrySwitch: true, showFanOnlySwitch: true });
  try {
    await platform.discoverDevices();
    const salon = registered(spies)[0];
    assert.ok(salon.getServiceById(Service.Switch, 'dry'), 'the unit reports dry, and it was asked for');
    assert.ok(salon.getServiceById(Service.Switch, 'fan-only'));

    const chambre = registered(spies)[1];
    assert.strictEqual(chambre.getServiceById(Service.Switch, 'dry'), null,
      'and a unit that cannot dehumidify gets no tile regardless');
  } finally {
    platform['cleanup']();
  }
});

test('the cloud snapshot seeds the tile so it is not blank until the first LAN poll', async () => {
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    const heaterCooler = registered(spies)[0].getService(Service.HeaterCooler);
    assert.strictEqual(
      heaterCooler?.chars.get(Characteristic.CurrentTemperature)?.value,
      21.5,
      'the room temperature the v2 reply carried',
    );

    const chambre = registered(spies)[1].getService(Service.HeaterCooler);
    assert.strictEqual(
      chambre?.chars.get(Characteristic.CurrentTemperature)?.value,
      undefined,
      'and a unit whose condition was empty seeds nothing at all',
    );
  } finally {
    platform['cleanup']();
  }
});

// ---- the v3 API is still forbidden --------------------------------------

test('discovery makes no v3 call whatsoever, and exactly one v2 sign-in', async () => {
  const { platform, kumo, logins } = makePlatform();
  try {
    await platform.discoverDevices();
    assert.deepStrictEqual(kumo.cloudCalls, [],
      'login/getSites/getZones/startStreaming must all stay untouched');
    assert.strictEqual(logins.length, 1, 'v2 is a bootstrap, not a poller');
  } finally {
    platform['cleanup']();
  }
});

test('no site poller is started, even though a v2 account HAS a real site id', async () => {
  // The hazard this closes: a real site id in accessory context is one mistake away
  // from GET /v3/sites/<v2-id>/zones, which would look plausible in a log. The
  // accessory is given the local-only stand-in instead, and the poller is guarded.
  const { platform, kumo, spies } = makePlatform({ disablePolling: false });
  try {
    await platform.discoverDevices();
    platform['startSitePoller']('local-only');
    await platform['pollSite']('local-only');

    assert.strictEqual(platform['sitePollers'].size, 0);
    assert.deepStrictEqual(kumo.cloudCalls, []);
    assert.strictEqual(registered(spies)[0].context.device.siteId, 'local-only');
  } finally {
    platform['cleanup']();
  }
});

test('a failed LAN command is NOT retried against the cloud in this region', async () => {
  // The same leak local-only closed, for the other reason: v3 answers a Canadian
  // account HTTP 500, so a fallback is not a slower path but a guaranteed failure
  // preceded by a login attempt.
  const cloudCommands: Commands[] = [];
  const localCommands: Commands[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { cloudRegion: 'ca', username: 'user@example.com', password: 'secret' },
    localClient: {
      hasLocal: () => true,
      async sendCommand(_serial: string, commands: Commands) {
        localCommands.push(commands);
        return false; // the adapter takes about one connection at a time
      },
      async getStatus() {
        return null;
      },
    },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    async sendCommand(_serial: string, commands: Commands) {
      cloudCommands.push(commands);
      return true;
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never, makeAccessory('Salon', SERIAL_A) as never, kumoAPI as never, 30,
  );

  await assert.rejects(() => handler.setActive(Characteristic.Active.INACTIVE));
  assert.strictEqual(localCommands.length, 1, 'local was attempted');
  assert.deepStrictEqual(cloudCommands, [], 'and nothing fell through to v3');
});

// ---- failure handling ---------------------------------------------------

test('a refused sign-in is reported once and NOT retried', async () => {
  // Re-posting rejected credentials every 30s to 5min risks locking the account,
  // and no amount of waiting fixes a wrong password.
  const errors: string[] = [];
  const { platform, logins } = makePlatform({}, {
    outcome: { fatal: true, reason: 'mesca-prod.kumocloud.com answered HTTP 401' },
  });
  platform.log.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    await platform.discoverDevices();

    assert.strictEqual(platform['discoveryRetryTimer'], null, 'no retry queued');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /401/);
    assert.match(errors[0], /cloudRegion/, 'and names the setting that decides the host');

    await platform.discoverDevices();
    assert.strictEqual(logins.length, 1, 'and it does not sign in again');
  } finally {
    platform['cleanup']();
  }
});

test('a transient failure IS retried, with the usual backoff', async () => {
  const { platform } = makePlatform({}, {
    outcome: { fatal: false, reason: 'mesca-prod.kumocloud.com answered HTTP 500' },
  });
  try {
    await platform.discoverDevices();
    assert.notStrictEqual(platform['discoveryRetryTimer'], null, 'the existing 30s -> 5min retry');
    assert.strictEqual(platform['accessoryHandlers'].length, 0);
  } finally {
    platform['cleanup']();
  }
});

test('a retry is idempotent: no unit is registered twice', async () => {
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    await platform.discoverDevices();
    assert.strictEqual(platform['accessoryHandlers'].length, 2);
    assert.strictEqual(registered(spies).length, 2);
  } finally {
    platform['cleanup']();
  }
});

// ---- the hybrid: v3 control, v2 secrets --------------------------------

test('the v2 secrets are filtered to the units v3 actually discovered', async () => {
  // The majority case since 2026-07-31: v3 control works, v3 just no longer serves
  // the secrets. A unit that exists on only one of the two backends is ignored
  // rather than half-registered.
  const { platform } = makePlatform({ cloudRegion: undefined, localCredentialSource: 'v2' });
  try {
    const creds = await platform['gatherV2Creds']([SERIAL_A, 'SOMEOTHERUNIT']);
    assert.deepStrictEqual([...creds.keys()], [SERIAL_A]);
    assert.deepStrictEqual(creds.get(SERIAL_A), {
      password: SENTINELS.passwordA,
      cryptoSerial: SENTINELS.cryptoSerialA,
    });
  } finally {
    platform['cleanup']();
  }
});

test('the credential retry starts a quarter of an hour out for a v2 source', async () => {
  // A v2 sign-in is a full authentication whose reply is complete, so re-asking
  // within a minute — the v3 socket-nudge cadence — cannot produce anything new.
  const v2 = makePlatform({ cloudRegion: undefined, localCredentialSource: 'v2' });
  const v3 = makePlatform({ cloudRegion: undefined, localCredentialSource: undefined });
  try {
    assert.strictEqual(v2.platform['localCredRetryDelayMs'], 900000);
    assert.strictEqual(v3.platform['localCredRetryDelayMs'], 60000);
  } finally {
    v2.platform['cleanup']();
    v3.platform['cleanup']();
  }
});

test('a refused v2 sign-in stops the credential retry too', async () => {
  const { platform } = makePlatform({ cloudRegion: undefined, localCredentialSource: 'v2' }, {
    outcome: { fatal: true, reason: 'geo-c.kumocloud.com answered HTTP 403' },
  });
  try {
    platform['localSerials'] = [SERIAL_A];
    assert.strictEqual((await platform['gatherV2Creds']([SERIAL_A])).size, 0);

    platform['scheduleLocalCredRetry']();
    assert.strictEqual(platform['localCredRetryTimer'], null, 'no pass is queued');
  } finally {
    platform['cleanup']();
  }
});

// ---- a degraded reply must not cost the user their accessories -----------

test('a unit whose secrets came back empty KEEPS its cached accessory', async () => {
  // The provider-side failure this feature exists to work around, arriving one unit
  // at a time: the tree still lists Chambre, names it and profiles it, but its
  // `password`/`cryptoSerial` came back empty (the v3 cloud did exactly this to
  // everyone on 2026-07-31, pykumo #78, and a v2 store can go stale the same way).
  //
  // An uncredentialed unit gets no accessory, so it looks identical to a unit that
  // has DISAPPEARED unless the sweep is told otherwise — and unregistering is
  // destructive: the room assignment, the custom name and every automation go with
  // it, and the next restart brings the unit back as a brand-new accessory.
  const inventory = parseV2Login(makeV2Reply({ noSecrets: [SERIAL_B] }));
  const { platform, spies } = makePlatform({}, { outcome: { fatal: false, inventory } });
  try {
    restoreFromCache(platform, 'Salon', SERIAL_A);
    restoreFromCache(platform, 'Chambre', SERIAL_B);

    await platform.discoverDevices();

    assert.deepStrictEqual(unregistered(spies), [],
      'a unit the tree still lists is not stale, whatever its secrets came back as');
    assert.strictEqual(platform.accessories.length, 2, 'and it is still ours to re-admit later');
    // The half of the account that IS credentialed must work exactly as before.
    assert.deepStrictEqual(
      platform['accessoryHandlers'].map((h: KumoThermostatAccessory) => h.getDeviceSerial()), [SERIAL_A],
      'only the credentialed unit gets a handler',
    );
  } finally {
    platform['cleanup']();
  }
});

test('an accessory whose unit has vanished from the v2 tree IS still unregistered', async () => {
  // The control for the test above: retaining is about units the reply still
  // mentions. A unit that is genuinely gone — sold, decommissioned, moved to another
  // account — must still be swept, or it lingers in the Home app forever.
  const { platform, spies } = makePlatform();
  try {
    restoreFromCache(platform, 'Ancien salon', 'GONEUNIT0001');

    await platform.discoverDevices();

    assert.deepStrictEqual(unregistered(spies).map((a) => a.UUID), ['uuid-GONEUNIT0001']);
    assert.strictEqual(platform.accessories.length, 2, 'and it is dropped from our own list too');
  } finally {
    platform['cleanup']();
  }
});

test('excludeDevices still unregisters the cached accessory it hides', async () => {
  // Retaining must not defeat excludeDevices: hiding the unit from HomeKit is the
  // whole point of the option, so its accessory going away is the intended outcome
  // rather than collateral damage.
  const { platform, spies } = makePlatform({ excludeDevices: [SERIAL_B] });
  try {
    restoreFromCache(platform, 'Chambre', SERIAL_B);

    await platform.discoverDevices();

    assert.deepStrictEqual(unregistered(spies).map((a) => a.UUID), [`uuid-${SERIAL_B}`]);
  } finally {
    platform['cleanup']();
  }
});

// ---- the hybrid, end to end --------------------------------------------

test('a US account really does route v3-discovered units through the v2 secrets', async () => {
  // The majority case since 2026-07-31, exercised through the actual discovery path
  // rather than by inspecting derived flags or by calling gatherV2Creds directly.
  //
  // Two one-line mutations would otherwise make the whole option INERT with every
  // test still green: dropping `|| this.localCredentialSource === 'v2'` from the
  // initLocalControl trigger (local control never starts), and dropping the
  // `if (this.localCredentialSource === 'v2') return this.gatherV2Creds(...)`
  // dispatch from gatherCreds (the v3 socket nudge runs instead, and the cloud no
  // longer answers it). Either one leaves a user whose config config-validation
  // declares valid with no local control and nothing in the log about it.
  const { platform, kumo, local, swept } = makePlatform({
    cloudRegion: undefined,
    localCredentialSource: 'v2',
  });
  kumo.getSites = async () => {
    kumo.cloudCalls.push('getSites');
    return [{ id: 'site-1', name: 'Home' }];
  };
  kumo.getZones = async () => {
    kumo.cloudCalls.push('getZones');
    return [{ isActive: true, name: 'Salon', adapter: { deviceSerial: SERIAL_A } } as unknown as Zone];
  };
  try {
    await platform.discoverDevices();
    // initLocalControl is deliberately fire-and-forget (it must never block
    // discovery), so give its microtasks a turn before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(kumo.cloudCalls.includes('startStreaming'), 'v3 still does discovery and streaming');
    assert.deepStrictEqual(platform['localSerials'], [SERIAL_A], 'local control was set up');
    assert.deepStrictEqual(kumo.cloudCalls.filter((c) => c === 'requestAdapterStatus'), [],
      'and it did NOT nudge the v3 socket for a password v3 no longer serves');
    assert.strictEqual(swept.length, 1, 'the v2 credentials reached the existing LAN seam');
    assert.deepStrictEqual(swept[0].get(SERIAL_A), {
      password: SENTINELS.passwordA,
      cryptoSerial: SENTINELS.cryptoSerialA,
    });
    assert.strictEqual(local.creds.has(SERIAL_A), false, 'no address in the reply: the sweep resolves it');
  } finally {
    platform['cleanup']();
  }
});

// ---- the kill switch is WIRED, not merely available --------------------

test('a real platform in cloudRegion "ca" arms the v3 kill switch on its own KumoAPI', async () => {
  // Every other platform test replaces `platform.kumoAPI` with a stub, and
  // kumo-v2.test.ts arms `cloudDisabled` by hand — between them they prove that the
  // switch works when armed, never that this mode arms it. The 6th constructor
  // argument could be changed to `!!kumoConfig.localOnly`, or to `false`, and the
  // suite stayed green: the mode's central promise rests on one untested expression.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    calls.push(String(input));
    return Promise.reject(new Error('the v3 API must not be contacted for a Canadian account'));
  }) as never;

  const spies: Spies = { register: [], update: [], unregister: [] };
  const platform = new KumoV3Platform(
    makeLog() as never,
    { ...CA_CONFIG } as unknown as PlatformConfig,
    makeApi(spies) as never,
  );
  // The instance the platform built for itself — no stub anywhere in this test.
  const api = (platform as unknown as { kumoAPI: KumoAPI }).kumoAPI;
  try {
    assert.strictEqual(await api.login(), false, 'v3 login refuses');
    assert.strictEqual(await api.startStreaming([SERIAL_A]), false, 'streaming refuses');
    assert.strictEqual(await api.sendCommand(SERIAL_A, { operationMode: 'off' }), false);
    assert.deepStrictEqual(await api.getSites(), []);
    assert.deepStrictEqual(await api.getZones('site-1'), []);
    assert.deepStrictEqual(calls, [], 'not one request left the process');
  } finally {
    platform['cleanup']();
    globalThis.fetch = realFetch;
  }
});

test('the account temperature unit seeds a NEW accessory', async () => {
  const { platform, spies } = makePlatform();
  try {
    await platform.discoverDevices();
    // The fixture account is Celsius (root[1].celsius === true).
    const created = registered(spies);
    for (const accessory of created) {
      // The real accessory context is an arbitrary bag; the fake types only the
      // key it needed until now.
      const ctx = accessory.context as unknown as Record<string, unknown>;
      assert.strictEqual(ctx.displayUnits, 'C',
        `${accessory.displayName} should start on the account's unit, not HomeKit's Fahrenheit default`);
    }
    assert.ok(created.length > 0, 'and something was actually registered');
  } finally {
    platform['cleanup']();
  }
});

test('a restart does NOT undo a unit the user picked in HomeKit', async () => {
  // setTemperatureDisplayUnits persists the choice into this same context key, so
  // re-applying the cloud's answer on every restart would silently revert it. The
  // seed is a default for a first run, never a correction.
  const { platform, spies } = makePlatform();
  try {
    const uuid = platform.api.hap.uuid.generate(SERIAL_B);
    const cached = {
      UUID: uuid,
      displayName: 'Cached',
      context: { displayUnits: 'F' } as Record<string, unknown>,
      getService: () => undefined,
      getServiceById: () => undefined,
      addService: () => ({ setCharacteristic: () => ({}), getCharacteristic: () => ({ onGet: () => ({ onSet: () => ({}) }) }) }),
      services: [],
    };
    platform.accessories.push(cached as never);

    await platform.discoverDevices();

    assert.strictEqual(cached.context.displayUnits, 'F',
      "the user's explicit Fahrenheit survives a sign-in on a Celsius account");
    assert.deepStrictEqual(registered(spies).map((a) => a.UUID).includes(uuid), false,
      'and it was restored, not re-registered');
  } finally {
    platform['cleanup']();
  }
});
