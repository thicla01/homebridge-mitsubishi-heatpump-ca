// Regression test: a published accessory with no handler behind it must not
// answer HomeKit with numbers nobody is standing behind.
//
// Homebridge republishes every cached accessory before this plugin has decided
// anything, and HAP keeps serving the characteristic values it persisted. Until
// setupLocalUnits builds a KumoThermostatAccessory, nothing is bound: reads return
// whatever was true when the plugin last ran, writes land nowhere. The tile looks
// alive and is inert — the same lie 2.3.4 fixed for a unit that stops answering,
// in the place where no handler was ever built at all.
//
// Two ways in, and they differ only in how long they last:
//
//   * a unit the v2 tree still lists whose `password`/`cryptoSerial` came back
//     empty. Its accessory is kept ON PURPOSE — unregistering would take the room
//     assignment, the custom name and every automation with it — so the tile is
//     uncontrollable INDEFINITELY. This is the case that justifies the work;
//     v2-bootstrap.test.ts owns it, next to the retention rule it completes.
//   * a restart that lands while the cloud is unreachable. One retry cycle, 30s to
//     5min, then it heals itself. Covered here.
//
// The load-bearing test is neither of those. It is `the placeholder is always
// replaced`: placeholders are never removed, only overwritten, so a characteristic
// the real constructor stopped binding would answer No Response FOREVER — strictly
// worse than the stale value it replaced. That test is what makes the design safe,
// and it proves the replacement by calling the handler rather than reading the
// source.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';
import { HAPStatus, HapStatusError } from '@homebridge/hap-nodejs';

import { KumoV3Platform } from '../dist/platform.js';
import { KumoThermostatAccessory } from '../dist/accessory.js';
import { UNCONFIGURED_GUARD_CHARACTERISTICS } from '../dist/no-response.js';
import type { Commands } from '../dist/settings.js';
import {
  Characteristic, Service, makeLog, makeAccessory,
  type FakeAccessory, type FakeCharacteristic,
} from './helpers';

const SERIAL = '1234A5678901234B';

