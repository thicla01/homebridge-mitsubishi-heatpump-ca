'use strict';

// Local sensor reads, transport hardening, and fan-speed vocabulary tolerance.
//
// All five behaviours here came out of an audit against the two reference
// implementations (dlarrick/pykumo and nikolairahimi/mitsubishi-comfort), plus a
// live probe of four units on 2026-07-27.
//
// Measured on that probe:
//   Bedroom     tempSource=sensor0  roomTemp=22.5  sensor temp=22.648632  humidity=51.617188
//   Kids room   tempSource=sensor0  roomTemp=20    sensor temp=20.074610  humidity=63.824219
//   Family Room tempSource=sensor0  roomTemp=22    sensor temp=22.133827  humidity=61.871094
//   Garage      tempSource=unset    roomTemp=21.5  no sensors, no MHK2
//
// Two things that matters for: the unit quantizes roomTemp to 0.5°C before
// reporting it, while the sensor gives ~6 decimals; and humidity is not in
// indoorUnit.status at all, so under local control (where cloud updates are
// dropped for 45s after every local read) it would otherwise go stale.

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyApiError,
  LocalKumoClient,
} = require('../dist/local-api.js');
const { normalizeFanSpeed, FAN_SPEEDS } = require('../dist/settings.js');

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// ---- _api_error classification ------------------------------------------
//
// Discovery sweeps the subnet asking every host to authenticate a token. Only a
// genuine auth rejection proves the IP belongs to a different unit; the adapter's
// transient complaints say nothing about identity. Conflating them (the old
// behaviour) wrote off a momentarily-busy unit as a stranger and stranded it on
// cloud control until a later sweep happened to catch it healthy.

test('only device_authentication_error means "a different unit"', () => {
  assert.strictEqual(classifyApiError('device_authentication_error'), 'auth');
});

test('the adapter\'s transient failures are "busy", not "different unit"', () => {
  assert.strictEqual(classifyApiError('serializer_error'), 'busy',
    'mid-serialization: ask again, do not write the IP off');
  assert.strictEqual(classifyApiError('__no_memory'), 'busy',
    'out of memory: ask again, do not write the IP off');
});

test('an unrecognised error code is not treated as an auth rejection', () => {
  // The dangerous direction is a stray code being read as "different unit",
  // because that permanently removes an IP from consideration during discovery.
  assert.notStrictEqual(classifyApiError('something_new'), 'auth');
  assert.notStrictEqual(classifyApiError(''), 'auth');
});

// ---- Fan-speed vocabulary tolerance --------------------------------------

test('a capitalised fan speed from the unit is recognised', () => {
  // pykumo returns 'Low' (capital L) for units reporting numberOfFanSpeeds: 4.
  // An exact match scores that -1, which the tile renders as "auto" — the unit
  // would misreport its speed and the real speed could never be re-selected.
  assert.strictEqual(normalizeFanSpeed('Low'), 'low');
  assert.strictEqual(normalizeFanSpeed('SUPERQUIET'), 'superQuiet');
  assert.strictEqual(normalizeFanSpeed('superquiet'), 'superQuiet');
});

test('every canonical speed normalizes to itself', () => {
  for (const f of FAN_SPEEDS) {
    assert.strictEqual(normalizeFanSpeed(f), f);
  }
});

test('an unknown fan speed is undefined, never silently "auto"', () => {
  // Callers must be able to tell "unknown" from "auto" — collapsing them would
  // misreport the unit's actual state as an intentional setting.
  assert.strictEqual(normalizeFanSpeed('turbo'), undefined);
  assert.strictEqual(normalizeFanSpeed(''), undefined);
  assert.strictEqual(normalizeFanSpeed(null), undefined);
  assert.strictEqual(normalizeFanSpeed(42), undefined);
});

// ---- Sensor reads --------------------------------------------------------
//
// LocalKumoClient.request is stubbed per test so no network is touched. Bodies
// are matched on their leaf so the assertions read like the wire protocol.

function makeClient(replies) {
  const client = new LocalKumoClient(makeLog());
  client.setCreds('S1', { ip: '10.0.0.1', password: 'cGFzcw==', cryptoSerial: '00112233445566778899' });
  const asked = [];
  client.request = async (serial, body) => {
    const b = body.toString('utf8');
    asked.push(b);
    for (const [needle, reply] of replies) {
      if (b.includes(needle)) {
        return typeof reply === 'function' ? reply() : reply;
      }
    }
    return null;
  };
  return { client, asked };
}

