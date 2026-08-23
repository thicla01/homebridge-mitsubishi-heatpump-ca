// Regression test: a threshold write that asks for the value the unit already has
// must send nothing.
//
// Found by driving three simulated units from the Homebridge UI (2026-08-22). Its
// AUTO control is a RANGE slider bound to both handles at once, so moving the
// cooling handle wrote spHeat AND spCool every time — and it fed our echo back
// into its own model, so both kept arriving in pairs every two seconds after the
// user had stopped touching it. One drag produced 14 commands to the adapter, half
// of them re-asserting a value that had not moved.
//
// On these adapters that is not free: they hold roughly one connection, the plugin
// serialises per device, and every redundant write occupies the slot a poll or a
// real command needs. Nothing is echoed for a no-op either — HomeKit already holds
// the value it just sent, and echoing is what re-entered the loop.
//
// The control case matters as much as the fix: a value that genuinely differs must
// still be sent, or the setpoint stops working entirely.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Adapter, Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

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

// A unit running in AUTO with a settled band. Both edges sit on the whole-°F grid
// the quantizer snaps to, so the values below survive it unchanged and the test is
// about the redundancy, not about rounding.
const zone = (over: Partial<Adapter> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'autoCool',
    fanSpeed: null, airDirection: null,
    roomTemp: 23, spCool: 26.2, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

test('a cooling threshold write matching the current value sends nothing', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(26.2);

  assert.deepStrictEqual(sent, [], 'the unit is already at 26.2 — there is nothing to say');
});

test('a heating threshold write matching the current value sends nothing', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setHeatingThresholdTemperature(20);

  assert.deepStrictEqual(sent, [], 'the unit is already at 20 — there is nothing to say');
});

test('moving one handle does not re-send the other, even when both are written', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());

  // Exactly what the Homebridge UI range control does on one adjustment: it writes
  // both edges, only one of which moved.
  await handler.setHeatingThresholdTemperature(20);
  await handler.setCoolingThresholdTemperature(25.6);

  assert.strictEqual(sent.length, 1, 'only the edge that actually moved is sent');
  assert.deepStrictEqual(sent[0], { spCool: 25.6 });
});

test('a threshold write with a different value is still sent', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(25.6);

  assert.strictEqual(sent.length, 1, 'a real change must reach the unit');
  assert.deepStrictEqual(sent[0], { spCool: 25.6 });
});

test('a repeat of a value we just wrote is not sent again', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(25.6);
  await handler.setCoolingThresholdTemperature(25.6);
  await handler.setCoolingThresholdTemperature(25.6);

  assert.strictEqual(sent.length, 1, 'the write is what updates the cache, so repeats are no-ops');
});