function makePlatform({ withHap = false } = {}) {
  const api = {
    hap: {
      Service,
      Characteristic,
      uuid: { generate: (s: string) => `uuid-${s}` },
      // Supplied only where a test asserts the HAP status itself; off by default so
      // the rest of the file also exercises the plain-Error fallback.
      ...(withHap
        ? {
          HapStatusError,
          HAPStatus: { SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
        }
        : {}),
    },
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
  return new KumoV3Platform(
    makeLog() as never,
    {
      name: 'test', platform: 'KumoV3', localOnly: true,
      localDevices: [{
        deviceSerial: SERIAL, name: 'Salon', ip: '192.168.6.11',
        password: 'cGFzc3dvcmQ=', cryptoSerial: '0123456789abcdef0123',
      }],
    } as unknown as PlatformConfig,
    api as never,
  );
}

/** The slice of KumoAPI an accessory touches, including the one cleanup() needs. */
function kumoStub() {
  return {
    subscribeToDevice() {},
    unsubscribeFromDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(_serial: string, _commands: Commands) {
      return Promise.resolve(true);
    },
  };
}

/** A cached accessory as one really comes back: already carrying its services. */
function cachedAccessory(name = 'Salon'): FakeAccessory {
  const accessory = makeAccessory(name, SERIAL);
  accessory.addService(Service.HeaterCooler);
  return accessory;
}

function guarded(accessory: FakeAccessory): FakeCharacteristic[] {
  const service = accessory.getService(Service.HeaterCooler)!;
  return UNCONFIGURED_GUARD_CHARACTERISTICS.map(
    (name) => service.getCharacteristic(Characteristic[name]),
  );
}

// ---- the guarantee the whole design rests on -----------------------------

test('the placeholder is always replaced: the real handler binds every guarded characteristic', () => {
  // Placeholders are overwritten, never removed — hap-nodejs's onGet assigns. So a
  // characteristic in the list that the constructor stopped binding would keep the
  // placeholder for the life of the process and report No Response forever.
  //
  // Proven by CALLING what is bound, not by reading accessory.ts: a binding moved
  // behind a condition still looks right in the source.
  const platform = makePlatform();
  const accessory = cachedAccessory();
  try {
    platform['markUnconfigured'](accessory as never, 'nothing yet');
    for (const ch of guarded(accessory)) {
      // `typeof` first, and not as ceremony: calling an undefined getHandler ALSO
      // throws, so a bare assert.throws here passes when no placeholder was ever
      // installed — which is precisely the state this test must not accept as
      // proof. Caught by mutating markUnconfigured into a no-op.
      assert.strictEqual(typeof ch.getHandler, 'function', 'a placeholder was actually installed');
      assert.throws(() => ch.getHandler!(), /nothing yet/, 'and it refuses the read');
    }

    new KumoThermostatAccessory(platform as never, accessory as never, kumoStub() as never, 30);

    UNCONFIGURED_GUARD_CHARACTERISTICS.forEach((name, i) => {
      assert.doesNotThrow(
        () => guarded(accessory)[i].getHandler!(),
        `${name} kept the placeholder — it would answer No Response for the life of the process`,
      );
    });
  } finally {
    platform['cleanup']();
  }
});

test('every guarded characteristic lives on the HeaterCooler and HAP defines it', () => {
  // Guards the guard. A name HAP does not define reads as undefined through the
  // helpers proxy, and markUnconfigured skips it — so a typo would silently shrink
  // the set to nothing while every test above still passed.
  assert.ok(UNCONFIGURED_GUARD_CHARACTERISTICS.length >= 4, 'a real surface, not an empty list');
  for (const name of UNCONFIGURED_GUARD_CHARACTERISTICS) {
    assert.ok(Characteristic[name]?.UUID ?? Object.keys(Characteristic[name]).length,
      `${name} is not a characteristic hap-nodejs defines`);
  }
});

// ---- the behaviour ------------------------------------------------------

test('a handler-less accessory refuses reads instead of serving yesterday', () => {
  const platform = makePlatform();
  const accessory = cachedAccessory();
  try {
    const before = guarded(accessory);
    assert.deepStrictEqual(before.map((ch) => ch.getHandler), before.map(() => undefined),
      'nothing bound yet — this is exactly the state where HAP serves its persisted values');

    platform['markUnconfigured'](accessory as never, 'no local credentials came back');

    for (const ch of guarded(accessory)) {
      assert.throws(() => ch.getHandler!(), /no local credentials came back/);
    }
  } finally {
    platform['cleanup']();
  }
});

test('the refusal reaches HomeKit as a communication failure', () => {
  const platform = makePlatform({ withHap: true });
  const accessory = cachedAccessory();
  try {
    platform['markUnconfigured'](accessory as never, 'no inventory yet');
    assert.throws(
      () => guarded(accessory)[0].getHandler!(),
      (err: unknown) => {
        assert.strictEqual(
          (err as { hapStatus?: number }).hapStatus,
          HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
        return true;
      },
    );
  } finally {
    platform['cleanup']();
  }
});

test('an accessory that was never a heat pump is left alone', () => {
  // A cached accessory with no HeaterCooler is not ours to silence, and
  // getCharacteristic would ADD characteristics to a service that never had them.
  const platform = makePlatform();
  const accessory = makeAccessory('Not a heat pump', SERIAL); // no HeaterCooler
  try {
    assert.doesNotThrow(() => platform['markUnconfigured'](accessory as never, 'nothing yet'));
    assert.strictEqual(accessory.getService(Service.HeaterCooler), null,
      'and no service was manufactured by asking');
  } finally {
    platform['cleanup']();
  }
});

test('marking never throws, whatever shape the accessory turns out to be', () => {
  // Not defensiveness for its own sake: markUnconfigured runs from
  // scheduleDiscoveryRetry, which is reached from didFinishLaunching and from a
  // bare setTimeout. Nothing above either catches, and an escape there takes down
  // every other plugin in the install — see CLAUDE.md, "Never throw from the
  // platform constructor". A tile that keeps lying is the lesser outcome.
  const platform = makePlatform();
  try {
    assert.doesNotThrow(() => platform['markUnconfigured']({
      displayName: 'Broken',
      getService() {
        throw new Error('hap said no');
      },
    } as never, 'nothing yet'));
  } finally {
    platform['cleanup']();
  }
});

// ---- the discovery-retry window -----------------------------------------

test('a discovery that did not complete silences the tiles it could not configure', () => {
  const platform = makePlatform();
  const accessory = cachedAccessory();
  try {
    platform.configureAccessory(accessory as never);
    platform['scheduleDiscoveryRetry']();

    for (const ch of guarded(accessory)) {
      assert.throws(() => ch.getHandler!(), /no inventory yet/,
        'the cloud was unreachable at startup; this tile knows nothing');
    }
  } finally {
    platform['cleanup']();
  }
});

test('a unit that already has a handler is not silenced by another unit failing', () => {
  // Discovery is all-or-nothing per pass, but the accessories are not: a unit that
  // was configured on an earlier pass keeps working while a later pass fails.
  const platform = makePlatform();
  const accessory = cachedAccessory();
  try {
    platform.configureAccessory(accessory as never);
    const handler = new KumoThermostatAccessory(
      platform as never, accessory as never, kumoStub() as never, 30,
    );
    platform['accessoryHandlers'].push(handler);

    platform['scheduleDiscoveryRetry']();

    for (const ch of guarded(accessory)) {
      assert.doesNotThrow(() => ch.getHandler!(),
        'this unit is live; silencing it would be the lie in the other direction');
    }
  } finally {
    platform['cleanup']();
  }
});
