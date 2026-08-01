'use strict';

// The paired wireless sensor, delivered by the cloud `sensor_update` event.
//
// WHY THIS PATH EXISTS. Mitsubishi's v3 cloud stopped distributing the two
// secrets local LAN control needs (`password` vanished from `adapter_update`,
// `cryptoSerial` from GET /devices/{serial}/status), so the LAN read that used
// to supply the sensor's fine-grained temperature and humidity is dead. In the
// same window a `sensor_update` Socket.IO event appeared carrying exactly that
// data per device, keyed by `deviceSerial`.
//
// WHY IT MATTERS. The unit quantizes its own roomTemp to 0.5°C before reporting
// it; the sensor reports ~6 decimals (22.30543 against the unit's 22.5). Three
// of the four units here regulate FROM that sensor (tempSource 'sensor0'), so
// the sensor is the real thermostat, and the finer value also settles a display
// ambiguity: 22.5°C is exactly 72.5°F, the one 0.5°C step where a rounding
// renderer shows 73°F and a truncating one shows 72°F.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';
const OTHER_SERIAL = 'TESTSERIAL002';

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
        // Battery. Values verified against hap-nodejs CharacteristicDefinitions:
        // StatusLowBattery NORMAL=0 / LOW=1, ChargingState NOT_CHARGEABLE=2.
        BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1,
        NOT_CHARGING: 0, CHARGING: 1, NOT_CHARGEABLE: 2,
      };
    }
    return charCache[prop];
  },
});
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
  Battery: 'Battery',
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

function makeAccessory(displayName = 'Bedroom') {
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName,
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName } },
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

// The harness now has to supply onSensorUpdate as well as the streaming and
// profile hooks — the accessory subscribes to all three in its constructor.
function makeHarness(kumoConfig = {}, { linkAware = false, displayName = 'Bedroom' } = {}) {
  const sendCommandCalls = [];
  const linked = [];
  let primary = false;
  let publishes = 0;
  let profileCb = null;
  let sensorCb = null;
  let streamCb = null;

  const accessory = makeAccessory(displayName);
  if (linkAware) {
    const origAdd = accessory.addService;
    accessory.addService = (type, name, subtype) => {
      const svc = origAdd(type, name, subtype);
      svc.setPrimaryService = (v) => { if (svc.type === Service.HeaterCooler) primary = v !== false; };
      svc.addLinkedService = (s) => linked.push(s);
      return svc;
    };
  }

  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() { publishes += 1; } },
    kumoConfig,
  };
  const kumoAPI = {
    subscribeToDevice(serial, cb) { streamCb = cb; },
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    onSensorUpdate(cb) { sensorCb = cb; },
    sendCommand(serial, commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };

  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  profileCb(SERIAL, {
    minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
    maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
    hasModeVent: true, hasModeDry: true, hasModeHeat: true,
    hasVaneDir: false, hasVaneSwing: true, hasFanSpeedAuto: true,
    usesSetPointInDryMode: true,
  });

  return {
    handler, accessory, sendCommandCalls, linked,
    isPrimary: () => primary,
    heaterCooler: accessory.getService(Service.HeaterCooler),
    battery: () => accessory.getService(Service.Battery),
    humidity: () => accessory.getService(Service.HumiditySensor),
    publishes: () => publishes,
    emitSensor: (reading) => sensorCb({ deviceSerial: SERIAL, ...reading }),
    emitRaw: (reading) => sensorCb(reading),
    emitStreaming: (data) => streamCb(SERIAL, data),
    hasSensorHook: () => typeof sensorCb === 'function',
  };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'quiet', airDirection: 'auto',
    roomTemp: 22.5, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

const currentTemp = (h) => h.heaterCooler.chars.get(Characteristic.CurrentTemperature).value;

// ---- Subscription ---------------------------------------------------------

test('the accessory subscribes to sensor_update in its constructor', () => {
  const h = makeHarness();
  assert.strictEqual(h.hasSensorHook(), true,
    'without a subscription the sensor data never reaches HomeKit at all');
});

test('a reading for another unit is ignored', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  h.emitRaw({ deviceSerial: OTHER_SERIAL, temperature: 30, battery: 10 });

  assert.strictEqual(currentTemp(h), 22.5, 'sensor_update is broadcast per account, not per device');
  assert.strictEqual(h.battery(), null, 'and must not grow another unit a battery service');
});

