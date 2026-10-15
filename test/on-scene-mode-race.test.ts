// Regression test: Active=ON must not race a scene's mode write.
//
// A HomeKit scene that switches a running unit from COOL to HEAT pushes the whole
// captured tile: TargetHeaterCoolerState=HEAT *and* Active=ON — twice per unit,
// once from the climate tile and once from the fan tile — dispatched concurrently
// in arbitrary order. An ON re-sending the remembered mode raced the scene's own
// mode write, and whichever landed last won. Upstream saw it live on 2026-10-09:
// a 6:30 AM HEAT scene left units in the COOL set the night before. Our narrower
// skip (compare the remembered mode with the cache) already covered most of that
// case, but not a cached 'autoHeat' / 'autoCool', and it swallowed an ON trailing
// an in-flight off.
//
// The same race exists for a unit that is OFF, and that one was ours in full: a
// scene that turns the unit on and picks HEAT sent the ON with the default 'auto'
// beside the 'heat', so in one dispatch order of two the unit ended in AUTO.
// off-guard-mode.test.ts even pinned the [{auto}, {heat}] pair as correct.
//
// Fix, ported from upstream ukaratay/homebridge-mitsubishi-heatpump (ecb59a1,
// be29857): ON for a running unit is a no-op unless an off is in flight; an ON for
// an off unit is held for 1.5s and dropped if a mode write lands within the hold on
// either side of it, since the mode write powers the unit on by itself; and a
// generation counter lets a newer Active write cancel a held ON.
//
// One part is ours. The ON hold is as long as the setpoint hold, so a setpoint in
// an "AC on at 22" scene with no mode write found the unit still off when its own
// hold ran out, and was cached instead of sent — the failure
// on-scene-setpoint-lost.test.ts pins. A held setpoint now waits for any turn-on in
// flight before deciding. The instant harness cannot show any of that, so the last
// group of tests models transport latency and the per-device queue, as
// off-guard-mode.test.ts explains.

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

function makeHarness() {
  const sendCommandCalls: SentCommand[] = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial: string, commands: Commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    makeAccessory('Bedroom') as never,
    kumoAPI as never,
    30,
  );
  return { handler, sendCommandCalls };
}

/**
 * A transport with latency and a per-device queue: each command takes `latencyMs`,
 * strictly one after another, and is recorded when it LANDS. `reject` decides which
 * commands the device refuses.
 */
function makeSlowHarness(latencyMs = 800, reject: (c: Commands) => boolean = () => false) {
  const sendCommandCalls: SentCommand[] = [];
  let lane: Promise<boolean> = Promise.resolve(true);
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial: string, commands: Commands) {
      const mine = { serial, commands: JSON.parse(JSON.stringify(commands)) as Commands };
      lane = lane
        .then(() => new Promise<void>((r) => setTimeout(r, latencyMs)))
        .then(() => {
          sendCommandCalls.push(mine);
          return !reject(mine.commands);
        });
      return lane;
    },
  };
  const handler = new KumoThermostatAccessory(
    platform as never,
    makeAccessory('Salon') as never,
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

const modesSent = (calls: SentCommand[]) =>
  calls.filter((c) => c.commands.operationMode !== undefined).map((c) => c.commands.operationMode);
const isSetpoint = (c: SentCommand) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;

// ---- a running unit ----------------------------------------------------------

test('HEAT scene on a unit running COOL: only the heat command reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  // The order upstream's live log showed: mode first, then two ONs, none awaited.
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  const pOn1 = handler.setActive(Characteristic.Active.ACTIVE);
  const pOn2 = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pMode, pOn1, pOn2]);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'heat' }],
    'no stale cool may be sent alongside the scene\'s heat',
  );
});

test('HEAT scene with the ON dispatched before the mode: still only heat', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  await Promise.all([pOn, pMode]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'heat' }]);
});

test('an ON for a unit running in a reported auto sub-mode sends nothing', async () => {
  // The case the old mode-string skip missed: 'autoHeat' normalises to 'auto', the
  // two strings differ, and a redundant 'auto' went out — racing any mode write.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'autoHeat' }));

  await handler.setActive(Characteristic.Active.ACTIVE);

  assert.deepStrictEqual(sendCommandCalls, []);
});

test('control: an ON right behind an in-flight off still turns the unit back on', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  // The cache still says power=1 while the off is in flight, so a cache-only
  // check would swallow this ON and leave the unit off.
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pOff, pOn]);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'off' }, { operationMode: 'cool' }],
  );
});

// ---- an off unit ---------------------------------------------------------------

test('HEAT scene on an OFF unit, ON first: only heat reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  const pOn1 = handler.setActive(Characteristic.Active.ACTIVE);
  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  const pOn2 = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pOn1, pMode, pOn2]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'heat' }]);
});

test('HEAT scene on an OFF unit, mode first: only heat reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  const pMode = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pMode, pOn]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'heat' }]);
});

