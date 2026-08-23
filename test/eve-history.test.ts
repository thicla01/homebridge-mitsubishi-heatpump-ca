// The Eve history protocol, pinned against GOLDEN VECTORS captured from the
// reference implementation (fakegato-history 0.6.7) driven with a frozen clock —
// the capture script lives in the session scratchpad and its output is inlined
// here as hex constants. Every multi-byte integer is little-endian; absolute
// times are seconds since the Eve epoch (2001-01-01Z, Unix 978307200).
//
// One deliberate divergence from the reference, pinned by name below: fakegato
// encodes temperature via bitwise ops that TRUNCATE the IEEE754 product toward
// zero, so 8.2°C (8.2*100 = 819.99…) goes on its wire as 8.19°C. We use
// Math.round. The golden scenario's temperatures were chosen where the two
// agree (21.3*100 lands at 2130.0…2, above the integer), so the vectors match
// byte-for-byte; the divergence test uses 8.2, where they do not.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EveHistoryStore, EveHistoryFeed } from '../dist/eve-history.js';
import { makeLog } from './helpers';

const b64ToHex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');
const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

// ---- Golden scenario 1: five entries, explicit timestamps -----------------
// (1767225600, 20.0°C, 50%), then +600s each: (20.5), (21.0), (21.3, 50%), (21.4).
// refTime = 1767225600 - 978307200 = 788918400 = LE 80f0052f.

const T0 = 1767225600;
const SCENARIO1 = [
  { t: T0, temp: 20.0, hum: 50 },
  { t: T0 + 600, temp: 20.5 },
  { t: T0 + 1200, temp: 21.0 },
  { t: T0 + 1800, temp: 21.3, hum: 50 },
  { t: T0 + 2400, temp: 21.4 },
];

const S2R1_AFTER_EACH = [
  '000000000000000080f0052f030102020203020300c00f00000000000000000101',
  '580200000000000080f0052f030102020203020400c00f00000000000000000101',
  'b00400000000000080f0052f030102020203020500c00f00000000000000000101',
  '080700000000000080f0052f030102020203020600c00f00000000000000000101',
  '600900000000000080f0052f030102020203020700c00f00000000000000000101',
];

// Eve's request: only bytes 2..5 (LE32 start counter) are meaningful.
const S2W1_FROM_START = '01140100000000000000000000000000';

// One read: the ref-time record for counter 1, then the five data records.
const S2R2_SESSION1 =
  '1501000000010000008180f0052f0000000000000010020000000000000007d00788130000'
  + '100300000058020000070208000000001004000000b00400000734080000000010050000'
  + '000807000007520888130000100600000060090000075c0800000000';

test('golden: S2R1 matches the reference after every entry', () => {
  const store = new EveHistoryStore();
  SCENARIO1.forEach((entry, i) => {
    store.addEntry(entry);
    assert.strictEqual(b64ToHex(store.statusBase64()), S2R1_AFTER_EACH[i],
      `S2R1 after entry ${i + 1}`);
  });
});

test('golden: a full read session matches the reference, then ends with 0x00', () => {
  const store = new EveHistoryStore();
  SCENARIO1.forEach((e) => store.addEntry(e));

  store.startTransfer(hexToB64(S2W1_FROM_START));
  assert.strictEqual(b64ToHex(store.readChunkBase64()), S2R2_SESSION1);
  assert.strictEqual(b64ToHex(store.readChunkBase64()), '00', 'the session terminator');
  assert.strictEqual(b64ToHex(store.readChunkBase64()), '00', 'idle reads keep answering 0x00');
});

test('golden: the single-entry scenario', () => {
  const store = new EveHistoryStore();
  store.addEntry({ t: T0, temp: 21.5, hum: 45 });

  assert.strictEqual(
    b64ToHex(store.statusBase64()),
    '000000000000000080f0052f030102020203020300c00f00000000000000000101',
    'one sample occupies TWO slots (marker + data), so the count field reads 3',
  );
  store.startTransfer(hexToB64(S2W1_FROM_START));
  assert.strictEqual(
    b64ToHex(store.readChunkBase64()),
    '1501000000010000008180f0052f0000000000000010020000000000000007660894110000',
  );
  assert.strictEqual(b64ToHex(store.readChunkBase64()), '00');
});

