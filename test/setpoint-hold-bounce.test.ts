// Regression test: a poll that lands while a setpoint write is still being held
// must not push the pre-write value to HomeKit.
//
// Observed 2026-08-22 on two simulated units driven from the Homebridge UI:
// dragging the cooling handle from 26 to 22 showed 22, then jumped back to 26,
// then returned to 22 and settled. Three states for one request.
//
// Cause: a setpoint command waits SETPOINT_HOLD_MS (1.5s) before it is sent — that
// hold is what lets an "AC off" dispatched alongside it win — but the guard that
// keeps a fresh write from being overwritten by an in-flight poll was armed only
// once the command had SUCCEEDED. The whole hold, plus the round trip, was
// unprotected, and a local poll runs every 15s, so the collision is routine rather
// than exotic. `currentStatus` could not stand in for the guard's value either: it
// still holds the OLD setpoint during the hold, which is precisely the value that
// must not win.
//
// What this pins is the absence of an intermediate state: the pre-write value must
// never be pushed once HomeKit has asked for a new one. Asserting only the final
// value would pass against the bug, since the bounce settles on the right number.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory, type FakeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

function makeHarness() {
  const sent: Commands[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(_serial: string, commands: Commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  return { handler, accessory, sent };
}

/** Record every value pushed to one characteristic, in order. */
function watch(accessory: FakeAccessory, id: unknown): number[] {
  const svc = accessory.getService(Service.HeaterCooler);
  assert.ok(svc, 'the HeaterCooler service is the primary climate service');
  const seen: number[] = [];
  const original = svc.updateCharacteristic.bind(svc);
  svc.updateCharacteristic = (charId: unknown, value: unknown) => {
    if (charId === id && typeof value === 'number') {
      seen.push(value);
    }
    return original(charId, value);
  };
  return seen;
}

// 26°C is 78.8°F and 22°C is 71.6°F. Neither is a whole °F, so both are quantized
// on the way in; the test compares against the same quantization the plugin
// applies rather than restating the arithmetic, since what it is about is which
// READING wins, not what the value rounds to.
const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'autoCool',
    fanSpeed: null, airDirection: null,
    roomTemp: 24, spCool: 26, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

test('a poll arriving during the hold does not push the old setpoint', async () => {
  const { handler, accessory, sent } = makeHarness();
  handler.updateFromZone(zone({ spCool: 26 }));

  const pushed = watch(accessory, Characteristic.CoolingThresholdTemperature);

  // HomeKit asks for 22. The command is now held for SETPOINT_HOLD_MS.
  const write = handler.setCoolingThresholdTemperature(22);
  // A local poll lands mid-hold, still reporting the value being replaced.
  handler.updateFromZone(zone({ spCool: 26 }));
  await write;

  assert.ok(sent.length === 1, 'the write still reaches the device');
  assert.ok(
    !pushed.includes(26),
    `the pre-write value was pushed to HomeKit during the write: ${pushed.join(' -> ')}`,
  );
});

// This one deliberately spends real time — the guard's window is 4s and the point
// is that it EXPIRES. Arming it earlier (the fix above) widens the interval during
// which the device's own reading is refused, so "it still lets go" is now a
// property worth a slow test: a guard that never released would freeze the tile
// against a setpoint changed on the wall remote, and the failure would look like
// the plugin ignoring the unit rather than like a timer.
test('the poll wins again once the suppression window has passed', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ spCool: 26 }));
  await handler.setCoolingThresholdTemperature(22);

  await new Promise((resolve) => setTimeout(resolve, 4100)); // SETPOINT_POLL_SUPPRESS_MS + margin

  const pushed = watch(accessory, Characteristic.CoolingThresholdTemperature);
  // Someone turned the dial on the wall remote. That has to be believed, or the
  // tile lies about the unit.
  handler.updateFromZone(zone({ spCool: 28 }));

  assert.ok(pushed.includes(28), `a later reading must win: ${pushed.join(' -> ')}`);
});

test('a failed write releases the guard instead of holding a value the unit refused', async () => {
  const sent: Commands[] = [];
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
  };
  const kumoAPI = {
    subscribeToDevice() {}, onDeviceProfileUpdate() {},
    sendCommand(_serial: string, commands: Commands) {
      sent.push(commands);
      return Promise.resolve(false); // the device refuses
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  handler.updateFromZone(zone({ spCool: 26 }));

  await handler.setCoolingThresholdTemperature(22);
  const pushed = watch(accessory, Characteristic.CoolingThresholdTemperature);
  handler.updateFromZone(zone({ spCool: 26 }));

  assert.strictEqual(sent.length, 1, 'the write was attempted');
  assert.ok(
    pushed.includes(26),
    `after a refused write the device's own value must come back: ${pushed.join(' -> ')}`,
  );
});