test('a Dry or Fan-only switch ON in the burst turns an OFF unit on by itself', async () => {
  // The switches are mode writes too: an "AC dry" scene pushes Active=ON beside the
  // Dry switch, and the ON's default 'auto' would race the 'dry'.
  for (const [setSwitch, mode] of [['setDryOn', 'dry'], ['setFanOnlyOn', 'vent']] as const) {
    const { handler, sendCommandCalls } = makeHarness();
    handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

    const pOn = handler.setActive(Characteristic.Active.ACTIVE);
    const pSwitch = handler[setSwitch](true);
    await Promise.all([pOn, pSwitch]);

    assert.deepStrictEqual(modesSent(sendCommandCalls), [mode], `${setSwitch}: only the switch's mode`);
  }
});

test('a plain ON for an OFF unit turns it on exactly once', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  // Two ONs, as a scene sends them, with no mode write: exactly one power-on.
  const pOn1 = handler.setActive(Characteristic.Active.ACTIVE);
  const pOn2 = handler.setActive(Characteristic.Active.ACTIVE);
  await Promise.all([pOn1, pOn2]);

  // 'auto' is what setActive picks with nothing remembered and no profile loaded.
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'auto' }]);
});

test('an off right behind a held ON wins', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  const pOn = handler.setActive(Characteristic.Active.ACTIVE);
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  await Promise.all([pOn, pOff]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'off' }]);
});

test('control: an ON long after the last mode write is not swallowed', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  await handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
  await handler.setActive(Characteristic.Active.INACTIVE);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  // The off's success left the cache at off, so this is an ON for an off unit.
  await handler.setActive(Characteristic.Active.ACTIVE);

  assert.deepStrictEqual(
    sendCommandCalls.map((c) => c.commands),
    [{ operationMode: 'heat' }, { operationMode: 'off' }, { operationMode: 'auto' }],
  );
});

// ---- with real latency ------------------------------------------------------------

test('with latency: a HEAT scene on an OFF unit ends in HEAT, whatever the dispatch order', async () => {
  // The whole captured tile, both ways round: climate ON, fan-tile ON, and the mode.
  for (const modeFirst of [true, false]) {
    const { handler, sendCommandCalls } = makeSlowHarness();
    handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

    const heat = () => handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT);
    const ons = () => [
      handler.setActive(Characteristic.Active.ACTIVE),
      handler.setFanActive(Characteristic.Active.ACTIVE),
    ];
    await Promise.all(modeFirst ? [heat(), ...ons()] : [...ons(), heat()]);

    assert.deepStrictEqual(modesSent(sendCommandCalls), ['heat'],
      `${modeFirst ? 'mode first' : 'ONs first'}: no default 'auto' may race the scene's heat`);
  }
});

test('with latency: an "AC on at 22" scene with no mode write still delivers its setpoint', async () => {
  // Our part of the port. The ON is held 1.5s and lands 0.8s later; the setpoint's
  // own hold runs out at 1.5s, while the unit still reads off. Without waiting for
  // the turn-on in flight it was cached and never sent.
  const { handler, sendCommandCalls } = makeSlowHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spCool: 25 }));

  await Promise.all([
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setCoolingThresholdTemperature(22),
  ]);

  const modeIdx = sendCommandCalls.findIndex((c) => c.commands.operationMode !== undefined);
  const spIdx = sendCommandCalls.findIndex(isSetpoint);
  assert.ok(spIdx >= 0,
    'the setpoint must reach the device. Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)));
  assert.ok(modeIdx >= 0 && modeIdx < spIdx, 'after the power-on, never before it');
});

test('with latency: if that power-on fails, the setpoint is not sent on its own', async () => {
  // The other side of the wait: a failed turn-on leaves the cache at power 0, and
  // a bare setpoint would revive the unit over the LAN.
  const { handler, sendCommandCalls } = makeSlowHarness(800, (c) => c.operationMode !== undefined);
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spCool: 25 }));

  await Promise.all([
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setCoolingThresholdTemperature(22),
  ]);

  assert.ok(!sendCommandCalls.some(isSetpoint),
    'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)));
});

test('with latency: a setpoint waits for a mode write slower than its hold', async () => {
  // A mode write that takes 2s — a slow adapter, or the cloud — had not landed when
  // the setpoint's 1.5s hold ran out, so the setpoint of an "AC on in HEAT at 21"
  // scene saw an off unit and was cached instead of sent.
  const { handler, sendCommandCalls } = makeSlowHarness(2000);
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 18 }));

  await Promise.all([
    handler.setActive(Characteristic.Active.ACTIVE),
    handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
    handler.setHeatingThresholdTemperature(21),
  ]);

  assert.deepStrictEqual(modesSent(sendCommandCalls), ['heat']);
  // Not `=== 21`: the harness accessory reads in °F, so 21 is quantized onto that
  // grid first (src/temperature.ts). What matters here is that it was sent at all.
  assert.ok(sendCommandCalls.some((c) => c.commands.spHeat !== undefined),
    'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)));
});
