// Regression tests for the background local-credential retry.
//
// The local password arrives only via the `adapter_update` socket event, and
// some adapters answer the nudge slowly (observed: 65s on a healthy unit) or not
// at all until they recover from a wedged cloud session. The original
// initLocalControl waited a fixed 25s and then gave up forever, silently
// stranding those units on the cloud for the life of the process.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoV3Platform } from '../dist/platform.js';
import type { KumoAPI } from '../dist/kumo-api.js';
import type { LocalDeviceCreds, LocalKumoClient, SerialCreds } from '../dist/local-api.js';
import type { KumoConfig } from '../dist/settings.js';
import { makeLog } from './helpers';

const A = 'SERIAL-A';
const B = 'SERIAL-B';

type GatherLocalCreds = (serials: string[], waitMs: number) => Promise<Map<string, SerialCreds>>;

function makeApi() {
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s: string) => `uuid-${s}` } },
    platformAccessory: class {}, // never `new`ed on these paths
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
}

/**
 * Stub KumoAPI whose adapter passwords appear only when the test says so.
 *
 * `passwords`/`nudges` are the test-only recorders.
 */
interface KumoStub extends Pick<
  KumoAPI, 'requestAdapterStatus' | 'getAdapterPassword' | 'getDeviceCryptoSerial' | 'destroy'
> {
  passwords: Map<string, string>;
  nudges: string[];
}

function makeKumoStub(): KumoStub {
  const stub: KumoStub = {
    passwords: new Map(),
    nudges: [],
    requestAdapterStatus(serial: string) {
      stub.nudges.push(serial);
    },
    // Returns the raw lookup: the real getAdapterPassword answers `undefined`,
    // not null, for a device that has not reported one.
    getAdapterPassword(serial: string) {
      return stub.passwords.get(serial);
    },
    async getDeviceCryptoSerial(serial: string) {
      return `crypto-${serial}`;
    },
    destroy() {},
  };
  return stub;
}

interface LocalClientStub extends Pick<LocalKumoClient, 'setCreds' | 'hasLocal' | 'getStatus'> {
  creds: Map<string, LocalDeviceCreds>;
}

function makeLocalClientStub(): LocalClientStub {
  const creds = new Map<string, LocalDeviceCreds>();
  return {
    creds,
    setCreds(serial: string, c: LocalDeviceCreds) {
      creds.set(serial, c);
    },
    hasLocal(serial: string) {
      return creds.has(serial);
    },
    async getStatus() {
      return null;
    },
  };
}

/**
 * A platform wired for local control over two devices, both with configured IPs
 * so admitLocalDevices takes the manual path and never sweeps the LAN.
 *
 * The gather window is compressed here (see below); everything else is the real
 * platform.
 */
function makePlatform() {
  const kumo = makeKumoStub();
  const config: PlatformConfig = {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    localControl: true,
    localControlIps: { [A]: '192.168.1.10', [B]: '192.168.1.11' },
  } satisfies Partial<KumoConfig>;
  const platform = new KumoV3Platform(makeLog() as never, config, makeApi() as never);
  (platform as unknown as { kumoAPI: KumoAPI }).kumoAPI = kumo as never;
  const local = makeLocalClientStub();
  platform.localClient = local as never;
  platform['localSerials'] = [A, B];
  // Local polling is out of scope here — keep the test free of timers.
  platform['startLocalPolling'] = () => {};

  // Compress the credential-gather window.
  //
  // retryLocalCreds bakes the module-level LOCAL_CRED_RETRY_WAIT_MS (10s) into
  // its gatherLocalCreds call, so one pass that finds nothing burns a real 10s;
  // two of them were 22 of this file's 28 seconds. The real gather still runs —
  // same nudges, same password lookup, same cryptoSerial fetch, same admission —
  // only the window it sits inside shrinks, so every assertion below still rides
  // on production code.
  //
  // ~2s per call is the floor from the test side: gatherLocalCreds sleeps a
  // hardcoded 2000ms between nudge rounds whatever window it was handed, and it
  // sleeps that once even when the deadline has already passed. Promoting that
  // interval and LOCAL_CRED_RETRY_WAIT_MS to instance fields in src/platform.ts
  // is what would take this file to milliseconds.
  const gather: GatherLocalCreds = platform['gatherLocalCreds'].bind(platform);
  platform['gatherLocalCreds'] = (serials: string[], waitMs: number) =>
    gather(serials, Math.min(waitMs, 50));

  return { platform, kumo, local };
}