test('temperature is rounded, where the reference truncates: 8.2°C is 820, not 819', () => {
  const store = new EveHistoryStore();
  store.addEntry({ t: T0, temp: 8.2 });
  store.startTransfer(hexToB64(S2W1_FROM_START));
  const hex = b64ToHex(store.readChunkBase64());
  // Second record, bytes 10-11 of it: the temperature. 820 = 0x0334 → LE "3403".
  const dataRecord = hex.slice(21 * 2);
  assert.strictEqual(dataRecord.slice(20, 24), '3403',
    'fakegato would serve 3303 (819 = 8.19°C) — its bitwise encode truncates the IEEE754 product');
});

test('an empty store serves an empty status and 0x00 entries, like the reference', () => {
  const store = new EveHistoryStore();
  assert.strictEqual(store.statusBase64(), '');
  store.startTransfer(hexToB64(S2W1_FROM_START));
  assert.strictEqual(b64ToHex(store.readChunkBase64()), '00');
});

test('a request from mid-history starts there, not at the beginning', () => {
  const store = new EveHistoryStore();
  SCENARIO1.forEach((e) => store.addEntry(e));

  // Ask for counter 4 onward. Bytes 2..5 LE. The first record is still a
  // ref-time record — the setTime flag marks the first transfer of a fresh
  // process — and it costs the data point at position 4.
  const req = Buffer.alloc(16);
  req.writeUInt32LE(4, 2);
  store.startTransfer(req.toString('base64'));
  const hex = b64ToHex(store.readChunkBase64());
  const first = hex.slice(0, 21 * 2);
  assert.strictEqual(first.slice(0, 2), '15', 'ref record first (setTime flag)');
  assert.strictEqual(first.slice(2, 10), '04000000', 'at the requested counter');
  assert.strictEqual(first.slice(20, 28), '80f0052f', 'carrying the ORIGINAL refTime');
  // Then data records for 5 and 6.
  const rest = hex.slice(21 * 2);
  assert.strictEqual(rest.slice(0, 2), '10');
  assert.strictEqual(rest.slice(2, 10), '05000000');
});

// ---- Rollover -------------------------------------------------------------

test('a full buffer slides: counters keep climbing, S2R1 flips its two asymmetric fields', () => {
  const store = new EveHistoryStore({ memorySize: 4 });
  // 5 entries: marker@1 + data@2..4 fills the 4 slots; the 4th data entry
  // arrives into a FULL buffer with the restart flag still set, so it inserts a
  // marker (double-advance) and then itself: counters run 1..7.
  for (let i = 0; i < 5; i++) {
    store.addEntry({ t: T0 + i * 600, temp: 20 + i });
  }
  const s2r1 = Buffer.from(store.statusBase64(), 'base64');
  assert.strictEqual(s2r1.readUInt16LE(19), 4, 'count field = usedMemory once full');
  assert.strictEqual(s2r1.readUInt16LE(21), 4, 'memorySize');
  const oldest = s2r1.readUInt32LE(23);
  assert.strictEqual(oldest, store['firstEntry'] + 1, 'oldest-counter field = firstEntry+1 once full');

  // A session over the whole window: position firstEntry+1 always serves a ref
  // record (re-anchor after rollover), then live records to lastEntry.
  const req = Buffer.alloc(16);
  req.writeUInt32LE(oldest, 2);
  store.startTransfer(req.toString('base64'));
  const hex = b64ToHex(store.readChunkBase64());
  assert.strictEqual(hex.slice(0, 2), '15', 'the oldest position re-anchors with a ref record');
  assert.strictEqual(b64ToHex(store.readChunkBase64()), '00');
});

// ---- Persistence ----------------------------------------------------------

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-hist-')), 'unit.json');
}

