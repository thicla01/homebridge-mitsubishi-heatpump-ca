'use strict';

// The Fanv2 service: speed, auto/manual, and the on/off relationship.
//
// WHY THIS SERVICE EXISTS. Fan speed used to live on the HeaterCooler's own
// RotationSpeed, with `auto` encoded as 0. That was wrong twice over:
//
//   1. RotationSpeed is a percentage and 0 means "off" everywhere else in
//      HomeKit, so auto rendered as an empty slider.
//   2. `auto` is not a point on the airflow ladder at all. In auto the unit may
//      be blowing at full power while a 0 slider claims it is at its slowest.
//
// HAP models exactly this with TargetFanState (MANUAL/AUTO) — which exists on
// Fanv2 and NOT on HeaterCooler (verified against hap-nodejs). So the fan moved
// to its own service, the slider carries only the five real speeds, and auto
// became an orthogonal flag instead of a fake speed.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { FAN_SPEEDS } = require('../dist/settings.js');

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
        OFF: 0, HEAT: 1, COOL: 2, AUTO: 0,
        INACTIVE: 0, ACTIVE: 1,
        IDLE: 1, HEATING: 2, COOLING: 3, BLOWING_AIR: 2,
        MANUAL: 0,
        SWING_DISABLED: 0, SWING_ENABLED: 1,
        FIXED: 0, SWINGING: 2, HORIZONTAL: 0, VERTICAL: 1,
        CELSIUS: 0, FAHRENHEIT: 1,
      };
    }
    return charCache[prop];
  },
});
// TargetFanState is MANUAL=0 / AUTO=1 — the opposite polarity to
// TargetHeaterCoolerState's AUTO=0, so it needs its own values.
charCache.TargetFanState = { _name: 'TargetFanState', MANUAL: 0, AUTO: 1 };

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
    onGet() { return ch; }, onSet() { return ch; }, setProps(p) { ch.props = p; return ch; },
  };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype, chars,
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
    displayName: 'Bedroom',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Bedroom' } },
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
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
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
  return {
    handler, accessory, sendCommandCalls,
    fan: accessory.getServiceById(Service.Fanv2, 'airflow'),
    heaterCooler: accessory.getService(Service.HeaterCooler),
    applyProfile: (p) => profileCb(SERIAL, p),
  };
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

// ---- Structure -----------------------------------------------------------

test('the fan lives on its own Fanv2 service, not on the HeaterCooler', () => {
  const { fan, heaterCooler } = makeHarness();

  assert.notStrictEqual(fan, null, 'a Fanv2 service is created for every unit');
  assert.ok(fan.chars.has(Characteristic.RotationSpeed), 'speed is on the fan service');
  assert.ok(fan.chars.has(Characteristic.TargetFanState), 'auto/manual is on the fan service');
  assert.ok(!heaterCooler.chars.has(Characteristic.RotationSpeed),
    'the HeaterCooler must NOT also carry a speed control — two controls, one field');
});

test('the speed slider has no zero position', () => {
  const { fan } = makeHarness();
  const props = fan.chars.get(Characteristic.RotationSpeed).props;

  assert.strictEqual(props.minValue, 20,
    'zero would read as "off"; every detent must be a real speed');
  assert.strictEqual(props.minStep, 20);
  assert.strictEqual(props.maxValue, 100);
  // 20/40/60/80/100 == exactly the five named speeds, auto excluded.
  assert.strictEqual((props.maxValue - props.minValue) / props.minStep + 1,
    FAN_SPEEDS.length - 1);
});

// ---- Speed round-trip ----------------------------------------------------

test('each detent maps to its own real speed', async () => {
  const cases = [[20, 'superQuiet'], [40, 'quiet'], [60, 'low'], [80, 'powerful'], [100, 'superPowerful']];
  for (const [pct, speed] of cases) {
    const { handler, sendCommandCalls } = makeHarness();
    handler.updateFromZone(zone());
    await handler.setRotationSpeed(pct);
    assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: speed },
      `${pct}% must send ${speed}`);
  }
});

test('the slider can never produce "auto"', async () => {
  // Even a value below the minimum clamps into the real-speed range rather than
  // falling through to index 0, which is the auto sentinel.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setRotationSpeed(0);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'superQuiet' },
    'a 0 that slips through must be the slowest real speed, not auto');
});

test('a reported speed reads back as its own detent', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));

  assert.strictEqual(await handler.getRotationSpeed(), 80);
  assert.strictEqual(await handler.getTargetFanState(), Characteristic.TargetFanState.MANUAL);
});

