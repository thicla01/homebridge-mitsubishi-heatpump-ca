'use strict';

// Regression test for the AUTO setpoint band.
//
// These units report spAuto: null and keep the auto band in spHeat (low/heat
// bound) and spCool (high/cool bound) — verified against live device data (every
// poll showed `Auto: null` with independent spHeat/spCool). HomeKit shows that as
// a temperature *range* (two handles) whenever the mode is AUTO.
//
// The original bug: AUTO collapsed to the single TargetTemperature characteristic
// which, with spAuto null, fell back to spHeat — so the cooling side of the band
// was invisible and unsettable, and any write of that one characteristic drove
// both edges to the same value.
//
// The primary service is now HeaterCooler, not Thermostat, which changes what
// this file protects in two ways:
//
//   1. TargetTemperature does not exist on HeaterCooler. The heating and cooling
//      thresholds are THE setpoint controls in every mode — heat threshold in
//      HEAT, cool threshold in COOL, both as a range in AUTO. So the collapse is
//      now structurally impossible rather than merely patched around: there is no
//      second characteristic that can write both edges from one value. The test
//      below asserts that absence directly, so a future re-introduction of a
//      single combined setpoint control fails here instead of in someone's house.
//
//   2. Every inbound setpoint is snapped to the exact Celsius of the nearest
//      whole °F before it is sent (src/temperature.ts, quantizeSetpointInRange).
//      That is why the expected command values below are not the values HomeKit
//      "sent" — see the per-test arithmetic. It is deliberate: HAP applies a
//      characteristic's minStep only on the OUTBOUND path, so a controller write
//      of "72°F" arrives as whatever Celsius float it produced, and without the
//      snap the unit stores 22.2000000000003 or 22.5 and the Mitsubishi app shows
//      73°F for a 72°F tap.
//
// Still asserted, unchanged in spirit:
//   - getHeatingThresholdTemperature -> spHeat,  getCoolingThresholdTemperature -> spCool
//   - setHeatingThresholdTemperature -> { spHeat }, setCoolingThresholdTemperature -> { spCool }
//     (one key per command — neither write clobbers the other edge)
//   - zone updates sync both threshold characteristics
//   - the 1.5.2 powered-off guard applies (no bare setpoint to an off unit)

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
    // Which characteristics the accessory actually wired up. Note getCharacteristic
    // creates lazily, so this must be read without touching the one being asserted
    // about — that is the point: it proves src never reached for it.
    characteristicIds() { return [...chars.keys()].map((c) => c._name); },
  };
  return svc;
}

function makeAccessory() {
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName: 'Kitchen',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Kitchen' } },
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
  let profileCb = null;
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, sendCommandCalls, applyProfile: (p) => profileCb(SERIAL, p) };
}

// Read a characteristic value off the primary climate service. That service is
// HeaterCooler now — a ductless mini-split has an on/off state separate from its
// mode, which Thermostat cannot express. A cached Thermostat is removed in the
// constructor, so getService(Service.Thermostat) is null here.
function heaterCoolerChar(accessory, charKey) {
  return accessory.getService(Service.HeaterCooler).getCharacteristic(Characteristic[charKey]).value;
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'autoCool',
    fanSpeed: null, airDirection: null,
    roomTemp: 23, spCool: 26, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

// ---- Read path -----------------------------------------------------------
// The read path is NOT quantized: whatever the device reports is what the handle
// shows. Snapping a device-reported value would misreport the unit's real state
// (someone may have set 22.5 from the Mitsubishi app or a wall thermostat).

test('heating threshold reads spHeat, cooling threshold reads spCool', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 26);
});

test('zone updates sync both AUTO threshold characteristics', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 19, spCool: 27 }));

  assert.strictEqual(heaterCoolerChar(accessory, 'HeatingThresholdTemperature'), 19,
    'spHeat is pushed to the heating handle, verbatim');
  assert.strictEqual(heaterCoolerChar(accessory, 'CoolingThresholdTemperature'), 27,
    'spCool is pushed to the cooling handle, verbatim');
});

// ---- Write path ----------------------------------------------------------

test('setting the heating threshold in AUTO sends spHeat only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setHeatingThresholdTemperature(21);

  // 21°C -> 69.8°F -> nearest whole °F is 70 -> 70°F = 21.111…°C -> stored 21.2.
  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 21.2 },
    'heating handle writes spHeat, on the °F grid (no spCool, no operationMode)');
});