test('a reading with no deviceSerial is ignored rather than crashing', () => {
  // deviceSerial is present on the live payload (verified: the capturing handler
  // filtered on it and fired). Code defensively anyway — an unkeyed event cannot
  // be attributed to a unit, so it must be dropped, not guessed at.
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  assert.doesNotThrow(() => h.emitRaw({ temperature: 30, battery: 5 }));
  assert.doesNotThrow(() => h.emitRaw({}));

  assert.strictEqual(currentTemp(h), 22.5);
  assert.strictEqual(h.battery(), null);
});

// ---- Temperature: the fine value wins -------------------------------------

test('a sensor reading publishes the fine temperature, not the quantized roomTemp', async () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));
  assert.strictEqual(currentTemp(h), 22.5, 'the unit reports its 0.5°C-quantized value');

  h.emitSensor({ temperature: 22.30543 });

  assert.strictEqual(currentTemp(h), 22.30543,
    'the sensor is the real thermostat on these units; 22.5 is the same reading rounded off');
  assert.strictEqual(await h.handler.getCurrentTemperature(), 22.30543,
    'and the cached read agrees with what was published');
});

test('a later cloud poll carrying the coarse roomTemp does not clobber the sensor value', async () => {
  // The whole point of the precedence rule. The cloud poll arrives every ~30s
  // with roomTemp quantized to 0.5°C; last-writer-wins would throw the fine
  // reading away seconds after it landed.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  assert.strictEqual(currentTemp(h), 22.30543);
  assert.strictEqual(await h.handler.getCurrentTemperature(), 22.30543);
});

test('the same poll still applies everything that is not sensor data', async () => {
  // The substitution is scoped to temperature and humidity. A sensor knows
  // nothing about mode, power or setpoints, so those must ride through untouched.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.handler.updateFromZone(zone({ roomTemp: 22.5, operationMode: 'heat', spHeat: 21, power: 1 }));

  assert.strictEqual(currentTemp(h), 22.30543);
  assert.strictEqual(await h.handler.getTargetHeaterCoolerState(), Characteristic.TargetHeaterCoolerState.HEAT);
  assert.strictEqual(await h.handler.getHeatingThresholdTemperature(), 21);
  assert.strictEqual(await h.handler.getActive(), Characteristic.Active.ACTIVE);
});

test('a local poll cannot clobber the sensor value either', async () => {
  // Polling, streaming and the local poll all funnel through processZoneUpdate,
  // so the guard has to sit there rather than on one transport.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.handler.updateFromLocal({
    roomTemp: 22.5, spHeat: 20, spCool: 24, power: 1, operationMode: 'cool', fanSpeed: 'quiet',
  });

  assert.strictEqual(currentTemp(h), 22.30543);
});

test('nor can a streaming update, which applies extra fields after the rebuild', async () => {
  // The third transport, and the only one that writes to currentStatus AFTER
  // processZoneUpdate returns (modelNumber, connected, displayConfig). That
  // post-pass must not reach back over the substituted temperature.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543 });

  h.emitStreaming({
    id: 'zone-1', deviceSerial: SERIAL, roomTemp: 22.5, spHeat: 20, spCool: 24,
    spAuto: null, power: 1, operationMode: 'cool', fanSpeed: 'quiet',
    airDirection: 'auto', humidity: null, rssi: -50,
    displayConfig: { filter: false, defrost: false, standby: false },
  });

  assert.strictEqual(currentTemp(h), 22.30543);
  assert.strictEqual(await h.handler.getCurrentTemperature(), 22.30543);
});

