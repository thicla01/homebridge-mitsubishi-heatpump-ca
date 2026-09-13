// Regression test: a unit the plugin cannot reach must stop answering HomeKit.
//
// 2026-09-10, from the field. The adapter stopped talking to us at 14:02:40. The
// log noticed within forty-five seconds and said so. The Home app said nothing at
// all: the tile kept showing that afternoon's temperature, correctly formatted and
// completely false, for the rest of the day. Every getter answered from
// `currentStatus`, and `currentStatus` cannot tell "this is the unit's state" from
// "this is the last thing the unit said, hours ago" — it presents both the same
// way. A frozen number is worse than no number, because nobody re-checks a reading
// that looks fine.
//
// That weighs more in this fork than upstream. Under `cloudRegion: "ca"` (and
// `localOnly`) the LAN is the ONLY transport, so no second source ever arrives to
// correct the tile — which is why the platform arms this in those modes only. With
// a live cloud a LAN stutter is not an outage, and flapping No Response over a tile
// the cloud is keeping current would be its own kind of lie.
//
// Two halves, matching where the decision is made:
//   * the accessory owns the state and the guard — pinned by enumerating the
//     handlers off the prototype, so a getter added later without the guard fails
//     this file rather than shipping a lying characteristic;
//   * the platform owns the DECISION to arm it, which is a mode question and is
//     driven here against both modes. The poll-loop-to-accessory path itself is
//     end-to-end in local-only.test.ts, on the real poller.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';
import { HAPStatus, HapStatusError } from '@homebridge/hap-nodejs';

import { KumoV3Platform } from '../dist/platform.js';
import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, DeviceStatus } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = '1234A5678901234B';
const LIVE: Partial<DeviceStatus> = {
  roomTemp: 22, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20,
};

/**
 * The `get*` methods that are NOT characteristic handlers, and must keep working
 * while the unit is unreachable.
 *
 * One of them is load bearing for that: `noteLocalPollFailure` calls
 * `getDeviceSerial()` on the very handler it is about to mark, so a blanket guard
 * over everything named `get*` would throw inside the marking itself.
 * `getThresholdTemperature` is a private helper the two threshold handlers share —
 * they are guarded, so it needs no guard of its own.
 *
 * Named rather than pattern-matched on purpose: `everyGetterIsAccountedFor` below
 * pins that these plus the enumerated handlers are ALL of them, so a new `get*`
 * has to be classified by a human instead of quietly falling through whichever
 * filter happens not to catch it.
 */
const NOT_CHARACTERISTIC_HANDLERS = ['getSiteId', 'getDeviceSerial', 'getThresholdTemperature'];

function allGetters(): string[] {
  return Object.getOwnPropertyNames(KumoThermostatAccessory.prototype)
    .filter((n) => /^get[A-Z]/.test(n));
}

/**
 * The characteristic handlers, found by the one signature they all share:
 * `async getX(): Promise<CharacteristicValue>`, taking nothing. That is what
 * HomeKit's `onGet` binds to, so it is what has to refuse.
 */
function characteristicGetters(): string[] {
  const proto = KumoThermostatAccessory.prototype as unknown as Record<string, unknown>;
  return allGetters().filter((n) => {
    const fn = proto[n];
    return typeof fn === 'function'
      && fn.constructor.name === 'AsyncFunction'
      && fn.length === 0;
  });
}

test('every getter on the accessory is accounted for, one way or the other', () => {
  // The seam between the two lists. Without this, a handler that stopped matching
  // the signature filter — or a new `get*` helper — would silently leave the
  // enumeration and take its coverage with it, with nothing failing.
  const unclassified = allGetters()
    .filter((n) => !characteristicGetters().includes(n))
    .filter((n) => !NOT_CHARACTERISTIC_HANDLERS.includes(n));
  assert.deepStrictEqual(unclassified, [],
    'a new get* must be either a guarded characteristic handler or named as exempt');
});

function makeHandler({ withHap = false } = {}) {
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    // `withHap` supplies the real hap-nodejs classes, as Homebridge does (api.hap
    // IS the hap-nodejs module). Off by default so the rest of the file also
    // exercises the fallback for a platform fake without them.
    api: {
      updatePlatformAccessories() {},
      ...(withHap
        ? {
          hap: {
            HapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
          },
        }
        : {}),
    },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(_serial: string, _commands: Commands) {
      return Promise.resolve(true);
    },
  };
  return new KumoThermostatAccessory(
    platform as never, makeAccessory('Salon', SERIAL) as never, kumoAPI as never, 30,
  );
}

/** Call a getter by name, whatever its declared shape. */
function read(handler: KumoThermostatAccessory, name: string): Promise<unknown> {
  return (handler as unknown as Record<string, () => Promise<unknown>>)[name]!.call(handler);
}

test('the enumeration finds the whole characteristic surface', () => {
  // Guards the guard: if this ever came back empty — a rename, a refactor that
  // moved the handlers off the prototype — every assertion below would pass
  // vacuously while nothing at all was covered.
  const names = characteristicGetters();
  assert.ok(names.length >= 15, `expected the full handler surface, found ${names.length}`);
  for (const required of ['getCurrentTemperature', 'getActive', 'getCoolingThresholdTemperature']) {
    assert.ok(names.includes(required), `${required} must be in the enumeration`);
  }
});

test('every characteristic handler refuses to answer once the unit is unreachable', async () => {
  const handler = makeHandler();
  handler.updateFromLocal(LIVE);

  // Control first: with a fresh status they all answer, so the rejections below
  // are the guard and not some unrelated breakage.
  for (const name of characteristicGetters()) {
    await assert.doesNotReject(() => read(handler, name), `${name} answers a reachable unit`);
  }

  handler.setUnreachable('no answer on the LAN');

  for (const name of characteristicGetters()) {
    await assert.rejects(
      () => read(handler, name),
      `${name} answered from a cache the unit stopped backing — that is the frozen tile`,
    );
  }
});

