'use strict';

// Regression test: a scene/automation "turn off" must actually turn off a unit
// that is running in DRY (or fan-only VENT).
//
// Bug: dry and fan-only have no HomeKit *mode* of their own, so the plugin
// reported the climate tile as OFF while the unit was running (dry/vent were
// surfaced only through their separate Dry/Fan switches). A HomeKit
// off-automation writes the tile's off characteristic. When the unit was in dry,
// that characteristic already read OFF, so iOS suppressed the redundant write —
// the setter never fired, no `operationMode:'off'` reached the unit, and the
// still-ON Dry switch kept it dehumidifying. Live-confirmed the trigger is a
// scene/automation.
//
// Upstream's 1.7.1 fix (B) was to lie: report the Thermostat as COOL while in
// dry/vent so the off write stopped being redundant. That workaround is GONE and
// must not be reinstated. It only existed because Thermostat's OFF meant two
// things at once — "not heating or cooling" AND "powered down" — so honesty about
// the first cost you the second. HeaterCooler splits them:
//
//   Active                    on/off. THIS is what an off-automation writes.
//   CurrentHeaterCoolerState  what the unit is doing: INACTIVE/IDLE/HEATING/COOLING.
//   TargetHeaterCoolerState   the requested mode: AUTO/HEAT/COOL. No OFF member.
//
// The regression is therefore structurally impossible *provided* a running
// dry/vent unit reports Active=ACTIVE. If Active ever read INACTIVE while the
// unit was running, iOS would suppress the redundant Active=0 exactly as before
// and the original bug would be back through the new characteristic — so that is
// what these tests pin down. Current state can now be honest: dry runs the
// compressor and the coil cold (COOLING), vent moves air without heating or
// cooling (IDLE) — and IDLE, unlike the old OFF, still means "on".

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

// Real HAP values, per characteristic. Worth being exact rather than reusing one
// bag of constants: TargetHeaterCoolerState genuinely has no OFF member, and its
// 0 is AUTO — so a mapping bug that "returns OFF" would show up in the Home app
// as AUTO, not as off. Only Active can express off at all.
const HAP_ENUMS = {
  Active: { INACTIVE: 0, ACTIVE: 1 },
  CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
  TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
  SwingMode: { SWING_DISABLED: 0, SWING_ENABLED: 1 },
  CurrentSlatState: { FIXED: 0, JAMMED: 1, SWINGING: 2 },
  SlatType: { HORIZONTAL: 0, VERTICAL: 1 },
  TemperatureDisplayUnits: { CELSIUS: 0, FAHRENHEIT: 1 },
  FilterChangeIndication: { FILTER_OK: 0, CHANGE_FILTER: 1 },
};

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = { _name: String(prop), ...(HAP_ENUMS[prop] || {}) };
    }
    return charCache[prop];
  },
});

const Active = Characteristic.Active;
const CurrentState = Characteristic.CurrentHeaterCoolerState;
const TargetState = Characteristic.TargetHeaterCoolerState;

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
  const heaterCooler = accessory.getService(Service.HeaterCooler);
  return { handler, accessory, heaterCooler, sendCommandCalls };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'dry',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 25, spHeat: 23, spAuto: null, humidity: null,
    ...over,
  },
});

// ---- Active: dry/vent must NOT read "off" while running ---------------------
// This is the direct successor of "dry must not read a non-OFF target". Active is
// now the characteristic an off-automation writes, so it is the one that must not
// already agree with the write.

test('a unit running in DRY reports Active ACTIVE (an off write is never redundant)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  const active = await handler.getActive();

  assert.notStrictEqual(active, Active.INACTIVE, 'dry must not read INACTIVE (would make off a no-op)');
  assert.strictEqual(active, Active.ACTIVE);
});

test('a unit running in fan-only VENT reports Active ACTIVE', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));

  const active = await handler.getActive();

  assert.notStrictEqual(active, Active.INACTIVE, 'vent must not read INACTIVE (would make off a no-op)');
  assert.strictEqual(active, Active.ACTIVE);
});

test('a genuinely off unit still reports Active INACTIVE (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  assert.strictEqual(await handler.getActive(), Active.INACTIVE);
});

test('HEAT and COOL still map correctly (control — no regression)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', power: 1 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.HEAT);
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.COOL);
});

// ---- Current state is honest now, and still never reads "off" while running --
// The 1.7.1 hack made both dry and vent claim COOLING. HeaterCooler has a real
// IDLE, so each can be reported as what it is — the constraint that survives is
// only that a running unit must not report INACTIVE.

test('DRY reports CurrentHeaterCoolerState COOLING (compressor and coil are running)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  const current = await handler.getCurrentHeaterCoolerState();

  // The tile's status label follows Current. Dehumidify genuinely runs the
  // compressor, so COOLING is accurate rather than the old cover story — and it
  // shows a running dry unit as on even when the Dry switch is hidden.
  assert.strictEqual(current, CurrentState.COOLING);
  assert.notStrictEqual(current, CurrentState.INACTIVE, 'a running unit must never read INACTIVE');
});

test('VENT reports CurrentHeaterCoolerState IDLE — on, but neither heating nor cooling', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));

  const current = await handler.getCurrentHeaterCoolerState();

  // Fan-only had to be dressed up as COOLING under Thermostat because its only
  // honest option, OFF, doubled as "powered down". IDLE says "on, moving air"
  // without claiming a compressor that isn't running.
  assert.strictEqual(current, CurrentState.IDLE);
  assert.notStrictEqual(current, CurrentState.INACTIVE, 'a running unit must never read INACTIVE');
});

test('a powered-off unit still reports CurrentHeaterCoolerState INACTIVE (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  assert.strictEqual(await handler.getCurrentHeaterCoolerState(), CurrentState.INACTIVE);
});

test('dry and vent both report TargetHeaterCoolerState COOL (there is no OFF to fall into)', async () => {
  const { handler } = makeHarness();

  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));
  // Dry genuinely belongs on COOL: its setpoint lives in spCool, so the Home app
  // showing the cooling threshold is showing the dry setpoint (see
  // dry-setpoint.test.js). Vent has no setpoint of its own and rides along.
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.COOL);

  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), TargetState.COOL);
});

// ---- The off write still routes to operationMode:'off' ----------------------

test('turning a dry unit off via Active sends operationMode off', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  await handler.setActive(Active.INACTIVE);

  assert.deepStrictEqual(sendCommandCalls.at(-1).commands, { operationMode: 'off' },
    'off from a dry unit turns it off');
});

// ---- Optimistic window: turning Dry ON must not leave the tile reading off ---

test('turning the Dry switch ON leaves Active ACTIVE immediately', async () => {
  const { handler, heaterCooler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  await handler.setDryOn(true);

  // If the optimistic update left Active at INACTIVE, an off-automation firing
  // before the next poll would be suppressed again — reintroducing the bug in
  // that window. (Under Thermostat the same gap existed on the target state.)
  assert.strictEqual(
    heaterCooler.getCharacteristic(Characteristic.Active).value,
    Active.ACTIVE,
    'optimistic Active reflects the now-running unit',
  );
  assert.strictEqual(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    CurrentState.COOLING,
    'and the tile shows it running, not "Off"',
  );
});
