// The two "the cloud stopped serving the local secrets" warnings, and the one
// configuration in which they are FALSE.
//
// Both warnings exist for a real provider-side outage: since 2026-07-31 the v3 cloud
// sends `adapter_update` without `password` and `/devices/{serial}/status` without
// `cryptoSerial` (pykumo #78), which silently disables LAN control. They are right to
// be loud — for a v3 credential source.
//
// Under `localCredentialSource: 'v2'` they are the opposite of helpful. That mode is
// the majority case since the same date: a US account whose v3 control and streaming
// work perfectly, with the two per-device secrets fetched from the v2 cloud instead.
// The v3 streaming socket stays connected and keeps delivering password-less
// `adapter_update` events, so an ungated counter reaches three within seconds and
// announces that "local LAN control cannot authenticate and the plugin is using cloud
// control" while local control is in fact working. Worse, the remedy the line names —
// `localControl: false` — is a config validatePlatformConfig REJECTS next to a v2
// source, so a user who follows the advice turns a working setup into a platform that
// stays idle with every accessory in "No Response". That coupling is asserted here
// rather than described, so the two rules cannot drift apart.
//
// The gate is on the WARNING only: capturing a password that does arrive is unchanged,
// which is what keeps a mixed account (some units still served by v3) working.

import test from 'node:test';
import assert from 'node:assert';

// `import ... = require` and not `import * as sioc`, for the reason spelled out in
// cloud-failure-paths.test.ts: under esModuleInterop a namespace import of a CommonJS
// module without an `__esModule` marker is copied, so patching the copy would leave
// kumo-api.js calling the real `io` and dialling Mitsubishi's socket endpoint.
import sioc = require('socket.io-client');

import { KumoAPI } from '../dist/kumo-api.js';
import { validatePlatformConfig, reconcileImpliedConfig } from '../dist/platform.js';
import type { KumoConfig, LocalCredentialSource } from '../dist/settings.js';

const SERIAL = 'TESTSERIAL001';

type SocketHandler = (data?: unknown) => void;

interface FakeSocket {
  connected: boolean;
  id: string;
  on(event: string, fn: SocketHandler): FakeSocket;
  once(event: string, fn: SocketHandler): FakeSocket;
  emit(): FakeSocket;
  disconnect(): FakeSocket;
  removeAllListeners(): FakeSocket;
  fire(event: string, data?: unknown): void;
}

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, SocketHandler[]>();
  const socket: FakeSocket = {
    connected: false,
    id: 'fake-socket',
    on(event: string, fn: SocketHandler) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(fn);
      return socket;
    },
    once(event: string, fn: SocketHandler) {
      return socket.on(event, fn);
    },
    emit() {
      return socket;
    },
    disconnect() {
      socket.connected = false;
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    fire(event: string, data?: unknown) {
      for (const fn of handlers.get(event) || []) {
        fn(data);
      }
    },
  };
  return socket;
}

interface Recorded {
  warns: string[];
  lines: string[];
}

function makeRecordingLog(): { record: Recorded; log: Record<string, (...a: unknown[]) => void> } {
  const record: Recorded = { warns: [], lines: [] };
  const push = (level: string) => (...args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    record.lines.push(`[${level}] ${text}`);
    if (level === 'warn') {
      record.warns.push(text);
    }
  };
  return {
    record,
    log: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') },
  };
}

/**
 * A KumoAPI with its socket listeners wired to a fake socket that never connects.
 *
 * `connect_error` is fired to settle startStreaming's promise — the listeners are
 * registered synchronously before it awaits, so `adapter_update` is live either way,
 * and without it the 20s connect timer would hold the runner open.
 */
async function streamingApi(
  source: LocalCredentialSource,
): Promise<{ api: KumoAPI; socket: FakeSocket; record: Recorded; restore: () => void }> {
  const socket = makeFakeSocket();
  const realIo = sioc.io;
  sioc.io = (() => socket) as never;
  const { record, log } = makeRecordingLog();
  const api = new KumoAPI('user@example.com', 'secret', log as never, false, true, false, source);
  api['accessToken'] = 'test-token';
  const started = api.startStreaming([SERIAL]);
  socket.fire('connect_error', new Error('never mind, we only want the listeners'));
  await started;
  return {
    api,
    socket,
    record,
    restore: () => {
      sioc.io = realIo;
    },
  };
}

/** N `adapter_update` events for a real device, none of them carrying a password. */
function firePasswordless(socket: FakeSocket, n: number): void {
  for (let i = 0; i < n; i++) {
    socket.fire('adapter_update', {
      deviceSerial: SERIAL,
      firmwareVersion: '02.02.00',
      routerRssi: -48,
    });
  }
}

// ---- adapter_update without a password -----------------------------------

test('a v3 credential source still reports the missing adapter password', async () => {
  // The control. This warning is the only signal a v3 user gets that local control
  // has been disabled by the provider, so gating it must not silence it here.
  const { api, socket, record, restore } = await streamingApi('v3');
  try {
    firePasswordless(socket, 3);

    const named = record.warns.filter((w) => /stopped sending the per-device local password/.test(w));
    assert.strictEqual(named.length, 1, 'exactly one warning, not one per event');
    assert.match(named[0], /localCredentialSource: "v2"/, 'and it points at the fix');
  } finally {
    api.destroy();
    restore();
  }
});