test('a sensor reading before the first device update still answers reads', async () => {
  const h = makeHarness();

  h.emitSensor({ temperature: 21.875 });

  assert.strictEqual(await h.handler.getCurrentTemperature(), 21.875,
    'a real reading beats the 20°C placeholder');
});

test('a sensor reading is telemetry: it sends nothing and moves nothing', async () => {
  // It must not revive a unit, re-push a setpoint, or fire the mirror — the mirror
  // follows *commanded* state, and a room warming by a tenth of a degree is not a
  // command.
  const h = makeHarness();
  h.handler.updateFromZone(zone({ power: 0, operationMode: 'off', roomTemp: 22.5 }));
  const mirrored = [];
  h.handler.onStatusUpdate((s) => mirrored.push(s.operationMode));

  h.emitSensor({ temperature: 22.30543, humidity: 55.5, battery: 100 });

  assert.strictEqual(h.sendCommandCalls.length, 0);
  assert.strictEqual(mirrored.length, 0, 'sensor telemetry must not drive the mirror');
  assert.strictEqual(await h.handler.getActive(), Characteristic.Active.INACTIVE,
    'a unit that is off stays off');
  assert.strictEqual(await h.handler.getCoolingThresholdTemperature(), 24);
});

// ---- Battery --------------------------------------------------------------

test('a battery reading lazily creates the Battery service and publishes it', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone());
  assert.strictEqual(h.battery(), null, 'nothing exists until a battery value actually arrives');
  const before = h.publishes();

  h.emitSensor({ temperature: 22.3, battery: 100 });

  const battery = h.battery();
  assert.notStrictEqual(battery, null);
  assert.strictEqual(battery.chars.get(Characteristic.BatteryLevel).value, 100);
  assert.strictEqual(h.publishes(), before + 1,
    'a service added after discovery is invisible to HomeKit without a re-publish');
});

test('the Garage — a unit with no paired sensor — never grows a Battery service', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone());
  h.handler.updateFromZone(zone({ roomTemp: 23 }));

  assert.strictEqual(h.battery(), null,
    'a battery tile on a mains-powered unit with nothing to report is pure noise');
});

test('a sensor that reports temperature but no battery gets no Battery service', () => {
  // Same shape as the Garage case from the other direction: the event fires, but
  // carries no battery field, so there is nothing to expose.
  const h = makeHarness();
  h.emitSensor({ temperature: 22.30543, humidity: 55.5 });

  assert.strictEqual(h.battery(), null);
  assert.strictEqual(currentTemp(h), 22.30543, 'the temperature still lands');
});

test('the Battery service carries only characteristics HAP allows on it', () => {
  // Verified against hap-nodejs ServiceDefinitions: Battery REQUIRES
  // StatusLowBattery and optionally allows BatteryLevel, ChargingState and Name.
  // Anything else makes Homebridge log a characteristic warning on every start —
  // exactly what ConfiguredName on Fanv2 did.
  const h = makeHarness();
  h.emitSensor({ battery: 100 });
  const battery = h.battery();

  const allowed = new Set([
    Characteristic.StatusLowBattery,
    Characteristic.BatteryLevel,
    Characteristic.ChargingState,
    Characteristic.Name,
  ]);
  for (const key of battery.chars.keys()) {
    assert.ok(allowed.has(key), `${key._name} is not in Battery's required or optional set`);
  }
  assert.ok(battery.chars.has(Characteristic.StatusLowBattery), 'the one required characteristic');
  assert.strictEqual(battery.chars.get(Characteristic.ChargingState).value,
    Characteristic.ChargingState.NOT_CHARGEABLE,
    'a wireless sensor runs on a cell you replace, not one you charge');
});