test('history survives a restart byte-for-byte, and the first read re-anchors', () => {
  const filePath = tmpFile();
  const before = new EveHistoryStore({ filePath, now: () => T0 + 3000 });
  SCENARIO1.forEach((e) => before.addEntry(e));
  const statusBefore = before.statusBase64();

  const after = new EveHistoryStore({ filePath, now: () => T0 + 3000 });
  after.load();
  assert.strictEqual(after.statusBase64(), statusBefore, 'S2R1 identical across the restart');

  after.startTransfer(hexToB64(S2W1_FROM_START));
  assert.strictEqual(b64ToHex(after.readChunkBase64()), S2R2_SESSION1,
    'the whole session replays from disk');
});

test('a corrupt history file starts fresh instead of throwing', () => {
  const filePath = tmpFile();
  fs.writeFileSync(filePath, '{"v":1,"memorySize":'); // truncated JSON: SD power-cut shape
  const store = new EveHistoryStore({ filePath, log: makeLog() as never });
  store.load();
  assert.strictEqual(store.statusBase64(), '', 'fresh, not dead');
});

test('a history that starts in the future is reset — Eve hides future entries silently', () => {
  const filePath = tmpFile();
  const writer = new EveHistoryStore({ filePath });
  writer.addEntry({ t: T0, temp: 20 });

  // The clock the reader sees is BEFORE the first sample: the Pi booted with a
  // wrong clock when this file was written, or lost NTP now.
  const reader = new EveHistoryStore({ filePath, log: makeLog() as never, now: () => T0 - 86400 });
  reader.load();
  assert.strictEqual(reader.statusBase64(), '');
});

test('a non-monotonic sample is skipped, never encoded as a wrapped uint32', () => {
  const store = new EveHistoryStore();
  store.addEntry({ t: T0 + 600, temp: 20 });
  store.addEntry({ t: T0, temp: 21 }); // clock stepped back
  assert.strictEqual(store.size, 2, 'marker + first entry only');
});

// ---- The feed (averaging) -------------------------------------------------

test('the feed commits one averaged entry per tick, stamped at tick time', () => {
  const entries: Array<{ t: number; temp: number; hum?: number }> = [];
  const store = { addEntry: (e: { t: number; temp: number; hum?: number }) => entries.push(e) };
  const feed = new EveHistoryFeed(store as never, 600000, () => T0 + 600);

  feed.pushSample(20.0, 50);
  feed.pushSample(21.0, null);
  feed.pushSample(20.6, undefined);
  feed.tick();

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].t, T0 + 600);
  assert.strictEqual(entries[0].temp, 20.53, 'the mean, at 2 decimals');
  assert.strictEqual(entries[0].hum, 50, 'humidity averages only the samples that carried it');
});

test('an interval with no temperature commits nothing — an honest gap, not a flat line', () => {
  const entries: unknown[] = [];
  const store = { addEntry: (e: unknown) => entries.push(e) };
  const feed = new EveHistoryFeed(store as never, 600000, () => T0);

  feed.pushSample(20, null);
  feed.tick();
  feed.tick(); // the unit was unreachable for this whole interval
  assert.strictEqual(entries.length, 1,
    'the reference repeats the last value forever; through a LAN outage that lies');
});

test('humidity is carried across an interval that had none, once it has been seen', () => {
  const entries: Array<{ hum?: number }> = [];
  const store = { addEntry: (e: { hum?: number }) => entries.push(e) };
  let now = T0;
  const feed = new EveHistoryFeed(store as never, 600000, () => (now += 600));

  feed.pushSample(20, 48);
  feed.tick();
  feed.pushSample(21, null); // sensor went quiet, temperature still flowing
  feed.tick();
  assert.strictEqual(entries[1].hum, 48, 'last observed humidity, not zero');
});

test('NaN and non-numbers never reach the store', () => {
  const entries: unknown[] = [];
  const store = { addEntry: (e: unknown) => entries.push(e) };
  const feed = new EveHistoryFeed(store as never, 600000, () => T0);

  feed.pushSample(NaN, NaN);
  feed.pushSample(undefined, 'wet' as never);
  feed.tick();
  assert.strictEqual(entries.length, 0);
});
