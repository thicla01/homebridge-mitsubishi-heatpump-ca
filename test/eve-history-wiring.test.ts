// The hap side of Eve history: the custom service built against REAL hap-nodejs
// (the same instance Homebridge 2.x embeds), driven through hap's own request
// handlers rather than by calling our functions directly — what is being pinned
// is that the base64/DATA plumbing works end to end, not that our store works
// (test/eve-history.test.ts owns that).
//
// Also pins the two guards in the accessory constructor: a fake-harness platform
// (no api.hap) must construct with history silently absent, and the setup path
// must never throw — the platform-constructor rule in CLAUDE.md reaches here.

import test from 'node:test';
import assert from 'node:assert';
import * as realHap from '@homebridge/hap-nodejs';

import {
  EveHistoryStore,
  attachEveHistory,
  EVE_HISTORY_SERVICE_UUID,
} from '../dist/eve-history.js';
import { KumoThermostatAccessory } from '../dist/accessory.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const S2R1_UUID = 'E863F116-079E-48FF-8F27-9C2605A29F52';
const S2R2_UUID = 'E863F117-079E-48FF-8F27-9C2605A29F52';
const S2W1_UUID = 'E863F11C-079E-48FF-8F27-9C2605A29F52';
const S2W2_UUID = 'E863F121-079E-48FF-8F27-9C2605A29F52';

/** The minimal PlatformAccessory surface attachEveHistory touches. */
function stubAccessory() {
  const services: realHap.Service[] = [];
  return {
    displayName: 'Salon',
    services,
    addService(s: realHap.Service) {
      services.push(s);
      return s;
    },
  };
}

test('the service carries the four Eve characteristics with the documented perms', () => {
  const store = new EveHistoryStore();
  const service = attachEveHistory(realHap as never, stubAccessory() as never, store);

  assert.strictEqual(service.UUID, EVE_HISTORY_SERVICE_UUID);
  for (const uuid of [S2R1_UUID, S2R2_UUID, S2W1_UUID, S2W2_UUID]) {
    const ch = service.characteristics.find((c) => c.UUID === uuid);
    assert.ok(ch, `characteristic ${uuid}`);
    assert.ok(ch.props.perms.includes(realHap.Perms.HIDDEN),
      'hidden from ordinary HomeKit clients; only Eve knows to look');
  }
});

test('a full Eve session works through hap-nodejs request handlers', async () => {
  const store = new EveHistoryStore();
  store.addEntry({ t: 1767225600, temp: 21.5, hum: 45 });
  const service = attachEveHistory(realHap as never, stubAccessory() as never, store);

  const byUuid = (uuid: string) => service.characteristics.find((c) => c.UUID === uuid)!;
  // hap-nodejs dispatches controller reads/writes through these; if they are
  // renamed in a future hap, this test fails here rather than in someone's home.
  assert.strictEqual(typeof byUuid(S2R1_UUID).handleGetRequest, 'function');
  assert.strictEqual(typeof byUuid(S2W1_UUID).handleSetRequest, 'function');

  const status = await byUuid(S2R1_UUID).handleGetRequest();
  assert.strictEqual(
    Buffer.from(String(status), 'base64').toString('hex'),
    '000000000000000080f0052f030102020203020300c00f00000000000000000101',
  );

  const req = Buffer.alloc(16);
  req.writeUInt32LE(1, 2);
  await byUuid(S2W1_UUID).handleSetRequest(req.toString('base64'));
  // Eve also pushes its wall clock; the write must be ACCEPTED (or the session
  // stalls) and the payload discarded.
  await byUuid(S2W2_UUID).handleSetRequest(Buffer.from('00112233', 'hex').toString('base64'));

  const chunk = await byUuid(S2R2_UUID).handleGetRequest();
  assert.strictEqual(
    Buffer.from(String(chunk), 'base64').toString('hex'),
    '1501000000010000008180f0052f0000000000000010020000000000000007660894110000',
  );
  const end = await byUuid(S2R2_UUID).handleGetRequest();
  assert.strictEqual(Buffer.from(String(end), 'base64').toString('hex'), '00');
});

