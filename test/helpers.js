'use strict';

// Mechanical HAP fakes, shared by every accessory test. Only the parts that were
// byte-identical in each file live here: the Characteristic identity map, the
// Service name map, and the service/accessory stubs. Per-file setup (harnesses,
// zone and profile payloads) deliberately stays in its own test file, where the
// values are the subject rather than scaffolding.

// Real hap-nodejs values, keyed by characteristic so each one carries its own
// members. Copies of these fakes used to share a single bag of constants, which
// hid genuine differences: the two AUTOs below are opposite polarities
// (TargetHeaterCoolerState.AUTO=0 against TargetFanState.AUTO=1), and
// TargetHeaterCoolerState has no OFF member at all — only Active expresses off.
// Verified against node_modules/hap-nodejs/dist/lib/definitions/CharacteristicDefinitions.d.ts.
const HAP_ENUMS = {
  Active: { INACTIVE: 0, ACTIVE: 1 },
  ChargingState: { NOT_CHARGING: 0, CHARGING: 1, NOT_CHARGEABLE: 2 },
  CurrentFanState: { INACTIVE: 0, IDLE: 1, BLOWING_AIR: 2 },
  CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
  CurrentSlatState: { FIXED: 0, JAMMED: 1, SWINGING: 2 },
  FilterChangeIndication: { FILTER_OK: 0, CHANGE_FILTER: 1 },
  SlatType: { HORIZONTAL: 0, VERTICAL: 1 },
  StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
  SwingMode: { SWING_DISABLED: 0, SWING_ENABLED: 1 },
  TargetFanState: { MANUAL: 0, AUTO: 1 },
  TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
  TemperatureDisplayUnits: { CELSIUS: 0, FAHRENHEIT: 1 },
};

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Stable characteristic identifiers: the same object comes back for a given name,
// so it can be used as a Map key the way hap-nodejs uses the real class. A name
// with no entry above gets no members, which is what makes a mistyped or
// unverified constant read as undefined instead of silently matching.
const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = { _name: String(prop), ...(HAP_ENUMS[prop] || {}) };
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
  Battery: 'Battery',
};

function makeCharacteristic() {
  const ch = {
    value: undefined,
    onGet() { return ch; },
    onSet() { return ch; },
    setProps(p) { ch.props = p; return ch; },
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

// AccessoryInformation is pre-seeded because the accessory constructor calls
// getService(...)! on it and would throw on null.
function makeAccessory(displayName = 'Kitchen', deviceSerial = 'TESTSERIAL001') {
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName,
    context: { device: { deviceSerial, siteId: 'site-1', displayName } },
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

module.exports = { Characteristic, Service, makeLog, makeCharacteristic, makeService, makeAccessory };
