'use strict';

// Regression test: a scene setpoint dispatched *before* the off must not stick.
//
// The 1.7.2 fix (off-scene-setpoint-race.test.js) stops a setpoint that lands
// AFTER an off from reviving the unit. But HomeKit dispatches a scene's captured
// setpoints and its off concurrently in arbitrary order, and a setpoint that
// lands just BEFORE the off arrives while the unit is still on — so it passes
// the guard and sends, permanently rewriting the device's stored setpoint.
//
// Observed live 2026-07-26 (19:26:56 log burst): the "AC off" scene wrote the
// Living room's stale captured spCool of 25°C, then turned it off. The Living
// room is a mirror target of the Kitchen (22.5°C), and mirroring is
// edge-triggered — nothing re-synced the two until the Kitchen next changed, so
// the two tiles showed setpoints 2.5°C apart for 36 minutes.
//
// Fix: hold each setpoint write briefly before sending it, so an off arriving
// in the same burst cancels it whichever order the two were dispatched in.
//
// ---- What the HeaterCooler migration changed about this test ----------------
// The hazard is unchanged; only the characteristics it travels on moved.
//   * The off no longer arrives on TargetHeatingCoolingState=OFF. HeaterCooler
//     splits power out into `Active`, so the scene's off is setActive(INACTIVE).
//     `noteModeIntent('off')` still runs synchronously before that command's
//     await, which is what lets a sibling handler in the same burst see it.
//   * The captured setpoints no longer arrive on TargetTemperature (gone — there
//     is no such characteristic on HeaterCooler). They arrive on the two
//     threshold characteristics, which are the setpoint controls in EVERY mode
//     now, not just AUTO. So both writers below are threshold writers.
// The hold (accessory.ts:holdSetpointWrite) is still the only thing standing
// between "scene fired" and "device permanently holds a stale setpoint".
//
// Setpoint values are quantized onto the whole-°F grid before sending
// (src/temperature.ts), so the expected command values below are the quantized
// ones, not the raw request. Each is derived in-line where it matters.

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
  const ch = { value: undefined, onGet() { return ch; }, onSet() { return ch; }, setProps() { return ch; } };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    getCharacteristic(id) { if (!chars.has(id)) chars.set(id, makeCharacteristic()); return chars.get(id); },
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
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
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
    roomTemp: 22, spCool: 22.5, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

const isSetpoint = (c) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;

test('a scene setpoint dispatched just BEFORE the off never reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Living room running in cool at the mirrored 22.5, the way a poll would seed it.
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  // The 19:26:56 dispatch order: the scene's stale captured setpoint first,
  // then the off. Fired concurrently, as HomeKit does. The off is now an
  // Active=INACTIVE write; the setpoint is the cooling threshold, which on
  // HeaterCooler is the live setpoint control while the unit is in COOL.
  const pSp = handler.setCoolingThresholdTemperature(25);
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  await Promise.all([pSp, pOff]);

  const setpoints = sendCommandCalls.filter(isSetpoint);
  assert.strictEqual(
    setpoints.length, 0,
    'a setpoint dispatched before the off must not rewrite the stored setpoint. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
  assert.ok(
    sendCommandCalls.some((c) => c.commands.operationMode === 'off'),
    'the off itself is still sent',
  );
});

// Was: "the same holds for the plain TargetTemperature setpoint". TargetTemperature
// no longer exists, but the regression it guarded — that the *other* setpoint
// writer is protected too, not just the one the first test happens to use — is
// still live. On HeaterCooler that second writer is the heating threshold, and it
// is a genuinely independent code path: holdSetpointWrite is keyed per field
// ('spHeat' vs 'spCool'), so each key's hold has to observe the off on its own.
test('the same holds for the heating threshold, the other setpoint writer', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  const pSp = handler.setHeatingThresholdTemperature(21);
  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  await Promise.all([pSp, pOff]);

  assert.strictEqual(
    sendCommandCalls.filter(isSetpoint).length, 0,
    'the spHeat hold must see the off too. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
  assert.ok(
    sendCommandCalls.some((c) => c.commands.operationMode === 'off'),
    'the off itself is still sent',
  );
});

test('control: a setpoint with no off in the burst still sends', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  await handler.setCoolingThresholdTemperature(23.5);

  assert.strictEqual(sendCommandCalls.length, 1);
  // 23.5°C = 74.3°F -> nearest whole °F is 74 -> (74-32)*5/9 = 23.333… -> 23.3.
  // The value on the wire is the quantized one; the hold must not change that.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 23.4 });
});

test('a drag sends only its final value', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  await Promise.all([
    handler.setCoolingThresholdTemperature(23),
    handler.setCoolingThresholdTemperature(23.5),
    handler.setCoolingThresholdTemperature(24),
  ]);

  assert.strictEqual(sendCommandCalls.length, 1, 'intermediate drag values are superseded');
  // 24°C = 75.2°F -> 75°F -> (75-32)*5/9 = 23.888… -> 23.9. The three raw values
  // quantize to three distinct grid points (22.8 / 23.3 / 23.9), so this really is
  // a drag and not one value repeated: only the last generation may survive.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 23.9 });
});

test('the two AUTO handles do not supersede each other', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'auto', spAuto: null }));

  await Promise.all([
    handler.setHeatingThresholdTemperature(20),
    handler.setCoolingThresholdTemperature(25),
  ]);

  assert.strictEqual(sendCommandCalls.length, 2, 'both AUTO handles are independent writes');
  // 20°C is exactly 68°F and 25°C is exactly 77°F, so both are already on the
  // whole-°F grid and quantization is a no-op here. Deliberate: this test is about
  // the generation counter being keyed per field, not about rounding.
  assert.ok(sendCommandCalls.some((c) => c.commands.spHeat === 20));
  assert.ok(sendCommandCalls.some((c) => c.commands.spCool === 25));
});