test('StatusLowBattery flips at 20%, with a case either side', () => {
  const cases = [
    [100, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
    [21, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
    [20, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
    [19, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW],
    [0, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW],
  ];
  for (const [percent, expected] of cases) {
    const h = makeHarness();
    h.emitSensor({ battery: percent });
    assert.strictEqual(h.battery().chars.get(Characteristic.StatusLowBattery).value, expected,
      `${percent}% must report ${expected === 1 ? 'LOW' : 'NORMAL'}`);
  }
});

test('the battery level is clamped and rounded to the uint8 HAP expects', () => {
  // The value comes off the cloud, so it is a trust boundary: hand HAP something
  // it will reject and the characteristic silently keeps its old value.
  const cases = [[100, 100], [55.6, 56], [-5, 0], [140, 100]];
  for (const [raw, expected] of cases) {
    const h = makeHarness();
    h.emitSensor({ battery: raw });
    assert.strictEqual(h.battery().chars.get(Characteristic.BatteryLevel).value, expected);
  }
});

test('a later battery reading updates the existing service without re-publishing', () => {
  const h = makeHarness();
  h.emitSensor({ battery: 100 });
  const after = h.publishes();

  h.emitSensor({ battery: 12 });

  assert.strictEqual(h.battery().chars.get(Characteristic.BatteryLevel).value, 12);
  assert.strictEqual(h.battery().chars.get(Characteristic.StatusLowBattery).value,
    Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
  assert.strictEqual(h.publishes(), after, 'the service is only structurally new once');
});

test('the battery survives a cloud poll rebuilding the cached status', () => {
  // processZoneUpdate rebuilds DeviceStatus from the zone payload, which carries
  // no battery — it only ever arrives on sensor_update.
  const h = makeHarness();
  h.emitSensor({ battery: 42 });

  h.handler.updateFromZone(zone({ roomTemp: 23 }));

  assert.strictEqual(h.battery().chars.get(Characteristic.BatteryLevel).value, 42,
    'the published value stands');
});

test('the Battery service is linked to the climate tile', () => {
  const h = makeHarness({}, { linkAware: true });
  h.emitSensor({ battery: 100 });

  assert.ok(h.linked.includes(h.battery()),
    'an unlinked Battery reads as a standalone accessory rather than part of the unit');
});

// ---- Humidity -------------------------------------------------------------

test('humidity from a sensor reading reaches the HumiditySensor service', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ humidity: null }));
  assert.strictEqual(h.humidity(), null, 'no humidity has been seen yet');

  h.emitSensor({ humidity: 55.523438 });

  assert.notStrictEqual(h.humidity(), null, 'the first reading creates the service');
  assert.strictEqual(
    h.humidity().chars.get(Characteristic.CurrentRelativeHumidity).value, 55.523438);
});

test('a poll reporting no humidity does not wipe the sensor value', () => {
  const h = makeHarness();
  h.emitSensor({ humidity: 55.523438 });

  h.handler.updateFromZone(zone({ humidity: null }));

  assert.strictEqual(
    h.humidity().chars.get(Characteristic.CurrentRelativeHumidity).value, 55.523438);
});

test('showHumiditySensor: false keeps the sensor humidity out of HomeKit', () => {
  // Home collapses an accessory's services into one tile and favours a sensor
  // reading for what that tile shows, so this opt-out exists to stop humidity
  // dominating the unit. A new delivery path must not route around it.
  const h = makeHarness({ showHumiditySensor: false });

  h.emitSensor({ humidity: 55.523438, temperature: 22.30543 });

  assert.strictEqual(h.humidity(), null, 'no service, whatever the sensor reports');
  assert.strictEqual(currentTemp(h), 22.30543, 'the temperature is unaffected by the gate');
});

test('a humidity-only reading leaves the temperature alone', () => {
  const h = makeHarness();
  h.handler.updateFromZone(zone({ roomTemp: 22.5 }));

  h.emitSensor({ humidity: 55.5 });

  assert.strictEqual(currentTemp(h), 22.5,
    'a partial reading updates only the fields it actually carries');
});