/**
 * The delay a timer was scheduled with. `_idleTimeout` is Node's internal field
 * and is absent from @types/node, but reading it is the only way to assert what
 * was scheduled without waiting the interval out.
 */
function scheduledDelay(timer: NodeJS.Timeout | null): number {
  if (!timer) {
    throw new Error('expected a scheduled timer, found none');
  }
  return (timer as unknown as { _idleTimeout: number })._idleTimeout;
}

test('gatherLocalCreds only returns devices that produced both halves of the key', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');

  const creds: Map<string, SerialCreds> = await platform['gatherLocalCreds']([A, B], 50);

  assert.deepStrictEqual([...creds.keys()], [A]);
  assert.deepStrictEqual(creds.get(A), { password: 'pw-a', cryptoSerial: `crypto-${A}` });
  assert.ok(kumo.nudges.includes(B), 'the straggler should still get nudged');
});

test('a device that answers after the initial window is admitted by the retry', async () => {
  const { platform, kumo, local } = makePlatform();

  // Initial pass: only A answers, B is stranded.
  kumo.passwords.set(A, 'pw-a');
  await platform['admitLocalDevices'](await platform['gatherLocalCreds']([A, B], 50));
  assert.strictEqual(platform.localClient!.hasLocal(A), true);
  assert.strictEqual(platform.localClient!.hasLocal(B), false);
  assert.deepStrictEqual(platform['pendingLocalSerials'](), [B]);

  // B's adapter finally answers the nudge.
  kumo.passwords.set(B, 'pw-b');
  await platform['retryLocalCreds']();

  assert.strictEqual(platform.localClient!.hasLocal(B), true, 'B should now be on local control');
  assert.strictEqual(local.creds.get(B)!.ip, '192.168.1.11');
  assert.strictEqual(platform['countLocalDevices'](), 2);
});

test('the retry only re-nudges devices that are still missing', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');
  await platform['admitLocalDevices'](await platform['gatherLocalCreds']([A, B], 50));

  kumo.nudges.length = 0;
  await platform['retryLocalCreds']();

  assert.ok(kumo.nudges.length > 0);
  assert.ok(!kumo.nudges.includes(A), 'A is already local — no need to nudge it again');
  assert.ok(kumo.nudges.includes(B));
});

test('the retry timer stops once every device is local', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');
  kumo.passwords.set(B, 'pw-b');

  platform['scheduleLocalCredRetry']();
  assert.ok(platform['localCredRetryTimer'], 'a retry should be scheduled while devices are pending');

  await platform['retryLocalCreds']();

  assert.strictEqual(platform['countLocalDevices'](), 2);
  assert.strictEqual(platform['localCredRetryTimer'], null, 'retry should stop when nothing is pending');
});

test('scheduleLocalCredRetry is a no-op when every device is already local', async () => {
  const { platform, local } = makePlatform();
  local.setCreds(A, { ip: '1', password: 'p', cryptoSerial: 'c' });
  local.setCreds(B, { ip: '2', password: 'p', cryptoSerial: 'c' });

  platform['scheduleLocalCredRetry']();

  assert.strictEqual(platform['localCredRetryTimer'], null);
});

test('overlapping retry passes are suppressed', async () => {
  const { platform, kumo } = makePlatform();
  let gathers = 0;
  platform['gatherLocalCreds'] = async () => {
    gathers++;
    await new Promise((r) => setTimeout(r, 30));
    return new Map<string, SerialCreds>();
  };

  const first = platform['retryLocalCreds']();
  await platform['retryLocalCreds'](); // fires while the first pass is mid-sweep
  await first;

  assert.strictEqual(gathers, 1, 'the second pass should bail out rather than double-sweep');
  assert.strictEqual(kumo.nudges.length, 0);
});

test('cleanup clears the retry timer', async () => {
  const { platform } = makePlatform();
  platform['scheduleLocalCredRetry']();
  assert.ok(platform['localCredRetryTimer']);

  platform['cleanup']();

  assert.strictEqual(platform['localCredRetryTimer'], null);
});