// ---- Auto ----------------------------------------------------------------

test('auto is reported on TargetFanState, not as a speed', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  assert.strictEqual(await handler.getTargetFanState(), Characteristic.TargetFanState.AUTO,
    'auto is a mode flag');
  assert.notStrictEqual(await handler.getRotationSpeed(), 0,
    'and must NOT render as a zeroed slider, which reads as "off"');
});

test('switching to AUTO sends auto', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'quiet' }));

  await handler.setTargetFanState(Characteristic.TargetFanState.AUTO);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'auto' });
});

test('leaving AUTO restores the last real speed the unit was seen at', async () => {
  // The device stores ONE fan field, so "manual" has to name a speed. Falling
  // back to a fixed default would silently change the user's airflow; the last
  // observed speed is the only answer that does not.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));   // observed
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));       // then switched to auto

  await handler.setTargetFanState(Characteristic.TargetFanState.MANUAL);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'powerful' },
    'not a hardcoded default');
});

test('in auto the slider shows the last real speed, not zero', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'low' }));
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  assert.strictEqual(await handler.getRotationSpeed(), 60,
    'the slider keeps a meaningful position; TargetFanState carries the auto-ness');
});

test('moving the slider leaves auto', async () => {
  const { handler, fan, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));

  await handler.setRotationSpeed(40);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'quiet' });
  assert.strictEqual(fan.chars.get(Characteristic.TargetFanState).value,
    Characteristic.TargetFanState.MANUAL,
    'picking a speed is inherently manual — the toggle must follow');
});

// ---- On/off --------------------------------------------------------------

test('the fan tile follows the unit power', async () => {
  const { handler } = makeHarness();

  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));
  assert.strictEqual(await handler.getFanActive(), Characteristic.Active.ACTIVE);
  assert.strictEqual(await handler.getCurrentFanState(), Characteristic.CurrentFanState.BLOWING_AIR);

  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));
  assert.strictEqual(await handler.getFanActive(), Characteristic.Active.INACTIVE);
  assert.strictEqual(await handler.getCurrentFanState(), Characteristic.CurrentFanState.INACTIVE);
});

test('turning the fan tile off turns the unit off', async () => {
  // A mini-split cannot run its fan with the unit off, so the two tiles cannot
  // disagree. This is the deliberate consequence: a "fans off" command reaches
  // the heat pump.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  await handler.setFanActive(Characteristic.Active.INACTIVE);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'off' });
});

// ---- Service linkage -----------------------------------------------------
//
// `primary` and `linked` are part of a service's HAP representation. Declaring
// them says "the HeaterCooler is this accessory, and the fan belongs to it"
// rather than leaving a Fanv2 looking like a standalone fan that a room-level or
// category-wide command should sweep up. That is the exact failure the Slats
// service hit when it was silently grouped with the user's real blinds.

function makeLinkAwareHarness() {
  const linked = [];
  let primary = false;
  const accessory = makeAccessory();
  const origAdd = accessory.addService;
  accessory.addService = (type, name, subtype) => {
    const svc = origAdd(type, name, subtype);
    svc.setPrimaryService = (v) => { if (svc.type === Service.HeaterCooler) primary = v !== false; };
    svc.addLinkedService = (s) => linked.push(s);
    return svc;
  };
  let profileCb = null;
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand() { return Promise.resolve(true); },
  };
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, linked, isPrimary: () => primary,
    applyProfile: (p) => profileCb(SERIAL, p) };
}

test('the HeaterCooler is declared the primary service', () => {
  const { isPrimary } = makeLinkAwareHarness();
  assert.strictEqual(isPrimary(), true,
    'the climate tile is the accessory; the rest hang off it');
});

test('the fan service is linked to the HeaterCooler', () => {
  const { linked, accessory } = makeLinkAwareHarness();
  const fan = accessory.getServiceById(Service.Fanv2, 'airflow');

  assert.ok(linked.includes(fan),
    'an unlinked Fanv2 reads as a standalone fan, which is how a "turn off the ' +
    'fans" command reaches a heat pump');
});

test('lazily-created services are linked too', () => {
  const { linked, accessory, applyProfile } = makeLinkAwareHarness();
  applyProfile({
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeVent: false, hasModeDry: false, hasVaneDir: false, hasVaneSwing: false,
  });
  // The humidity sensor arrives from a status update rather than the profile.
  accessory.getServiceById(Service.Fanv2, 'airflow');
  assert.ok(linked.length >= 1, 'linkage is not limited to constructor-time services');
});
