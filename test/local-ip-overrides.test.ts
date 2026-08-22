// Both accepted shapes of localControlIps must reach the LAN transport.
//
// The array shape exists because the Homebridge UI form cannot render a free-form
// map — and an option the form cannot render is one it DROPS. Observed on real
// hardware 2026-08-21: reinstalling the plugin through the UI rewrote the platform
// block from the schema and silently removed the pin, so the startup sweep came
// back with nothing in the log explaining why. The map shape stays supported
// because that is what earlier configs and the JSON editor contain.
//
// The hazard the normalizer removes: indexing an ARRAY by device serial finds
// nothing and throws nothing, so a form-written config would fail exactly like an
// absent one.

import test from 'node:test';
import assert from 'node:assert';

import { normalizeLocalControlIps } from '../dist/settings.js';

const SERIAL = '1234A5678901234B';

test('the array shape the UI form writes is folded into a serial -> IP map', () => {
  assert.deepStrictEqual(
    normalizeLocalControlIps([{ deviceSerial: SERIAL, ip: '192.168.1.42' }]),
    { [SERIAL]: '192.168.1.42' },
  );
});

test('the legacy map shape is passed through unchanged', () => {
  const legacy = { [SERIAL]: '192.168.1.42' };
  assert.deepStrictEqual(normalizeLocalControlIps(legacy), legacy);
});

test('several entries are all carried', () => {
  assert.deepStrictEqual(
    normalizeLocalControlIps([
      { deviceSerial: 'A', ip: '10.0.0.1' },
      { deviceSerial: 'B', ip: '10.0.0.2' },
    ]),
    { A: '10.0.0.1', B: '10.0.0.2' },
  );
});

test('a half-filled row is skipped, not fatal — it is what a live UI edit looks like', () => {
  assert.deepStrictEqual(
    normalizeLocalControlIps([
      { deviceSerial: SERIAL },
      { ip: '192.168.1.43' },
      {},
      { deviceSerial: 'C', ip: '10.0.0.3' },
    ]),
    { C: '10.0.0.3' },
  );
});

test('surrounding whitespace is trimmed off both halves', () => {
  assert.deepStrictEqual(
    normalizeLocalControlIps([{ deviceSerial: `  ${SERIAL} `, ip: ' 192.168.1.42  ' }]),
    { [SERIAL]: '192.168.1.42' },
  );
});

test('absent, empty and empty-array all mean "no overrides"', () => {
  assert.deepStrictEqual(normalizeLocalControlIps(undefined), {});
  assert.deepStrictEqual(normalizeLocalControlIps([]), {});
  assert.deepStrictEqual(normalizeLocalControlIps({}), {});
});
