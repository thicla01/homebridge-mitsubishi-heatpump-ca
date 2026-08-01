'use strict';

// Integration tests for local control wiring in the accessory:
//  - updateFromLocal() feeds a locally-read status into the characteristics
//  - local is authoritative: a cloud (polling/streaming) update is dropped while a
//    recent local poll exists (the cloud lags ~7-10s and would clobber it)
//  - sendDeviceCommand() prefers local and falls back to cloud on local failure
//
// The characteristics these assert against moved with the Thermostat ->
// HeaterCooler switch: there is no TargetTemperature any more, so the setpoint a
// local read lands on is read back through Cooling/HeatingThresholdTemperature
// (which are the setpoint controls in EVERY mode here, not just AUTO), and on/off
// is the separate `Active` characteristic. The wiring being tested — which
// transport a read/write travels over — is unchanged.

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
        IDLE: 1, HEATING: 2, COOLING: 3, BLOWING_AIR: 2,
        // hap-nodejs values: FilterChangeIndication FILTER_OK=0 / CHANGE_FILTER=1.
        FILTER_OK: 0, CHANGE_FILTER: 1,
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
    type, name, subtype, chars,
    getCharacteristic(id) { if (!chars.has(id)) chars.set(id, makeCharacteristic()); return chars.get(id); },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeAccessory() {
  const entries = [{ type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) }];
  return {
    displayName: 'Kitchen',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Kitchen' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
  };
}

function makeLocalClient(over = {}) {
  const calls = [];
  return {
    calls,
    hasLocalResult: true,
    sendCommandResult: true,
    hasLocal() { return this.hasLocalResult; },
    sendCommand(serial, commands) { calls.push({ serial, commands }); return Promise.resolve(this.sendCommandResult); },
    getStatus() { return Promise.resolve(null); },
    ...over,
  };
}

function makeHarness({ localClient = null } = {}) {
  const sendCommandCalls = [];
  let streamCb = null;
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
    localClient,
  };
  const kumoAPI = {
    // Capture the streaming callback rather than dropping it: displayConfig
    // (standby / defrost / filter) only ever arrives on this transport, so the
    // carry-across tests below have no other way to put it in the cache.
    subscribeToDevice(serial, cb) { streamCb = cb; },
    onDeviceProfileUpdate() {},
    sendCommand(serial, commands) { sendCommandCalls.push({ serial, commands }); return Promise.resolve(true); },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return {
    handler, sendCommandCalls, platform, accessory,
    emitStreaming: (data) => streamCb(SERIAL, data),
    heaterCooler: () => accessory.getService(Service.HeaterCooler),
  };
}

const localStatus = (over = {}) => ({
  roomTemp: 24, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20,
  spAuto: null, fanSpeed: 'auto', airDirection: 'auto', filterDirty: false,
  defrost: false, standby: false, ...over,
});

const cloudZone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 30, spCool: 28, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});

// ---- updateFromLocal ------------------------------------------------------

test('updateFromLocal feeds a locally-read status into the characteristics', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24, operationMode: 'cool', spCool: 23, spHeat: 20 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24);
  // The local read's setpoints reach HomeKit through the two thresholds now.
  // spCool is the one the Home app shows in COOL; spHeat rides along so the band
  // is intact the moment the user switches to AUTO.
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 23, 'cool mode surfaces spCool');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20, 'the heat edge comes across too');
  // Local status carries no `power` field of its own — mapLocalStatus derives it
  // from mode !== 'off' — so Active is the end of that chain.
  assert.strictEqual(await handler.getActive(), Characteristic.Active.ACTIVE);
  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.COOLING,
  );
  assert.strictEqual(
    await handler.getTargetHeaterCoolerState(),
    Characteristic.TargetHeaterCoolerState.COOL,
  );
});

// ---- local authoritative --------------------------------------------------

test('a cloud update is dropped while a recent local poll exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24, spCool: 23 }));
  // Cloud streaming/polling lags and reports a stale 30°C — must NOT clobber local.
  handler.updateFromZone(cloudZone({ roomTemp: 30, spCool: 28 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24, 'local stays authoritative');
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 23,
    'the stale cloud setpoint is dropped too, not just the temperature');
});

test('cloud updates still apply when no local data exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(cloudZone({ roomTemp: 30 }));
  assert.strictEqual(await handler.getCurrentTemperature(), 30, 'pure-cloud path unaffected');
});

// ---- standby / defrost / filter survive a status rebuild ------------------
//
// processZoneUpdate rebuilds DeviceStatus from the zone payload on every update.
// standby, defrost and filterDirty are NOT in /sites/{id}/zones — they arrive in
// the streaming `displayConfig` and in the local status, both of which apply them
// AFTER processZoneUpdate returns. Without carrying them across the rebuild the
// poll (every 30s by default, alongside streaming) dropped them back to undefined,
// and the characteristics that read them reported a working compressor for a unit
// that was idling.

const streamingUpdate = (over = {}) => ({
  id: 'zone-1', deviceSerial: SERIAL, roomTemp: 24, spHeat: 20, spCool: 23,
  spAuto: null, power: 1, operationMode: 'cool', fanSpeed: 'auto',
  airDirection: 'auto', humidity: null, rssi: -50,
  displayConfig: { filter: false, defrost: false, standby: true, hotAdjust: false },
  ...over,
});