test('the platform-facing getters keep working while unreachable', () => {
  // noteLocalPollFailure calls getDeviceSerial() on the handler it is marking, so
  // a blanket guard over every `get*` would have thrown inside the marking itself.
  const handler = makeHandler();
  handler.setUnreachable('no answer on the LAN');

  assert.strictEqual(handler.getDeviceSerial(), SERIAL);
  assert.doesNotThrow(() => handler.getSiteId());
});

test('the refusal reaches HomeKit as a communication failure, not a bare error', async () => {
  // Not just any rejection: HAP maps this status onto the wire, and it is what
  // makes the Home app show "No Response" rather than a silent read failure.
  const handler = makeHandler({ withHap: true });
  handler.updateFromLocal(LIVE);
  handler.setUnreachable('no answer on the LAN');

  await assert.rejects(
    () => handler.getCurrentTemperature(),
    (err: unknown) => {
      assert.strictEqual(
        (err as { hapStatus?: number }).hapStatus,
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      return true;
    },
  );
});

test('a status from any transport lifts the refusal and republishes the real value', async () => {
  const handler = makeHandler();
  handler.updateFromLocal(LIVE);
  handler.setUnreachable('no answer on the LAN');
  await assert.rejects(() => handler.getCurrentTemperature());

  handler.updateFromLocal({ ...LIVE, roomTemp: 19.5 });

  assert.strictEqual(await handler.getCurrentTemperature(), 19.5,
    'the unit is answering again, so the tile must show what it says');
});

test('clearing an outage that never happened is a no-op', () => {
  const handler = makeHandler();
  handler.clearUnreachable();
  assert.doesNotThrow(() => handler.getSiteId());
});

// ---- the platform's half: WHICH modes arm it -----------------------------

function makePlatformWith(config: Partial<PlatformConfig>) {
  const api = {
    hap: { Service, Characteristic, uuid: { generate: (s: string) => `uuid-${s}` } },
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
  return new KumoV3Platform(
    makeLog() as never,
    { name: 'test', platform: 'KumoV3', ...config } as unknown as PlatformConfig,
    api as never,
  );
}

/** Drive the failure bookkeeping directly, `times` polls in a row. */
function fail(platform: KumoV3Platform, handler: KumoThermostatAccessory, times: number) {
  for (let i = 0; i < times; i++) {
    (platform as unknown as {
      noteLocalPollFailure(h: KumoThermostatAccessory, reason: string): void;
    }).noteLocalPollFailure(handler, 'no answer from the unit');
  }
}

test('local-only arms the outage, and only after the streak is established', async () => {
  const platform = makePlatformWith({
    localOnly: true,
    localDevices: [{
      deviceSerial: SERIAL, name: 'Salon', ip: '192.168.6.11',
      password: 'cGFzc3dvcmQ=', cryptoSerial: '0123456789abcdef0123',
    }],
  });
  const handler = makeHandler();
  handler.updateFromLocal(LIVE);
  try {
    fail(platform, handler, 2);
    await assert.doesNotReject(() => handler.getCurrentTemperature(),
      'a single dropped read is routine — the adapter takes one connection at a time');

    fail(platform, handler, 1);
    await assert.rejects(() => handler.getCurrentTemperature(),
      'three in a row is the threshold the warning already uses');
  } finally {
    platform['cleanup']();
  }
});

test('a unit that answers is no longer unreachable, even if we keep nothing it said', async () => {
  // Why the flag is cleared in the poller as well as at the accessory's commit
  // point. The commit is what normally lifts it — but processZoneUpdate drops
  // updates on purpose inside the post-write hold window, and a unit that just
  // answered a poll is not unreachable whether or not we kept its reading. Without
  // this the tile would stay No Response for another poll interval after recovery.
  const platform = makePlatformWith({
    localOnly: true,
    localDevices: [{
      deviceSerial: SERIAL, name: 'Salon', ip: '192.168.6.11',
      password: 'cGFzc3dvcmQ=', cryptoSerial: '0123456789abcdef0123',
    }],
  });
  const handler = makeHandler();
  handler.updateFromLocal(LIVE);
  try {
    fail(platform, handler, 3);
    await assert.rejects(() => handler.getCurrentTemperature());

    (platform as unknown as {
      noteLocalPollSuccess(h: KumoThermostatAccessory): void;
    }).noteLocalPollSuccess(handler);

    await assert.doesNotReject(() => handler.getCurrentTemperature(),
      'the adapter answered — that alone ends the outage');
  } finally {
    platform['cleanup']();
  }
});

test('a cloud-backed mode does NOT arm it on the same streak', async () => {
  // The LAN is a second opinion there, not the only one. Marking the accessory
  // unreachable would flap No Response over a tile the cloud is keeping current —
  // and there is no field report of a US-mode user needing this, while there is
  // one of a ca-mode user staring at a frozen number for a day.
  const platform = makePlatformWith({ username: 'a@b.c', password: 'secret', localControl: true });
  const handler = makeHandler();
  handler.updateFromLocal(LIVE);
  try {
    assert.strictEqual(platform.v3Unavailable, false, 'the premise of this test');

    fail(platform, handler, 5);
    assert.strictEqual(await handler.getCurrentTemperature(), LIVE.roomTemp,
      'the cloud is still feeding this accessory; the tile is not stale');
  } finally {
    platform['cleanup']();
  }
});
