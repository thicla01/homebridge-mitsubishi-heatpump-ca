'use strict';

// Regression test for the off-unit setpoint bug.
//
// HomeKit sends a setpoint independently of the unit's on/off state. When an
// automation (e.g. "turn off the AC when the skylight opens") captures a unit's
// full state, opening the skylight re-pushes each unit's last setpoint alongside
// `off`. The old code's off branch sent a bare `{ spHeat: temp }` with no
// operationMode, which the Kumo v3 API rejects with `modeRequiredWhenDeviceOff`
// (HTTP 400) — producing a cluster of red errors on every skylight-open event
// even though the unit shut off fine.
//
// The unit is off, so there is nothing to set: no command should be sent. The
// requested value is cached + echoed to HomeKit so the slider doesn't snap back.
//
// ---- What the HeaterCooler migration changed about this test ----------------
//   * The setpoint no longer arrives on TargetTemperature (that characteristic
//     does not exist on HeaterCooler). It arrives on HeatingThresholdTemperature
//     or CoolingThresholdTemperature, which are the setpoint controls in every
//     mode now. Both route into the same guard, so both are exercised below —
//     under Thermostat one characteristic covered both device fields, here it
//     takes two writers to cover the same ground.
//   * The independence that makes the bug possible is, if anything, sharper: the
//     off is `Active`, a physically separate characteristic, so a controller can
//     and does write a threshold to a unit it just powered down.
//   * The echoed value is the *quantized* setpoint, not the raw request — writes
//     are snapped onto the whole-°F grid (src/temperature.ts) before anything
//     else happens. That is still "the slider holds": 21°C and 21.2°C are the
//     same 70°F, which is what the user actually asked for and what the Home app
//     displays. Arithmetic is spelled out at each assertion.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = {
        _name: String(prop),
        OFF: 0, HEAT: 1, COOL: 2, AUTO: 3,
        INACTIVE: 0, ACTIVE: 1,
        IDLE: 1, HEATING: 2, COOLING: 3,
        SWING_DISABLED: 0, SWING_ENABLED: 1,
        FIXED: 0, JAMMED: 1, SWINGING: 2,
        HORIZONTAL: 0, VERTICAL: 1,
        CELSIUS: 0, FAHRENHEIT: 1,
      };
    }
    return charCache[prop];
  },
});

const Service = {
  AccessoryInformation: 'AccessoryInformation',
  Thermostat: 'Thermostat',
  HeaterCooler: 'HeaterCooler',
  Fanv2: 'Fanv2',
  Slats: 'Slats',
  HumiditySensor: 'HumiditySensor',
  Switch: 'Switch',
  FilterMaintenance: 'FilterMaintenance',
};

function makeCharacteristic() {
  const ch = {
    value: undefined,
    onGet() { return ch; },
    onSet() { return ch; },
    setProps() { return ch; },
  };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    getCharacteristic(id) {
      if (!chars.has(id)) chars.set(id, makeCharacteristic());
      return chars.get(id);
    },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeAccessory() {
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName: 'Living room',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Living room' } },
    getService(type) {
      const e = entries.find((x) => x.type === type && x.subtype === undefined);
      return e ? e.svc : null;
    },
    getServiceById(type, subtype) {
      const e = entries.find((x) => x.type === type && x.subtype === subtype);
      return e ? e.svc : null;
    },
    addService(type, name, subtype) {
      const svc = makeService(type, name, subtype);
      entries.push({ type, subtype, svc });
      return svc;
    },
    removeService(svc) {
      const i = entries.findIndex((x) => x.svc === svc);
      if (i >= 0) entries.splice(i, 1);
    },
  };
}

function makeHarness() {
  const sendCommandCalls = [];
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
    sendCommand(serial, commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, sendCommandCalls };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

test('setting a target temperature while the unit is OFF sends no command', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Seed an OFF status the way a streaming/poll update would.
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(21);

  // Before the fix this was 1: a bare { spHeat: 21 } that the API rejected with
  // modeRequiredWhenDeviceOff. The unit is off, so nothing should be sent.
  assert.strictEqual(sendCommandCalls.length, 0,
    'no API command should be sent when the unit is off');
});

// The cooling threshold is a second, independent writer into the same guard.
// Under Thermostat, TargetTemperature covered spHeat and spCool from one setter,
// so one test covered both device fields; here it takes two. The Home app shows
// this handle whenever the (off) unit's captured mode was COOL or AUTO, which is
// precisely the skylight scene's shape.
test('the cooling threshold is guarded the same way while the unit is OFF', async () => {
  const { handler, accessory, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spCool: 24 }));

  await handler.setCoolingThresholdTemperature(25);

  assert.strictEqual(sendCommandCalls.length, 0,
    'a bare { spCool } to an off unit is the same doomed 400');
  // 25°C is exactly 77°F, so the echo is the request unchanged.
  const cool = accessory.getService(Service.HeaterCooler)
    .getCharacteristic(Characteristic.CoolingThresholdTemperature);
  assert.strictEqual(cool.value, 25, 'the cooling handle holds the requested value');
});

test('setting a target temperature while OFF still echoes the value to HomeKit', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(21);

  // 21°C = 69.8°F -> nearest whole °F is 70 -> (70-32)*5/9 = 21.111… -> 21.2.
  // 21.2°C reads back as 69.98°F, i.e. the same 70°F the user asked for, so the
  // handle holds where they put it rather than snapping back to the device's 20.
  const target = accessory.getService(Service.HeaterCooler)
    .getCharacteristic(Characteristic.HeatingThresholdTemperature);
  assert.strictEqual(target.value, 21.2,
    'HomeKit still reflects the requested value, on the °F grid (slider holds)');
});

test('setting a target temperature while HEATING still sends the setpoint (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(sendCommandCalls.length, 1, 'heat-mode setpoint is sent to the API');
  // 22°C = 71.6°F -> 72°F -> (72-32)*5/9 = 22.222… -> 22.2.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22.3 },
    'sends the quantized heat setpoint with no spurious fields');
});

// ---- Fan and vane are NOT setpoints --------------------------------------
//
// A bare, mode-less SETPOINT write resumes a powered-off unit on the LAN path,
// which is what the guard above exists for (upstream 1.7.2). Fan speed and vane
// do not behave that way. Verified live 2026-07-27: with the Garage powered off,
// all six named fan speeds and all seven vane positions were written in sequence
// and the unit reported mode=off throughout.
//
// Both are stored preferences that apply when the unit next runs, so blocking
// them on an idle unit made a perfectly ordinary request — "set every fan to
// quiet" — silently skip whichever units happened to be off. What must still be
// blocked is a command trailing an off inside a concurrent scene burst; that is
// covered in off-scene-setpoint-race.test.js and guarded by offInFlight().

test('a fan-speed change reaches a unit that is merely OFF', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setRotationSpeed(20); // superQuiet

  assert.strictEqual(sendCommandCalls.length, 1,
    'an idle unit must still accept a fan-speed preference');
  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'superQuiet' },
    'and it carries no mode, so it cannot revive the unit');
});

test('a vane change reaches a unit that is merely OFF', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setSwingMode(1); // SWING_ENABLED

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { vaneDir: 'swing' });
});

test('but a setpoint still does NOT reach an OFF unit (the guard is intact)', async () => {
  // Control: proves the two tests above narrowed the guard rather than removing it.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setHeatingThresholdTemperature(21);

  assert.strictEqual(sendCommandCalls.length, 0,
    'a bare setpoint on an off unit is still suppressed — it would revive it');
});
