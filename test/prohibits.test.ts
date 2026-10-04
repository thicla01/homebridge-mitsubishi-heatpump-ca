// The unit's lockouts: what they are, how they are read, and what they are allowed
// to change — which is the log, and only the log.
//
// Found by enumerating a real GX15 on 2026-10-03 (tools/kumo-probe.mjs):
// `indoorUnit.prohibits` holds `global`, `local` and `effective`, each with
// `{power, mode, setpoint}` booleans. All false on the unit measured.
//
// The reason to read them at all: the adapter does not reject a write it ignores
// (`vaneDir: "notARealVane"` answers success), so while a lock is on, "Command
// accepted by API" cannot be taken to mean "applied". The reason never to ACT on
// them: what the firmware does with a locked write is unmeasured, and a needless
// refusal costs heat where a needless warning costs a line of log.

import test from 'node:test';
import assert from 'node:assert';

import { controlsTouchedBy, describeLocks, parseProhibits } from '../dist/prohibits.js';

/** The object the real unit returned, verbatim. */
const REAL_UNLOCKED = {
  global: { power: false, mode: false, setpoint: false },
  local: { power: false, mode: false, setpoint: false },
  effective: { power: false, mode: false, setpoint: false },
};

// ---- parsing ----------------------------------------------------------------

test('the real unit\'s reply parses to three empty sets', () => {
  const p = parseProhibits(REAL_UNLOCKED);
  assert.ok(p);
  assert.deepStrictEqual([...p.effective], []);
  assert.deepStrictEqual([...p.global], []);
  assert.deepStrictEqual([...p.local], []);
});

test('a lock is read from each scope independently', () => {
  const p = parseProhibits({
    global: { power: false, mode: true, setpoint: false },
    local: { power: false, mode: false, setpoint: true },
    effective: { power: false, mode: true, setpoint: true },
  });
  assert.ok(p);
  assert.deepStrictEqual([...p.effective].sort(), ['mode', 'setpoint']);
  assert.deepStrictEqual([...p.global], ['mode']);
  assert.deepStrictEqual([...p.local], ['setpoint']);
});

test('only a literal true counts as locked', () => {
  // "Cannot tell" must not raise a warning: a false alarm teaches the reader to
  // ignore the real one. A string, a number, null — none of them is `true`.
  const p = parseProhibits({
    effective: { power: 'true', mode: 1, setpoint: null },
  });
  assert.ok(p);
  assert.deepStrictEqual([...p.effective], []);
});

test('no effective scope is "cannot tell", not "unlocked" and not a guess', () => {
  // How the firmware combines global and local is inferred from the names, not
  // measured — so a reply with only those two must not be folded into an answer.
  assert.strictEqual(parseProhibits({ global: { setpoint: true }, local: {} }), null);
  assert.strictEqual(parseProhibits({ effective: 'nope' }), null);
  assert.strictEqual(parseProhibits(null), null);
  assert.strictEqual(parseProhibits('__invalid_api_request'), null);
});

test('missing global or local scopes leave those sets empty, effective still read', () => {
  const p = parseProhibits({ effective: { setpoint: true } });
  assert.ok(p);
  assert.deepStrictEqual([...p.effective], ['setpoint']);
  assert.deepStrictEqual([...p.global], []);
  assert.deepStrictEqual([...p.local], []);
});

// ---- which controls a command exercises -------------------------------------

test('an off exercises power', () => {
  assert.deepStrictEqual(controlsTouchedBy({ operationMode: 'off' }, true), ['power']);
});

test('a mode sent to a unit that is off turns it on: power and mode', () => {
  // On the LAN, power IS the mode — local commands carry no power field.
  assert.deepStrictEqual(controlsTouchedBy({ operationMode: 'heat' }, false), ['power', 'mode']);
});

test('a mode sent to a unit that is on is a mode change only', () => {
  assert.deepStrictEqual(controlsTouchedBy({ operationMode: 'cool' }, true), ['mode']);
});

test('a mode with the unit\'s state unknown is counted against both locks', () => {
  // A lock this might hit is worth mentioning; the cost of over-mentioning is a line.
  assert.deepStrictEqual(controlsTouchedBy({ operationMode: 'auto' }, null), ['power', 'mode']);
});

test('either setpoint exercises the setpoint lock', () => {
  assert.deepStrictEqual(controlsTouchedBy({ spHeat: 20 }, true), ['setpoint']);
  assert.deepStrictEqual(controlsTouchedBy({ spCool: 24 }, true), ['setpoint']);
  assert.deepStrictEqual(controlsTouchedBy({ spHeat: 20, spCool: 24 }, true), ['setpoint']);
});

test('fan speed and vane are covered by none of the three locks', () => {
  assert.deepStrictEqual(controlsTouchedBy({ fanSpeed: 'quiet' }, true), []);
  assert.deepStrictEqual(controlsTouchedBy({ vaneDir: 'swing' }, true), []);
});

test('the power field is ignored — the LAN never sends it', () => {
  // buildLocalCommandBody drops `power`, and this is only consulted after a LOCAL
  // send, so counting it would flag a power lock on commands that cannot touch power.
  assert.deepStrictEqual(controlsTouchedBy({ power: 0 }, true), []);
  assert.deepStrictEqual(controlsTouchedBy({ operationMode: 'heat', power: 1 }, true), ['mode']);
});

test('a scene\'s full command is counted against every lock it touches', () => {
  assert.deepStrictEqual(
    controlsTouchedBy({ operationMode: 'heat', spHeat: 21, fanSpeed: 'auto' }, false),
    ['power', 'mode', 'setpoint'],
  );
});

// ---- rendering ----------------------------------------------------------------

test('locks render in a fixed order, so the same set always reads the same', () => {
  // The platform compares renderings to decide whether a lock CHANGED; an order
  // that followed insertion would report a change that did not happen.
  assert.strictEqual(describeLocks(new Set(['setpoint', 'power'] as const)), 'power, setpoint');
  assert.strictEqual(describeLocks(new Set(['power', 'setpoint'] as const)), 'power, setpoint');
  assert.strictEqual(describeLocks(new Set()), 'none');
});
