// Regression test: an "AC on" scene must not lose the setpoints it pushes.
//
// The exact mirror of off-scene-setpoint-race.test.ts. A HomeKit scene captures an
// accessory's whole tile, so an ON scene re-pushes Active=ACTIVE together with the
// captured setpoints, dispatched concurrently in arbitrary order.
//
// setThresholdTemperature guarded its entry on shouldSuppressSetpoint(), which is
// true for a unit that is merely off — and setActive marks the unit on only AFTER
// its command resolves. So every setpoint in the burst read `power === 0`, was
// cached and echoed to HomeKit, and never reached the adapter. Only the mode
// landed: the unit ran at its previously stored setpoint while the Home app showed
// the requested one, until a poll snapped the tile back. No error, no revert.
//
// Fix: the entry guard checks offInFlight() — an off IN FLIGHT, the 1.7.2 case —
// and leaves the merely-off case to the post-hold re-check, which reaches the same
// verdict 1.5s later except when the same burst has since powered the unit on.
// The controls below pin down that nothing was traded away for it.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

interface SentCommand {
  serial: string;
  commands: Commands;
}

/** `reject` decides which commands the device refuses, to test a failed power-on. */
function makeHarness(reject: (c: Commands) => boolean = () => false) {
  const sendCommandCalls: SentCommand[] = [];
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
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(!reject(commands));
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    makeAccessory('Living room') as never,
    kumoAPI as never,
    30,
  );
  return { handler, sendCommandCalls };
}

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

const isMode = (c: SentCommand) => c.commands.operationMode !== undefined;
const isSetpoint = (c: SentCommand) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;

test('AC-on scene: the setpoint dispatched with the power-on reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spCool: 25 }));

  // The captured tile: on, and the setpoint the scene recorded. Fired concurrently
  // to mirror HomeKit's dispatch — setActive's optimistic power=1 has not landed
  // when the setpoint handler runs its entry guard.
  await Promise.all([
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setCoolingThresholdTemperature(22),
  ]);

  const spIdx = sendCommandCalls.findIndex(isSetpoint);
  assert.ok(
    spIdx >= 0,
    'the setpoint must reach the device, or the unit runs at its old one. Got: '
      + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
  const modeIdx = sendCommandCalls.findIndex(isMode);
  assert.ok(modeIdx >= 0 && modeIdx < spIdx,
    'and it must follow the power-on, never precede it');
});

test('AC-on scene: the order the characteristics arrive in does not matter', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spCool: 25 }));

  // Same burst, setpoint dispatched first. HomeKit gives no ordering guarantee.
  await Promise.all([
    handler.setCoolingThresholdTemperature(22),
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.COOL),
  ]);

  assert.ok(sendCommandCalls.some(isSetpoint),
    'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)));
});

// ---- controls: nothing was traded away ------------------------------------

test('a setpoint alone on a merely-off unit is still never sent', async () => {
  // The 1.5.2/1.7.2 protection. A bare mode-less setpoint revives the unit over the
  // LAN, so an idle unit must stay idle — now decided after the hold instead of
  // before it, which is 1.5s later and the same answer.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setCoolingThresholdTemperature(22);

  assert.deepStrictEqual(sendCommandCalls, [], 'an idle unit is not revived by a setpoint');
});

test('a setpoint trailing an off in the same burst is still never sent', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  await Promise.all([
    handler.setActive(Characteristic.Active.INACTIVE),
    handler.setCoolingThresholdTemperature(22),
  ]);

  const offIdx = sendCommandCalls.findIndex((c) => c.commands.operationMode === 'off');
  assert.ok(offIdx >= 0, 'the off itself still goes out');
  assert.ok(
    !sendCommandCalls.slice(offIdx + 1).some(isSetpoint),
    'nothing may follow the off. Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
});

test('if the power-on FAILS, the setpoint in the same burst is not sent either', async () => {
  // The failure the deferred decision has to get right: the cache stays power=0, so
  // the post-hold re-check suppresses, and no bare setpoint revives a unit that
  // never came on.
  const { handler, sendCommandCalls } = makeHarness((c) => c.operationMode !== undefined);
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await Promise.all([
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setCoolingThresholdTemperature(22),
  ]);

  assert.ok(!sendCommandCalls.some(isSetpoint),
    'the unit never came on, so the setpoint must not go out alone. Got: '
      + JSON.stringify(sendCommandCalls.map((c) => c.commands)));
});