test('committing an entry pushes a fresh S2R1 value (the NOTIFY that wakes Eve)', () => {
  const store = new EveHistoryStore();
  const service = attachEveHistory(realHap as never, stubAccessory() as never, store);
  const s2r1 = service.characteristics.find((c) => c.UUID === S2R1_UUID)!;

  store.addEntry({ t: 1767225600, temp: 20 });
  assert.strictEqual(
    Buffer.from(String(s2r1.value), 'base64').toString('hex'),
    store.statusBase64() === '' ? '' : Buffer.from(store.statusBase64(), 'base64').toString('hex'),
  );
  assert.ok(String(s2r1.value).length > 0, 'the value was actually pushed');
});

test('re-attaching (the cached-accessory path) reuses the service instead of duplicating it', () => {
  const accessory = stubAccessory();
  const store = new EveHistoryStore();
  attachEveHistory(realHap as never, accessory as never, store);
  attachEveHistory(realHap as never, accessory as never, store);
  assert.strictEqual(accessory.services.length, 1);
});

// ---- The accessory-side guards -------------------------------------------

function makeFakePlatform(over: Record<string, unknown> = {}) {
  return {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
    ...over,
  };
}

const kumoAPI = {
  subscribeToDevice() {},
  onDeviceProfileUpdate() {},
  sendCommand() {
    return Promise.resolve(true);
  },
};

test('under the fake harness (no api.hap), history is silently absent — nothing throws', () => {
  const handler = new KumoThermostatAccessory(
    makeFakePlatform() as never, makeAccessory() as never, kumoAPI as never, 30,
  );
  assert.strictEqual((handler as never as { eveFeed?: unknown }).eveFeed, undefined);
});

/**
 * The standard fake accessory, taught to hold real hap Service instances too.
 * The accessory constructor adds its OWN services (Fanv2, switches) through the
 * fake string-typed addService; attachEveHistory adds a real hap Service
 * instance and reads it back through `.services` — the same dual surface a real
 * PlatformAccessory offers. Dispatching on the argument keeps both worlds.
 */
function makeHybridAccessory() {
  const base = makeAccessory();
  const services: realHap.Service[] = [];
  const fakeAddService = base.addService.bind(base);
  return Object.assign(base, {
    services,
    addService(typeOrService: unknown, name?: string, subtype?: string) {
      if (typeof typeOrService === 'string') {
        return fakeAddService(typeOrService, name, subtype);
      }
      services.push(typeOrService as realHap.Service);
      return typeOrService;
    },
  });
}

test('eveHistory: false opts out even when a real hap is available', () => {
  const accessory = makeHybridAccessory();
  const platform = makeFakePlatform({
    api: {
      updatePlatformAccessories() {},
      hap: realHap,
      user: { storagePath: () => '/nonexistent-and-never-written' },
    },
    kumoConfig: {
      showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true,
      eveHistory: false,
    },
  });
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  assert.strictEqual((handler as never as { eveFeed?: unknown }).eveFeed, undefined);
  assert.strictEqual(accessory.services.length, 0, 'no service was added');
});

test('with a real hap and a storage path, the feed starts and the service exists', () => {
  const accessory = makeHybridAccessory();
  const platform = makeFakePlatform({
    api: {
      updatePlatformAccessories() {},
      hap: realHap,
      // The store only touches this path on SAVE, and no entry is committed in
      // this test, so nothing is written.
      user: { storagePath: () => '/nonexistent-and-never-written' },
    },
  });
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  assert.ok((handler as never as { eveFeed?: unknown }).eveFeed, 'the feed is running');
  assert.strictEqual(accessory.services.length, 1);
  assert.strictEqual(accessory.services[0].UUID, EVE_HISTORY_SERVICE_UUID);
});
