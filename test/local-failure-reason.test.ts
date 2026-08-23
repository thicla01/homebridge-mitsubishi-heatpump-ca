// Regression test: a failed local status read must say WHY.
//
// `getStatus` collapses every failure into `null`, which is all its callers need
// — but the poller logs that null, and one string for six causes made a real
// incident unreadable. On live hardware, three episodes in three days (2026-08-20
// twice, 2026-08-22), up to sixteen consecutive failed polls and four minutes of
// stale tile, every one of them reported as "no usable status in the reply". The
// classification already existed one call down in `requestDetailed` and was thrown
// away at the one place a human would read it.
//
// The distinction is not cosmetic. "unreachable" and "the unit says it is busy"
// call for opposite responses: the first points at DHCP, wifi or a powered-off
// unit, the second at an adapter that is overloaded or wedged and will recover on
// its own — or, if it does not, is a candidate for the reboot escalation pykumo
// carries. Without the cause in the log neither diagnosis can be made, and neither
// remedy can be chosen.
//
// Driven against a real http server rather than a mock, like its neighbours in
// local-http.test.ts: what is being pinned is how the plugin reads what actually
// comes back on the socket.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { LocalKumoClient, describeLocalFailure } from '../dist/local-api.js';
import { makeLog } from './helpers';

const SERIAL = 'TESTSERIAL001';
const CS = '0123456789abcdef0123';
const PW = Buffer.from('local-secret').toString('base64');

interface Adapter { ip: string; close(): Promise<void> }

/** A fake adapter that answers every request with `payload`. */
async function startAdapter(payload: unknown | null): Promise<Adapter> {
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* drain */ });
    req.on('end', () => {
      if (payload === null) {
        return; // never answers
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ip: `127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => resolve());
    }),
  };
}

function makeClient(ip: string, timeoutMs = 500) {
  const client = new LocalKumoClient(makeLog() as never, timeoutMs);
  client.setCreds(SERIAL, { ip, password: PW, cryptoSerial: CS });
  return client;
}

const CASES: Array<{ name: string; payload: unknown | null; expected: string }> = [
  {
    name: 'a busy adapter reports "busy", not a generic failure',
    payload: { _api_error: '__no_memory' },
    expected: 'busy',
  },
  {
    name: 'a rejected token reports "auth"',
    payload: { _api_error: 'device_authentication_error' },
    expected: 'auth',
  },
  {
    name: 'a reply with no roomTemp reports "incomplete", not a request failure',
    payload: { r: { indoorUnit: { status: { mode: 'heat', spHeat: 20 } } } },
    expected: 'incomplete',
  },
  {
    name: 'an unrecognised error code reports "malformed"',
    payload: { _api_error: 'something_new_from_the_vendor' },
    expected: 'malformed',
  },
];

for (const c of CASES) {
  test(c.name, async () => {
    const adapter = await startAdapter(c.payload);
    try {
      const { status, error } = await makeClient(adapter.ip).getStatusDetailed(SERIAL);
      assert.strictEqual(status, null, 'no usable status either way');
      assert.strictEqual(error, c.expected);
    } finally {
      await adapter.close();
    }
  });
}

test('an adapter that never answers reports "transport"', async () => {
  const adapter = await startAdapter(null);
  try {
    const { status, error } = await makeClient(adapter.ip, 300).getStatusDetailed(SERIAL);
    assert.strictEqual(status, null);
    assert.strictEqual(error, 'transport');
  } finally {
    await adapter.close();
  }
});

test('a good reply reports no failure and still carries the status', async () => {
  const adapter = await startAdapter({ r: { indoorUnit: { status: { mode: 'heat', roomTemp: 21.5, spHeat: 20 } } } });
  try {
    const { status, error } = await makeClient(adapter.ip).getStatusDetailed(SERIAL);
    assert.strictEqual(error, 'none');
    assert.strictEqual(status?.roomTemp, 21.5);
  } finally {
    await adapter.close();
  }
});

test('getStatus keeps its old shape for every other caller', async () => {
  const adapter = await startAdapter({ _api_error: '__no_memory' });
  try {
    assert.strictEqual(await makeClient(adapter.ip).getStatus(SERIAL), null);
  } finally {
    await adapter.close();
  }
});

// The strings are what the user actually reads, so they are pinned: each cause
// must produce a DISTINCT, non-empty line. A switch that fell through to a shared
// default would defeat the entire point of the change while every test above
// still passed.
test('every failure kind describes itself, and no two describe themselves alike', () => {
  const kinds = ['transport', 'auth', 'busy', 'malformed', 'no-creds', 'incomplete'] as const;
  const seen = new Map<string, string>();
  for (const kind of kinds) {
    const text = describeLocalFailure(kind);
    assert.ok(text && text.length > 10, `${kind} needs a real description`);
    assert.ok(!seen.has(text), `${kind} and ${seen.get(text)} describe themselves identically`);
    seen.set(text, kind);
  }
  assert.match(describeLocalFailure('busy'), /busy|wedged/i, 'the busy case must be recognisable as such');
});
