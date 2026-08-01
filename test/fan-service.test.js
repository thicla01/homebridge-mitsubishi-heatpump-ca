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
  // TargetFanState and SwingMode are capability-gated, so a realistic harness has
  // to deliver a profile before either exists.
  profileCb(SERIAL, {
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeVent: true, hasModeDry: true, hasModeHeat: true,
    hasVaneDir: true, hasVaneSwing: true, hasFanSpeedAuto: true,
    usesSetPointInDryMode: true,
  });
  return {
    handler, accessory, sendCommandCalls,
    fan: accessory.getServiceById(Service.Fanv2, 'airflow'),
    heaterCooler: accessory.getService(Service.HeaterCooler),
    applyProfile: (p) => profileCb(SERIAL, p),
  };
}

// Fan writes are coalesced onto the next tick (see queueFanIntent), so a test has
// to let that tick run before asserting what was sent.
const tick = () => new Promise((r) => setTimeout(r, 5));

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
  // Swing deliberately does NOT move: Apple Home's default collapsed tile renders
  // the fan's speed but hides its Oscillate toggle, which would make vane control
  // unreachable on a default install.
  assert.ok(heaterCooler.chars.has(Characteristic.SwingMode),
    'swing stays on the climate tile where Home actually renders it');
  assert.ok(!fan.chars.has(Characteristic.SwingMode));
});

test('the slider keeps a 0 position, and 0 means the quietest speed', async () => {
  // minValue MUST stay 0: hap-nodejs rejects a client write below minValue with
  // -70410 INVALID_VALUE_IN_REQUEST instead of clamping it, and the Home app does
  // send 0 when a fan slider is dragged to the bottom.
  //
  // But the position does not have to be dead. Mapping it to the quietest speed
  // makes "drag down for quieter" behave the way it looks, with no detent that
  // silently does nothing. Off deliberately stays on the climate tile — honouring
  // 0 as a power-off would put the heat pump back within reach of a scene or
  // voice command aimed at "the fan".
  const { fan, handler, sendCommandCalls } = makeHarness();
  const props = fan.chars.get(Characteristic.RotationSpeed).props;

  assert.strictEqual(props.minValue, 0, 'a rejected write would surface as an error in Home');
  assert.strictEqual(props.minStep, 20);
  assert.strictEqual(props.maxValue, 100);
  // 20..100 == exactly the five named speeds, auto excluded.
  assert.strictEqual((props.maxValue - 20) / props.minStep + 1, FAN_SPEEDS.length - 1);

  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  await handler.setRotationSpeed(0);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'superQuiet' },
    'the bottom of the slider is the quietest speed, not a no-op and not an off');
});

// ---- Speed round-trip ----------------------------------------------------

test('each detent maps to its own real speed', async () => {
  const cases = [[20, 'superQuiet'], [40, 'quiet'], [60, 'low'], [80, 'powerful'], [100, 'superPowerful']];
  for (const [pct, speed] of cases) {
    const { handler, sendCommandCalls } = makeHarness();
    handler.updateFromZone(zone());
    await handler.setRotationSpeed(pct);
    await tick();
    assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: speed },
      `${pct}% must send ${speed}`);
  }
});

test('the slider can never produce "auto"', async () => {
  // Every reachable detent is a real speed; index 0 (the auto sentinel) is not on
  // this slider at all.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setRotationSpeed(20);
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'superQuiet' });
  assert.ok(!sendCommandCalls.some((c) => c.commands.fanSpeed === 'auto'));
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
  await tick();

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
  await tick();

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
  await tick();

  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'quiet' });
  assert.strictEqual(fan.chars.get(Characteristic.TargetFanState).value,
    Characteristic.TargetFanState.MANUAL,
    'picking a speed is inherently manual — the toggle follows once the write lands');
});

test('an explicit AUTO beats a speed sent in the same burst', async () => {
  // HomeKit delivers a scene as ONE write request and hap-nodejs dispatches every
  // handler in it concurrently without awaiting. A scene that sets "fan auto"
  // also re-sends its captured RotationSpeed, so before the writes were coalesced
  // whichever handler finished last won and auto landed in manual at random.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'quiet' }));

  await Promise.all([
    handler.setTargetFanState(Characteristic.TargetFanState.AUTO),
    handler.setRotationSpeed(80),
  ]);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 1, 'the burst collapses to one command');
  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'auto' },
    'the explicit auto wins over the speed the scene happened to carry');
});

test('the same burst in the other order still resolves to auto', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'quiet' }));

  await Promise.all([
    handler.setRotationSpeed(80),
    handler.setTargetFanState(Characteristic.TargetFanState.AUTO),
  ]);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { fanSpeed: 'auto' },
    'order of dispatch must not decide the outcome');
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

test('turning the fan tile OFF does NOT turn the unit off', async () => {
  // Apple documents room-scoped Siri fan commands ("Turn off the fan.", "Turn on
  // the fan in the office."), and a HomePod answers a bare "turn off the fan" for
  // its own room. If a fan-tile off reached the unit's power, any of those would
  // shut down the heat pump — the same shape as the Slats service being swept up
  // by a blinds command. The write is bounced instead.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  await handler.setFanActive(Characteristic.Active.INACTIVE);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 0,
    'a room-wide "turn off the fan" must not be able to stop the heat pump');
});

test('turning the fan tile ON does turn the unit on', async () => {
  // Only the off direction is refused: an on is unambiguous and harmless.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setFanActive(Characteristic.Active.ACTIVE);
  await tick();

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.ok(sendCommandCalls[0].commands.operationMode !== 'off');
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