const STATUS_WITH_SENSOR = {
  indoorUnit: {
    status: {
      roomTemp: 22.5, mode: 'cool', spHeat: 20, spCool: 22.8,
      vaneDir: 'horizontal', fanSpeed: 'superQuiet',
      tempSource: 'sensor0', activeThermistor: 'sensor0',
    },
  },
};

const STATUS_NO_SENSOR = {
  indoorUnit: {
    status: {
      roomTemp: 21.5, mode: 'off', spHeat: 18, spCool: null,
      vaneDir: 'auto', fanSpeed: 'auto',
      tempSource: 'unset', activeThermistor: 'unset',
    },
  },
};

test('the sensor temperature replaces the unit\'s 0.5°C-quantized roomTemp', async () => {
  const { client } = makeClient([
    ['indoorUnit', STATUS_WITH_SENSOR],
    ['sensors', { sensors: { 0: { uuid: 'abc', temperature: 22.648632, humidity: 51.617188 } } }],
  ]);

  const status = await client.getStatus('S1');

  // 22.5°C is exactly 72.5°F — the one 0.5°C step where a rounding renderer and a
  // truncating one disagree (73 vs 72). The sensor's 22.648632 is 72.77°F, which
  // both render as 73. This is the live Bedroom reading.
  assert.strictEqual(status.roomTemp, 22.648632,
    'the fine-grained sensor reading wins over the quantized roomTemp');
  assert.strictEqual(status.humidity, 51.617188, 'humidity comes from the sensor');
});

test('a unit with no sensor keeps its own roomTemp and reports no humidity', async () => {
  const { client, asked } = makeClient([
    ['indoorUnit', STATUS_NO_SENSOR],
    ['sensors', { sensors: {} }],
  ]);

  const status = await client.getStatus('S1');

  assert.strictEqual(status.roomTemp, 21.5, 'the head unit thermistor reading is used as-is');
  assert.ok(status.humidity === undefined || status.humidity === null);
  assert.ok(!asked.some((b) => b.includes('sensors')),
    'tempSource=unset means no sensor to ask about — do not spend a request on it');
});

test('MHK2 humidity is used when there is no wireless sensor', async () => {
  const { client } = makeClient([
    ['indoorUnit', STATUS_WITH_SENSOR],
    ['sensors', { sensors: { 0: {} } }],          // present but no uuid => no sensor
    ['mhk2', { mhk2: { status: { indoorHumid: 44.5 } } }],
  ]);

  const status = await client.getStatus('S1');
  assert.strictEqual(status.humidity, 44.5);
});

test('a unit with neither sensor nor MHK2 is asked once, then not again', async () => {
  const { client, asked } = makeClient([
    ['indoorUnit', STATUS_WITH_SENSOR],
    ['sensors', { sensors: { 0: {} } }],
    ['mhk2', { mhk2: { status: { indoorHumid: null } } }],
  ]);

  await client.getStatus('S1');
  const afterFirst = asked.filter((b) => b.includes('sensors') || b.includes('mhk2')).length;
  assert.ok(afterFirst > 0, 'the first poll does look');

  await client.getStatus('S1');
  const afterSecond = asked.filter((b) => b.includes('sensors') || b.includes('mhk2')).length;
  assert.strictEqual(afterSecond, afterFirst,
    'the latch stops a fruitless lookup running on every poll forever');
});

test('sensor slots stop at the first gap', async () => {
  let slot1Asked = false;
  const { client } = makeClient([
    ['indoorUnit', STATUS_WITH_SENSOR],
    ['"0"', { sensors: { 0: {} } }],   // no uuid => list ends here
    ['"1"', () => { slot1Asked = true; return { sensors: { 1: { uuid: 'x', humidity: 50 } } }; }],
    ['mhk2', { mhk2: { status: { indoorHumid: null } } }],
  ]);

  await client.getStatus('S1');
  assert.strictEqual(slot1Asked, false,
    'slots are consecutive: an empty slot 0 means there is no slot 1 to read');
});