test('a cloud poll does not wipe the standby flag the streaming event delivered', async () => {
  const { handler, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));
  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.IDLE,
    'streaming reported the compressor idle',
  );

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.IDLE,
    'the zones payload carries no standby — losing it reports a running compressor',
  );
});

test('the state PUSHED to HomeKit by the poll is idle too, not just the cached read', async () => {
  // The Home app shows the pushed value; a getter that disagrees with it is no
  // help. mapToCurrentHeaterCoolerState runs inside processZoneUpdate, so it sees
  // the rebuilt status, which is where the flag used to go missing.
  const h = makeHarness();
  h.emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));

  h.handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  const pushed = h.heaterCooler().chars.get(Characteristic.CurrentHeaterCoolerState).value;
  assert.strictEqual(pushed, Characteristic.CurrentHeaterCoolerState.IDLE);
});

test('the fan reports idle rather than blowing air while the compressor is in standby', async () => {
  const { handler, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  assert.strictEqual(
    await handler.getCurrentFanState(),
    Characteristic.CurrentFanState.IDLE,
    'the second consumer of the same flag',
  );
});

test('a unit that is genuinely running still reports cooling after a poll', async () => {
  // The carry-across must not pin a stale idle either: a streaming event saying
  // standby is over has to survive the next poll the same way.
  const { handler, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: true, filter: false, defrost: false } }));
  emitStreaming(streamingUpdate({ displayConfig: { standby: false, filter: false, defrost: false } }));

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));

  assert.strictEqual(
    await handler.getCurrentHeaterCoolerState(),
    Characteristic.CurrentHeaterCoolerState.COOLING,
  );
});

test('the filter indication survives a poll as well', async () => {
  // updateFilterMaintenance re-reads the cached flag (`filterDirty ?? false`) on
  // every streaming event. A poll in between that dropped the flag therefore
  // cleared a genuine "change the filter" warning on the very next event.
  const { handler, accessory, emitStreaming } = makeHarness();
  emitStreaming(streamingUpdate({ displayConfig: { standby: false, filter: true, defrost: false } }));
  const filterSvc = accessory.getService(Service.FilterMaintenance);
  const dirty = filterSvc.chars.get(Characteristic.FilterChangeIndication).value;
  assert.strictEqual(dirty, Characteristic.FilterChangeIndication.CHANGE_FILTER);

  handler.updateFromZone(cloudZone({ roomTemp: 24, operationMode: 'cool' }));
  // A later streaming event that carries no displayConfig at all — the adapter
  // does not send one on every update.
  emitStreaming(streamingUpdate({ displayConfig: undefined, roomTemp: 24.5 }));

  assert.strictEqual(
    filterSvc.chars.get(Characteristic.FilterChangeIndication).value,
    Characteristic.FilterChangeIndication.CHANGE_FILTER,
    'the warning must not clear itself just because a poll rebuilt the status',
  );
});

// ---- sendDeviceCommand routing --------------------------------------------
//
// A setpoint write is the vehicle for these because it is the one command whose
// payload the two transports shape differently (the LAN body drops `power`), so
// it is where a routing mistake actually costs something.
//
// 22°C arrives on the wire as 22.2: setpoints are snapped to the Fahrenheit grid
// before sending (quantizeSetpointInRange). 22°C = 71.6°F -> nearest whole °F is
// 72 -> back to Celsius at the 0.1°C device resolution = 22.3. Whichever
// transport carries the write, it carries the same quantized value — the point of
// quantizing above the transport layer rather than inside it.
const QUANTIZED_22 = 22.3;

test('commands prefer the local path when a unit is locally reachable', async () => {
  const local = makeLocalClient();
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.deepStrictEqual(local.calls.map((c) => c.commands), [{ spHeat: QUANTIZED_22 }], 'sent locally');
  assert.strictEqual(sendCommandCalls.length, 0, 'cloud not used');
});

test('a failed local command falls back to the cloud', async () => {
  const local = makeLocalClient({ sendCommandResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(local.calls.length, 1, 'local attempted first');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: QUANTIZED_22 }], 'then cloud');
});

test('commands skip local when the unit is not locally reachable', async () => {
  const local = makeLocalClient({ hasLocalResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(local.calls.length, 0, 'local not attempted');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: QUANTIZED_22 }], 'cloud used');
});

test('turning the unit off routes locally as a bare mode write', async () => {
  // On/off used to ride on TargetHeatingCoolingState.OFF; it is `Active` now. It
  // still has to reach the LAN adapter as `mode: "off"` and nothing else — the
  // local protocol has no `power` field, so an off that arrived as a bare
  // `power: 0` would be dropped on the floor and the unit would keep running.
  const local = makeLocalClient();
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'cool' }));

  await handler.setActive(Characteristic.Active.INACTIVE);

  assert.deepStrictEqual(local.calls.map((c) => c.commands), [{ operationMode: 'off' }], 'sent locally');
  assert.strictEqual(sendCommandCalls.length, 0, 'cloud not used');
  assert.strictEqual(await handler.getActive(), Characteristic.Active.INACTIVE, 'optimistically off');
});
