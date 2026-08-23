// Regression test: a threshold characteristic must never be left holding a value
// outside the range the plugin declares for it.
//
// Found by running three simulated units through a real Homebridge (see
// tools/kumo-adapter-sim.mjs). Every one of them logged, at registration:
//
//   [Sim unit 1@@Heating Threshold Temperature] characteristic was supplied
//   illegal value: number 0 exceeded minimum of 10
//
// Cause: hap-nodejs starts a fresh HeatingThresholdTemperature at 0 — its own
// default range begins there — and the constructor then narrows the range to
// 10-35. setProps re-validates the value it finds, so it logged the complaint and
// clamped. The clamp made it harmless in effect; the log line did not read that
// way, and it fired once per unit.
//
// Why it was invisible for so long: Homebridge persists characteristic values in
// cachedAccessories, so a unit that already existed comes back holding a real
// setpoint and never trips the check. Only a unit registered from scratch does —
// which is exactly what no one had done here in a long time, and what nobody with
// a single heat pump does twice.
//
// The contract pinned below is deliberately about OUR value, not HAP's default:
// if the plugin always seeds an in-range value, it does not matter what hap-nodejs
// starts at or whether that default changes.

import test from 'node:test';
import assert from 'node:assert';
import { Characteristic as HapCharacteristic } from '@homebridge/hap-nodejs';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory, type FakeAccessory } from './helpers';

function makeHarness() {
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
    sendCommand(_serial: string, _commands: Commands) {
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  return { handler, accessory };
}

function threshold(accessory: FakeAccessory, key: string) {
  const svc = accessory.getService(Service.HeaterCooler);
  assert.ok(svc, 'the HeaterCooler service is the primary climate service');
  return svc.getCharacteristic(Characteristic[key]);
}

for (const key of ['HeatingThresholdTemperature', 'CoolingThresholdTemperature']) {
  test(`${key} holds a value inside its own declared range from construction`, () => {
    const { accessory } = makeHarness();
    const ch = threshold(accessory, key);
    const min = ch.props?.minValue as number;

    assert.strictEqual(typeof min, 'number', 'the constructor declares a range');
    assert.strictEqual(
      typeof ch.value, 'number',
      `${key} was left with no value of ours, so whatever HAP defaults to has to be in range`,
    );
    assert.ok(
      (ch.value as number) >= min,
      `${key} is ${ch.value}, below the minimum of ${min} it declares — `
      + 'HAP re-validates on setProps and logs "supplied illegal value"',
    );
    assert.ok(
      (ch.value as number) <= (ch.props?.maxValue as number),
      `${key} is above the maximum it declares`,
    );
  });
}

// The premise the seed exists for. If hap-nodejs ever raises its own default above
// our minimum this test fails, and the seed for that characteristic becomes dead
// code worth deleting rather than a silent no-op nobody dares touch.
test('hap-nodejs still defaults HeatingThresholdTemperature below our minimum', () => {
  const { accessory } = makeHarness();
  const declaredMin = threshold(accessory, 'HeatingThresholdTemperature').props?.minValue as number;
  const hapDefault = new HapCharacteristic.HeatingThresholdTemperature().value as number;

  assert.strictEqual(hapDefault, 0, 'hap-nodejs default for HeatingThresholdTemperature');
  assert.ok(
    hapDefault < declaredMin,
    'if HAP ever starts in range, the seed is no longer load-bearing',
  );
});