test('a v2 credential source stays silent about it, however many events arrive', async () => {
  // The defect: with the v3 socket connected and the secrets coming from v2, three
  // events land within seconds of startup and the plugin announced a broken local
  // control that is working — while recommending a config the validator rejects.
  const { api, socket, record, restore } = await streamingApi('v2');
  try {
    firePasswordless(socket, 10);

    assert.deepStrictEqual(
      record.warns.filter((w) => /local password|cannot authenticate|localControl: false/.test(w)),
      [],
      'v3 not carrying the secrets is EXPECTED under a v2 source, not an outage',
    );
    assert.strictEqual(api['adapterUpdatesWithoutPassword'], 0,
      'and the counter never even starts, so a later socket reconnect cannot trip it');
  } finally {
    api.destroy();
    restore();
  }
});

test('the silence is on the warning only — a password that does arrive is still captured', async () => {
  // A v2 source does not mean v3 is forbidden (that is `cloudRegion: 'ca'`). If the
  // provider starts serving the password again, or serves it for some units, the
  // capture must keep working: gating the capture instead of the warning would break
  // exactly the accounts this mode was added for.
  const { api, socket, restore } = await streamingApi('v2');
  try {
    socket.fire('adapter_update', { deviceSerial: SERIAL, password: 'cGFzcw==' });

    assert.strictEqual(api.getAdapterPassword(SERIAL), 'cGFzcw==');
  } finally {
    api.destroy();
    restore();
  }
});

// ---- /devices/{serial}/status without a cryptoSerial ----------------------

/** A status endpoint that answers 200 with the cryptoSerial field simply absent. */
function stubStatusWithoutCryptoSerial(api: KumoAPI): void {
  api['makeAuthenticatedRequest'] = async () => ({ firmwareVersion: '02.02.00' });
}

test('a v3 credential source still reports the missing cryptoSerial', async () => {
  const { record, log } = makeRecordingLog();
  const api = new KumoAPI('user@example.com', 'secret', log as never, false, false, false, 'v3');
  stubStatusWithoutCryptoSerial(api);
  try {
    assert.strictEqual(await api.getDeviceCryptoSerial(SERIAL), null);
    assert.strictEqual(await api.getDeviceCryptoSerial(SERIAL), null);

    const named = record.warns.filter((w) => /stopped returning cryptoSerial/.test(w));
    assert.strictEqual(named.length, 1, 'latched: this endpoint is polled per retry pass');
  } finally {
    api.destroy();
  }
});

test('a v2 credential source stays silent about the missing cryptoSerial too', async () => {
  // Reachable only if something calls it in that mode — gatherV2Creds does not — but
  // gated for the same reason as its sibling: under a v2 source the v3 endpoint is
  // not where the value is expected to come from, so its absence is not an outage.
  const { record, log } = makeRecordingLog();
  const api = new KumoAPI('user@example.com', 'secret', log as never, false, false, false, 'v2');
  stubStatusWithoutCryptoSerial(api);
  try {
    assert.strictEqual(await api.getDeviceCryptoSerial(SERIAL), null);

    assert.deepStrictEqual(record.warns.filter((w) => /cryptoSerial|localControl: false/.test(w)), []);
  } finally {
    api.destroy();
  }
});

// ---- why the silence matters, not just that it is silent ------------------

test('the remedy those warnings name cannot work under a v2 source, so it is never named there', async () => {
  // The coupling that makes the gate load-bearing rather than cosmetic: a user who
  // follows "set localControl: false to silence this" while the secrets come from v2
  // does not get what the advice promises. Until 2.3.0-ca.8 they got an idle platform
  // — every accessory in "No Response" until they undid it. They now get the value
  // ignored instead, because the Homebridge UI writes that same false on its own and
  // going idle over it cost a working install its heat pump (see
  // reconcileImpliedConfig). Either way the advice does not silence anything, which
  // is why it must never be given in this mode.
  const base = {
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    localCredentialSource: 'v2',
  } as unknown as KumoConfig;

  assert.strictEqual(validatePlatformConfig(base), null, 'the working config is valid');

  const taken = { ...base, localControl: false } as unknown as KumoConfig;
  const notes = reconcileImpliedConfig(taken);
  assert.match(notes.join(' '), /localControl "false" was ignored/,
    'taking the advice is absorbed, not honoured');
  assert.strictEqual(taken.localControl, undefined, 'the value does not survive');
  assert.strictEqual(validatePlatformConfig(taken), null, 'and it is no longer fatal');

  const { api, socket, record, restore } = await streamingApi('v2');
  try {
    firePasswordless(socket, 5);
    assert.deepStrictEqual(record.lines.filter((l) => l.includes('localControl: false')), [],
      'so no log line at any level may suggest it here');
  } finally {
    api.destroy();
    restore();
  }
});
