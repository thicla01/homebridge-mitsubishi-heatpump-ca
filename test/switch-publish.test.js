'use strict';

// Regression test for the runtime-structure-publish fix.
//
// Every service this accessory grows *after* discovery — the fan-only switch
// (1.4.0), the dry switch (1.5.0), the Slats/vane service and the HumiditySensor
// service (both new with the HeaterCooler migration) — is created from an async
// callback: applyDeviceProfile (profile_update) or the first zone update that
// carries a humidity reading. By then the accessory has already been published to
// the bridge. A service or characteristic added to an already-published accessory
// is invisible to HomeKit — and never persisted to cachedAccessories — unless the
// plugin calls api.updatePlatformAccessories([accessory]). It never did, so both
// switches silently failed to appear in the Home app.
//
// These tests drive the compiled accessory with a minimal HAP mock and assert
// that a structural change both mutates the service set AND re-publishes the
// accessory. Before the fix, the publish count was 0.
//
// Since the HeaterCooler migration the switches are ALSO config-gated
// (showDrySwitch / showFanOnlySwitch, both opt-in; exposeVaneSlat, opt-out), so
// each add/remove branch is now driven by capability AND config. Both gates route
// through the same setup*/remove* pair, so both must publish.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Stable characteristic identifiers (same object returned per name), with the
// nested state constants the accessory reads (e.g. Active.INACTIVE).
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
    // Exposed so a test can ask whether a characteristic was ever *added* to this
    // service without adding it by asking. This mirrors real HAP: hap-nodejs's
    // Service.getCharacteristic() ADDS an optional characteristic to the service
    // as a side effect of the lookup (Service.js:186-230), which is precisely how
    // a post-publish characteristic sneaks in unpublished.
    chars,
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
  // Pre-seed AccessoryInformation; the constructor uses getService(...)! on it.
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

// The switches are opt-in and the vane slats opt-out, so every harness states its
// config explicitly — the gate under test is as much the config as the capability.
const ALL_ON = { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true };

function makeHarness(kumoConfig = ALL_ON) {
  const updates = [];
  let profileCb = null;
  const config = { ...kumoConfig };
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories: (a) => updates.push(a) },
    kumoConfig: config,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  const heaterCooler = accessory.getService(Service.HeaterCooler);
  return {
    handler, accessory, updates, config, heaterCooler,
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

const profile = (over = {}) => ({
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeVent: true,
  hasModeDry: true,
  ...over,
});

// ---- switches: capability gate -------------------------------------------

test('applying a vent+dry profile adds both switches and publishes them to HomeKit', () => {
  const { accessory, updates, applyProfile } = makeHarness();
  assert.strictEqual(updates.length, 0, 'nothing published before a profile arrives');

  applyProfile(profile());

  assert.ok(accessory.getServiceById(Service.Switch, 'fan-only'), 'fan-only switch added');
  assert.ok(accessory.getServiceById(Service.Switch, 'dry'), 'dry switch added');
  // The regression: before the fix this stayed 0 — services existed in memory
  // but were never pushed to the bridge.
  assert.ok(updates.length >= 1, 'accessory re-published after adding switches');
});

test('re-applying the same profile does not re-publish (guarded on real change)', () => {
  const { updates, applyProfile } = makeHarness();
  applyProfile(profile());
  const afterFirst = updates.length;
  applyProfile(profile());
  assert.strictEqual(updates.length, afterFirst, 'no redundant HomeKit config bump');
});

test('dropping dry support removes the switch and publishes the removal', () => {
  const { accessory, updates, applyProfile } = makeHarness();
  applyProfile(profile());
  const before = updates.length;
  applyProfile(profile({ hasModeDry: false }));
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'dry switch removed');
  assert.ok(updates.length > before, 'removal re-published to HomeKit');
});

// ---- switches: config gate ------------------------------------------------

// Fan speed and dehumidify used to have nowhere to live on a Thermostat tile, so
// both switches were published for every capable unit. On HeaterCooler fan speed
// is RotationSpeed on the main tile, so the fan-only switch is a niche control and
// both switches became opt-in. A capable device with no opt-in must publish
// NOTHING: an unwanted switch is as much a bug as a missing one, and a stray
// publish alone bumps the HomeKit config number for no structural change.
test('a capable device publishes no switches when the config has not opted in', () => {
  const { accessory, updates, applyProfile } = makeHarness({});

  applyProfile(profile());

  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null, 'no fan-only switch');
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'no dry switch');
  assert.strictEqual(updates.length, 0, 'nothing added, so nothing published');
});

// The opt-in is checked with === true, so only a literal true opts in. This pins
// that: a truthy-but-not-true config value (a string from a hand-edited config.json)
// must not silently publish a switch.
test('the config gate is strict — only true opts a switch in', () => {
  const { accessory, applyProfile } = makeHarness({ showDrySwitch: 'yes', showFanOnlySwitch: 1 });

  applyProfile(profile());

  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'non-boolean does not opt in');
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null, 'non-boolean does not opt in');
});

// ---- Slats (vane) ---------------------------------------------------------