// ---- backoff and giving up ------------------------------------------------
//
// Since 2026-07-31 the cloud stopped serving BOTH halves of the local key
// (`password` is gone from adapter_update, `cryptoSerial` from GET
// /devices/{serial}/status — reproduced on unrelated accounts and on pykumo).
// Every pass then re-nudges every device for the whole 10s window and never
// succeeds, so the retry has to back off and eventually stop instead of paying
// that cost forever against a cloud that is not going to answer.
//
// The give-up is in-memory only: nothing is persisted and config.json is never
// rewritten, so `localControl` stays true and local control returns by itself at
// the next restart if the cloud restores the fields (see abandonLocalCreds).

/**
 * Run N fruitless passes without waiting on any timer, in the same order the
 * self-scheduling chain does it (schedule, then run), since the delay grows at
 * schedule time. The real gather is restored on the way out, so a caller can go
 * on to exercise a pass that does find credentials.
 */
async function failPasses(platform: KumoV3Platform, n: number): Promise<void> {
  const gather = platform['gatherLocalCreds'];
  platform['gatherLocalCreds'] = async () => new Map<string, SerialCreds>();
  try {
    for (let i = 0; i < n; i++) {
      platform['scheduleLocalCredRetry']();
      const timer = platform['localCredRetryTimer'];
      if (timer) {
        clearTimeout(timer);
        platform['localCredRetryTimer'] = null;
      }
      await platform['retryLocalCreds']();
    }
  } finally {
    platform['gatherLocalCreds'] = gather;
  }
}

test('the retry delay doubles per failed pass and caps at 30 minutes', () => {
  const { platform } = makePlatform();
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    platform['scheduleLocalCredRetry']();
    delays.push(scheduledDelay(platform['localCredRetryTimer']));
    clearTimeout(platform['localCredRetryTimer']!);
    platform['localCredRetryTimer'] = null;
  }

  assert.deepStrictEqual(delays.slice(0, 6), [60000, 120000, 240000, 480000, 960000, 1800000],
    'a fixed 60s interval against a cloud that never answers is ~1440 wasted emits an hour');
  assert.deepStrictEqual(delays.slice(6), [1800000, 1800000], 'and it stops growing at the cap');
});

test('a pass that yields credentials resets the backoff for the stragglers', async () => {
  const { platform, kumo } = makePlatform();
  await failPasses(platform, 2);
  assert.ok(platform['localCredRetryDelayMs'] > 60000, 'the delay grew while nothing answered');

  // A's adapter finally answers; B is still pending.
  kumo.passwords.set(A, 'pw-a');
  await platform['retryLocalCreds']();

  assert.strictEqual(platform['localCredFailedPasses'], 0);
  assert.strictEqual(platform['localCredRetryDelayMs'], 60000,
    'credentials are flowing again — chase the straggler at the base interval');
  assert.deepStrictEqual(platform['pendingLocalSerials'](), [B]);
});

test('after six fruitless passes the retry gives up and says so once', async () => {
  const { platform, kumo } = makePlatform();
  const warns: string[] = [];
  platform.log.warn = (msg: string) => {
    warns.push(msg);
  };

  await failPasses(platform, 6);

  assert.strictEqual(platform['localCredGaveUp'], true);
  assert.strictEqual(warns.length, 1, 'exactly one warning, not one per pass');
  assert.match(warns[0], /cloud-side change/,
    'the user must not be sent hunting their own network for a cloud-side fault');

  // And it stays stopped.
  kumo.nudges.length = 0;
  platform['scheduleLocalCredRetry']();
  assert.strictEqual(platform['localCredRetryTimer'], null, 'no further passes are scheduled');
  await platform['retryLocalCreds']();
  assert.strictEqual(kumo.nudges.length, 0, 'and nothing is nudged after giving up');
});

test('giving up with nothing local drops the local client so writes go straight to cloud', async () => {
  // accessory.sendDeviceCommand guards on platform.localClient; leaving a client
  // that can never authenticate makes every write try the LAN first and time out.
  const { platform } = makePlatform();
  await failPasses(platform, 6);

  assert.strictEqual(platform.localClient, null);
});

test('giving up KEEPS the client when some units did get credentials', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');
  await platform['admitLocalDevices'](await platform['gatherLocalCreds']([A, B], 50));
  assert.strictEqual(platform['countLocalDevices'](), 1);

  await failPasses(platform, 6);

  assert.strictEqual(platform['localCredGaveUp'], true);
  assert.notStrictEqual(platform.localClient, null,
    'A still works locally — only the chase for B stops');
  assert.strictEqual(platform.localClient!.hasLocal(A), true);
});