test('setting the cooling threshold in AUTO sends spCool only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(25);

  // 25°C is exactly 77°F, so the grid snap is a no-op here — a useful control
  // that quantization only ever moves values that were off-grid to begin with.
  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 25 },
    'cooling handle writes spCool (no spHeat, no operationMode)');
});

test('the AUTO band cannot collapse: no single control writes both edges', async () => {
  const { handler, accessory, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  // --- structural half ---
  // The collapse needed a characteristic that drove spHeat AND spCool from one
  // value. On HeaterCooler that characteristic does not exist, and the handler
  // methods that backed it are gone. Assert the absence, not just the behaviour:
  // this is the regression that reaches the user as "my AUTO range snapped shut".
  const ids = accessory.getService(Service.HeaterCooler).characteristicIds();
  assert.ok(!ids.includes('TargetTemperature'),
    'HeaterCooler must not carry a combined TargetTemperature — it is the collapse vector');
  assert.strictEqual(typeof handler.setTargetTemperature, 'undefined',
    'no combined setpoint writer may exist');
  assert.strictEqual(typeof handler.getTargetTemperature, 'undefined',
    'no combined setpoint reader may exist');

  // --- behavioural half ---
  // The live scenario that used to flatten the band: an automation/scene pushes
  // both captured handles at once and HomeKit dispatches them concurrently in an
  // arbitrary order. The 1.5s write hold is keyed per setpoint field, so the two
  // handles cannot supersede each other — both must land, with their own values.
  await Promise.all([
    handler.setHeatingThresholdTemperature(21),   // -> 70°F -> 21.2
    handler.setCoolingThresholdTemperature(25),   // -> 77°F -> 25
  ]);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands),
    [{ spHeat: 21.2 }, { spCool: 25 }],
    'a concurrent two-handle burst sends both edges, each with its own value');
  for (const call of sendCommandCalls) {
    assert.strictEqual(Object.keys(call.commands).length, 1,
      'every setpoint command touches exactly one edge');
  }
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 21.2);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 25,
    'the band is still 3.9°C wide, not collapsed to a point');
});

test('dragging the band sends two independent commands, not a collapsed pair', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  await handler.setHeatingThresholdTemperature(21);
  await handler.setCoolingThresholdTemperature(25);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands),
    [{ spHeat: 21.2 }, { spCool: 25 }],
    'the band stays two-sided; neither write clobbers the other edge');
});

test('an accepted threshold write optimistically updates cached state', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  await handler.setCoolingThresholdTemperature(24);

  // 24°C -> 75.2°F -> 75°F -> 23.888…°C -> stored 23.9. The echo must be the
  // QUANTIZED value, not the raw 24 HomeKit sent: the handle has to show what the
  // unit will actually hold, or the next poll visibly yanks it and the user
  // re-drags it.
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 23.9,
    'the new spCool is reflected immediately, before the next poll');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20,
    'the heating edge is untouched');
});

// ---- Powered-off guard (inherits the 1.5.2 behavior) ---------------------

test('threshold writes to a powered-off unit are cached, not sent', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setHeatingThresholdTemperature(22);

  // 22°C -> 71.6°F -> 72°F -> 22.222…°C -> stored 22.3.
  assert.strictEqual(sendCommandCalls.length, 0,
    'no bare setpoint is sent to an off unit (would 400 modeRequiredWhenDeviceOff)');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 22.3,
    'the value is cached + echoed so the handle holds — quantized, same as a sent write');
});

// ---- Controls: single-setpoint modes are unaffected ----------------------
// These were TargetTemperature tests. TargetTemperature is gone, but the risk it
// guarded is not: the thresholds are now load-bearing in HEAT and COOL too, so a
// change to the AUTO band logic must not disturb the single-setpoint modes. Same
// guarantee, asserted through the characteristic that carries it now.

test('HEAT-mode heating threshold still sends spHeat only (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));

  await handler.setHeatingThresholdTemperature(22);

  // 22°C -> 71.6°F -> 72°F -> 22.3.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22.3 },
    'the heat path writes only its own edge, and carries no operationMode');
});

test('COOL-mode cooling threshold still sends spCool only (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));

  await handler.setCoolingThresholdTemperature(23);

  // 23°C -> 73.4°F -> 73°F -> 22.777…°C -> stored 22.8.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 22.8 });
});