// The Slats service is the discrete-vane control, added from the same async
// profile callback as the switches — so it carries the identical publish
// requirement. Isolated here with both switches off, so the publish count is
// attributable to the Slats service alone and cannot be satisfied by a switch
// publish that happens to fire in the same applyDeviceProfile pass.
test('a vane-capable profile adds the Slats service and publishes it', () => {
  const { accessory, updates, applyProfile } = makeHarness({ exposeVaneSlat: true });

  applyProfile(profile({ hasVaneDir: true }));

  assert.ok(accessory.getService(Service.Slats), 'Slats service added');
  assert.strictEqual(updates.length, 1, 'exactly one publish, for the Slats service');
});

test('exposeVaneSlat: false keeps Slats off a vane-capable device', () => {
  const { accessory, updates, applyProfile } = makeHarness({ exposeVaneSlat: false });

  applyProfile(profile({ hasVaneDir: true }));

  assert.strictEqual(accessory.getService(Service.Slats), null, 'opted out, no Slats service');
  assert.strictEqual(updates.length, 0, 'nothing added, so nothing published');
});

// Opting out after the service already exists must remove AND publish, or the
// Home app keeps showing a vane tile that no longer has handlers behind it.
// A live config edit needs a Homebridge restart, so the real-world path is a
// cached Slats service meeting a now-false exposeVaneSlat on the next profile —
// the same removeSlatsService branch this drives.
test('opting out of the vane slats removes the service and publishes the removal', () => {
  const { accessory, updates, config, applyProfile } = makeHarness({ exposeVaneSlat: true });
  applyProfile(profile({ hasVaneDir: true }));
  const before = updates.length;

  config.exposeVaneSlat = false;
  applyProfile(profile({ hasVaneDir: true }));

  assert.strictEqual(accessory.getService(Service.Slats), null, 'Slats service removed');
  assert.ok(updates.length > before, 'removal re-published to HomeKit');
});

// ---- humidity -------------------------------------------------------------

// Same bug class as the switches, but the target moved: CurrentRelativeHumidity
// was an optional characteristic on Thermostat and is NOT valid on HeaterCooler
// (hap-nodejs would add it anyway and emit a "not in required or optional
// characteristic section" warning), so humidity now needs its own HumiditySensor
// service. It is still created lazily on the first non-null reading — long after
// the accessory was published — so it must still re-publish.
test('first humidity reading adds a HumiditySensor service and publishes it', () => {
  const { handler, accessory, updates, heaterCooler } = makeHarness();
  const before = updates.length;

  handler.updateFromZone(zone({ humidity: 51 }));

  const hum = accessory.getService(Service.HumiditySensor);
  assert.ok(hum, 'HumiditySensor service added');
  assert.strictEqual(
    hum.chars.get(Characteristic.CurrentRelativeHumidity).value, 51,
    'reading landed on the sensor service',
  );
  // The characteristic must not be hung off the main tile: HeaterCooler does not
  // list it, which is the whole reason the service exists.
  assert.ok(
    !heaterCooler.chars.has(Characteristic.CurrentRelativeHumidity),
    'humidity must not be attached to the HeaterCooler service',
  );
  assert.ok(updates.length > before, 'adding the humidity service re-published the accessory');
});

test('the humidity service is published only once, not on every reading', () => {
  const { handler, accessory, updates } = makeHarness();
  handler.updateFromZone(zone({ humidity: 51 }));
  const after = updates.length;

  handler.updateFromZone(zone({ humidity: 52 }));

  assert.strictEqual(updates.length, after, 'no redundant publish once humidity is registered');
  assert.strictEqual(
    accessory.getService(Service.HumiditySensor).chars.get(Characteristic.CurrentRelativeHumidity).value,
    52,
    'later readings still update the existing service',
  );
});

// ---- swing ----------------------------------------------------------------

// FAILING ON PURPOSE — this is a real bug in src/accessory.ts, not a stale
// expectation. See the note in the agent report.
//
// applyDeviceProfile registers SwingMode with
// `this.service.getCharacteristic(C.SwingMode)` (accessory.ts:305-311) and never
// calls publishStructureChange(). In hap-nodejs, getCharacteristic() on a
// characteristic the service does not yet carry ADDS it (Service.js:186-230;
// SwingMode is in HeaterCooler's optionalCharacteristics list,
// ServiceDefinitions.js:701) — so this is a structural change to an
// already-published accessory, exactly like the humidity characteristic was.
// Without the publish, the swing toggle never reaches the Home app and is never
// persisted to cachedAccessories.
//
// It is masked whenever the same applyDeviceProfile pass also adds or removes a
// service, because those publishes flush the pending SwingMode too. This profile
// is the unmasked case, and it is the DEFAULT configuration: swing-capable, no
// discrete vane positions, both switches at their opt-out default.
//
// Fix: call this.publishStructureChange() inside the
// `if (profile.hasVaneSwing && !this.swingModeRegistered)` block.
test('registering SwingMode publishes it to HomeKit', () => {
  const { updates, applyProfile, heaterCooler } = makeHarness({});

  applyProfile(profile({
    hasVaneSwing: true, hasVaneDir: false, hasModeVent: false, hasModeDry: false,
  }));

  assert.ok(
    heaterCooler.chars.has(Characteristic.SwingMode),
    'SwingMode added to the already-published HeaterCooler service',
  );
  assert.ok(
    updates.length >= 1,
    'adding SwingMode after publish must re-publish the accessory',
  );
});
