// Regression test for Fahrenheit-anchored setpoint quantization.
//
// The Home app is Celsius-native and converts to °F only for display, so a "72°F"
// tap arrives as an arbitrary Celsius float. Upstream set HAP `minStep: 0.1` on the
// setpoint characteristics believing that would make °F round-trip; it does not.
// hap-nodejs applies minStep only on the OUTBOUND path (`validateUserInput`) — the
// inbound controller-write path (`validateClientSuppliedValue`) returns the float
// verbatim. The minStep grid is also anchored at `minValue`, so with minValue 10 a
// 72°F write lands on 10 + 122 * 0.1 = 22.200000000000003 (IEEE-754 dirt that then
// leaks into commands, logs and mirror signatures).
//
// Separately, rounding lived in the LAN transport only (`round1` in local-api.ts) and
// never on the cloud path, so the same tap stored a different value depending on
// which transport won. quantizeSetpointC sits above both transports and snaps every
// write to the 0.5°C point nearest a whole °F — the only grid the v3 cloud has
// accepted since late October 2026 (HTTP 400 invalidSpHeatIncrement otherwise).

import test from 'node:test';
import assert from 'node:assert';

import type { DeviceProfile } from '../dist/settings.js';
import {
  capRange,
  cToF,
  fToC,
  quantizeSetpointC,
  quantizeSetpointInRange,
  quantizeSetpointCelsius,
  quantizeSetpointInRangeCelsius,
  sameSetpoint,
  thresholdRange,
} from '../dist/temperature.js';

/** What the Home app would show for a stored Celsius value. */
function displayedF(c: number): number {
  return Math.round(cToF(c));
}

test('cToF / fToC are exact at the anchors', () => {
  assert.strictEqual(cToF(0), 32);
  assert.strictEqual(cToF(100), 212);
  assert.strictEqual(fToC(32), 0);
  assert.strictEqual(fToC(212), 100);
});

test('every whole °F from 50 to 90 round-trips through 0.5°C storage', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.strictEqual(displayedF(stored), f,
      `${f}°F stored as ${stored}°C displays back as ${displayedF(stored)}°F`);
  }
});

test('the whole-°F round-trip survives ±0.2°C of controller jitter', () => {
  for (let f = 50; f <= 90; f++) {
    for (const jitter of [-0.2, -0.05, 0, 0.05, 0.2]) {
      const stored = quantizeSetpointC(fToC(f) + jitter);
      assert.strictEqual(displayedF(stored), f,
        `${f}°F + ${jitter}°C should still land on ${f}°F, got ${displayedF(stored)}°F`);
    }
  }
});

test('72°F lands on 22.0°C, the nearest half degree', () => {
  // 72°F is 22.2222°C. The 0.1°C grid this replaces stored it as 22.3; the cloud now
  // refuses that, and of the two half degrees around it 22.0 is the nearer.
  const stored = quantizeSetpointC(fToC(72));
  assert.strictEqual(stored, 22);
  assert.strictEqual(displayedF(stored), 72);
});

test('every stored value is a multiple of 0.5°C — the only grid the cloud accepts', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const stored = quantizeSetpointC(c);
    assert.strictEqual(stored * 2, Math.round(stored * 2), `${c} stored as ${stored}, off the 0.5 grid`);
  }
});

// ---- What the 0.5°C grid costs --------------------------------------------
//
// Measured by upstream on real hardware 2026-07-27: the Mitsubishi Comfort app
// TRUNCATES when it renders Celsius as Fahrenheit, while the Apple Home app rounds.
// The 0.1°C grid took the ceiling so both agreed. On a 0.5°C grid no point is right
// in both apps for about half the degrees, and the Home app is the one kept exact.

test('the stored value stays within 0.25°C of its degree, so a rounding renderer is exact', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.ok(Math.abs(stored - fToC(f)) < 0.25, `${f}°F stored as ${stored}, a quarter degree or more away`);
    assert.strictEqual(Math.round(cToF(stored)), f);
  }
});

test('a truncating renderer shows some degrees one low — the documented cost, pinned', () => {
  // 72°F → 22.0°C = 71.6°F → 71 in the Comfort app. 73°F → 23.0°C = 73.4°F → 73.
  assert.strictEqual(Math.floor(cToF(quantizeSetpointC(fToC(72)))), 71);
  assert.strictEqual(Math.floor(cToF(quantizeSetpointC(fToC(73)))), 73);
  let low = 0;
  for (let f = 50; f <= 90; f++) {
    const shown = Math.floor(cToF(quantizeSetpointC(fToC(f))) + 1e-9);
    assert.ok(shown === f || shown === f - 1, `${f}°F truncates to ${shown}, more than one degree off`);
    low += shown === f - 1 ? 1 : 0;
  }
  assert.ok(low > 0 && low < 41, `${low} of 41 degrees show one low: some, not all`);
});

test('distinct whole °F map to distinct stored values (no two-°F collapse)', () => {
  const seen = new Set<number>();
  for (let f = 50; f <= 90; f++) {
    seen.add(quantizeSetpointC(fToC(f)));
  }
  assert.strictEqual(seen.size, 41, 'each of the 41 °F degrees gets its own 0.5°C point');
});

test('results never carry IEEE-754 dirt', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.strictEqual(stored, Number(stored.toFixed(1)),
      `${stored} is not a clean one-decimal value`);
  }
});

test('the upstream minStep grid value is cleaned up, not passed through', () => {
  // What hap-nodejs' minValue-anchored 0.1 grid actually produces for 72°F.
  const dirty = 10 + Math.round((fToC(72) - 10) / 0.1) * 0.1;
  assert.notStrictEqual(dirty, 22.2, 'sanity: the upstream grid really is dirty');

  const stored = quantizeSetpointC(dirty);
  assert.strictEqual(stored, 22, 'the dirty 72°F value is re-snapped onto the grid');
  assert.strictEqual(stored, Number(stored.toFixed(1)));
});

test('quantizeSetpointC is idempotent across the usable range', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const once = quantizeSetpointC(c);
    assert.strictEqual(quantizeSetpointC(once), once, `not idempotent at ${c}`);
  }
});

test('quantizeSetpointInRange is idempotent, including outside the range', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const once = quantizeSetpointInRange(c, 10, 31);
    assert.strictEqual(quantizeSetpointInRange(once, 10, 31), once, `not idempotent at ${c}`);
  }
});

test('an in-range value is still snapped to the grid, not passed through raw', () => {
  // "In range" does not mean "leave alone": a source setpoint sitting off the
  // grid (e.g. mirrored from a unit set in Celsius) must still be snapped, or it
  // propagates the display drift this module exists to remove.
  assert.strictEqual(quantizeSetpointInRange(fToC(68), 10, 31), quantizeSetpointC(fToC(68)));
  assert.strictEqual(quantizeSetpointInRange(fToC(72), 10, 31), 22);
  assert.strictEqual(quantizeSetpointInRange(22.3, 10, 31), 22,
    'a legacy 0.1°C value a unit still holds is snapped — the cloud would refuse it as is');
});

test('the real 10–31°C device range: below the floor snaps up to 50°F', () => {
  // 10°C is exactly 50°F, so the bottom bound is itself on the grid.
  assert.strictEqual(quantizeSetpointInRange(9.4, 10, 31), 10);
  assert.strictEqual(quantizeSetpointInRange(0, 10, 31), 10);
  assert.strictEqual(displayedF(quantizeSetpointInRange(0, 10, 31)), 50);
});

test('the real 10–31°C device range: an 88°F request reaches the ceiling itself', () => {
  // 31°C is 87.8°F — not a whole °F. 88°F is 31.11°C, but it is STORED as 31.0, the
  // bound itself. (Under the 0.1°C grid it stored as 31.2 and fell back to 87°F.)
  const out = quantizeSetpointInRange(fToC(88), 10, 31);
  assert.strictEqual(out, 31);
  assert.strictEqual(displayedF(out), 88);
  assert.strictEqual(quantizeSetpointInRange(fToC(95), 10, 31), 31, 'and anything above lands there too');
});

test('clamped values stay inside the range and on the °F grid', () => {
  const min = 10;
  const max = 31;
  for (let f = 40; f <= 100; f++) {
    const out = quantizeSetpointInRange(fToC(f), min, max);
    assert.ok(out >= min && out <= max, `${f}°F produced ${out}°C, outside [${min},${max}]`);
    assert.strictEqual(out, Number(out.toFixed(1)), `${out} is not a clean one-decimal value`);
    // On the grid: the stored value is the storage form of its own displayed °F.
    assert.strictEqual(out, quantizeSetpointC(out), `${out}°C is off the °F grid`);
  }
});

test('a range whose bounds are whole °F keeps both endpoints reachable', () => {
  // 60°F is 15.5555…°C but is *stored* as 15.5 — 0.056°C below the bound. Judging
  // containment on the stored value alone would reject the range's own endpoint and
  // hand back 61°F, silently shaving a degree off the slider. A degree also belongs
  // to the range when its exact conversion does.
  const min = fToC(60); // 15.5555…
  const max = fToC(80); // 26.6666…
  assert.strictEqual(quantizeSetpointInRange(fToC(55), min, max), 15.5);
  assert.strictEqual(displayedF(quantizeSetpointInRange(fToC(55), min, max)), 60);
  assert.strictEqual(quantizeSetpointInRange(fToC(85), min, max), 26.5);
  assert.strictEqual(displayedF(quantizeSetpointInRange(fToC(85), min, max)), 80);
});

test('a bound off the 0.5°C grid is not undershot', () => {
  // The difference from upstream, which widens its tolerance to 0.25°C and so lets
  // 61°F (16.11°C, stored 16.0) through a hand-declared floor of 16.2. Here neither
  // its exact nor its stored value is inside, so the first degree that fits is 62°F.
  assert.strictEqual(quantizeSetpointInRange(10, 16.2, 31), 16.5);
  assert.strictEqual(quantizeSetpointInRange(fToC(61), 16.2, 31), 16.5);
  // Mirror image at the top: 30.8 refuses 88°F (31.11 exact, 31.0 stored).
  assert.strictEqual(quantizeSetpointInRange(40, 10, 30.8), 30.5);
});

test('no bound on the 0.5°C grid is ever exceeded', () => {
  for (let halves = 20; halves <= 64; halves++) {
    const max = halves / 2;
    const out = quantizeSetpointInRange(40, 10, max);
    assert.ok(out <= max, `max ${max} was exceeded by ${out}`);
    const min = halves / 2;
    const up = quantizeSetpointInRange(0, min, 35);
    assert.ok(up >= min, `min ${min} was undershot by ${up}`);
  }
});

test('a range no whole °F belongs to falls back to the grid point inside it', () => {
  // No degree stores inside [22.3, 22.7] (72°F = 22.0, 73°F = 23.0), and none
  // converts into it either; 22.5 is on the grid and inside.
  assert.strictEqual(quantizeSetpointInRange(5, 22.3, 22.7), 22.5);
  assert.strictEqual(quantizeSetpointInRange(40, 22.3, 22.7), 22.5);
});

test('a float-dirty bound does not push the result out of range', () => {
  const max = 22.000000000000004; // a float-dirty form of the 72°F grid point
  const out = quantizeSetpointInRange(fToC(75), 10, max);
  assert.ok(out <= max + 0.05, `${out} exceeded the dirty max ${max}`);
  assert.strictEqual(out, 22, 'the bound itself is reachable despite the trailing dirt');
  const min = 21.999999999999996;
  assert.strictEqual(quantizeSetpointInRange(fToC(60), min, 31), 22, 'and from below');
});

test('sameSetpoint is true within 0.05°C', () => {
  assert.ok(sameSetpoint(22.2, 22.2));
  assert.ok(sameSetpoint(22.2, 22.24));
  assert.ok(sameSetpoint(22.2, 22.16));
  assert.ok(sameSetpoint(22.2, 22.200000000000003), 'float dirt is not a change');
});

test('sameSetpoint is false beyond 0.05°C', () => {
  assert.ok(!sameSetpoint(22.2, 22.26));
  assert.ok(!sameSetpoint(22.2, 22.3), 'one 0.1°C step apart is a real change');
  assert.ok(!sameSetpoint(22.2, 22.8), 'one °F apart is a real change');
});

test('adjacent °F setpoints are never mistaken for the same setpoint', () => {
  for (let f = 50; f < 90; f++) {
    const a = quantizeSetpointC(fToC(f));
    const b = quantizeSetpointC(fToC(f + 1));
    assert.ok(!sameSetpoint(a, b), `${f}°F and ${f + 1}°F compared equal`);
  }
});

// ---- Celsius grid --------------------------------------------------------
// For an account that reads Celsius the °F-anchored grid is pure cost. Under the
// 0.1°C grid, 22.0°C stored as 22.3 and the Home app displayed 22.5: reported live
// 2026-08-19 — "I set 22 and it goes back up to 22.5". Both paths now share the
// 0.5°C grid, but the °F path still skips the points no whole degree lands on:
// 22.5°C is 72.5°F, which it sends to 73°F and stores as 23.0. This grid makes
// asked-for, stored and displayed the same number at every point.

test('the whole 20-24 range round-trips on the Celsius grid', () => {
  for (const c of [20, 20.5, 21, 21.5, 22, 22.5, 23, 23.5, 24]) {
    assert.strictEqual(quantizeSetpointCelsius(c), c,
      `${c}°C is already on the 0.5 grid and must come back untouched`);
  }
});

test('22 is the case that motivated this; 22.5 is the one that still needs it', () => {
  // Keep both paths in the same test so the contrast cannot drift apart unnoticed.
  assert.strictEqual(quantizeSetpointCelsius(22), 22);
  assert.strictEqual(quantizeSetpointC(22), 22, 'on the 0.5°C grid the °F path agrees at 22 now');
  assert.strictEqual(quantizeSetpointCelsius(22.5), 22.5, 'the Celsius grid keeps every half degree');
  assert.strictEqual(quantizeSetpointC(22.5), 23,
    'the °F path has no degree at 22.5 and moves it — the two paths are not interchangeable');
});

test('an off-grid request snaps to the nearest half degree', () => {
  assert.strictEqual(quantizeSetpointCelsius(22.2), 22);
  assert.strictEqual(quantizeSetpointCelsius(22.3), 22.5);
  assert.strictEqual(quantizeSetpointCelsius(21.74), 21.5);
  assert.strictEqual(quantizeSetpointCelsius(21.76), 22);
});

test('the Celsius grid respects the profile range, stepping inward', () => {
  // The live profile: heat 10-31, cool 16-31.
  assert.strictEqual(quantizeSetpointInRangeCelsius(10, 10, 31), 10, 'the floor is reachable');
  assert.strictEqual(quantizeSetpointInRangeCelsius(31, 16, 31), 31, 'and the ceiling');
  assert.strictEqual(quantizeSetpointInRangeCelsius(8, 10, 31), 10, 'below the floor steps up to it');
  assert.strictEqual(quantizeSetpointInRangeCelsius(40, 16, 31), 31, 'above the ceiling steps down');
  assert.strictEqual(quantizeSetpointInRangeCelsius(15.9, 16, 31), 16,
    'a request just under the cool floor lands on it, not below');
});

// ---- threshold ranges and the user's own caps --------------------------------
//
// The adapter carries two caps the user sets in the vendor app — userMaxHeatSetPoint
// and userMinCoolSetPoint (ha_kumo_ws narrows its ranges with them). They apply by
// FIELD, never by mode: in AUTO both setpoints share the `auto` bounds, so a cap
// written into those bounds would cap the other setpoint too.

/** The GX15's real profile (indoorUnit.profile, 2026-10-03). */
const GX15 = (over: Partial<DeviceProfile> = {}): DeviceProfile => ({
  numberOfFanSpeeds: 5, hasFanSpeedAuto: true, hasModeDry: true, usesSetPointInDryMode: true,
  hasModeHeat: true, hasModeVent: true, hasVaneDir: true, hasVaneSwing: true,
  hasDefrost: true, hasStandby: true,
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  ...over,
});

test('a threshold covers its own mode widened to AUTO, as it always did', () => {
  assert.deepStrictEqual(thresholdRange(GX15(), 'spHeat'), { min: 10, max: 31 });
  assert.deepStrictEqual(thresholdRange(GX15(), 'spCool'), { min: 16, max: 31 });
});

test('the heating cap lowers spHeat\'s ceiling and leaves spCool alone', () => {
  const p = GX15({ userMaxHeatSetPoint: 22 });
  assert.deepStrictEqual(thresholdRange(p, 'spHeat'), { min: 10, max: 22 });
  assert.deepStrictEqual(thresholdRange(p, 'spCool'), { min: 16, max: 31 },
    'by field: both share the auto bounds, and only spHeat is capped');
});

test('the cooling floor raises spCool\'s floor and leaves spHeat alone', () => {
  const p = GX15({ userMinCoolSetPoint: 24 });
  assert.deepStrictEqual(thresholdRange(p, 'spCool'), { min: 24, max: 31 });
  assert.deepStrictEqual(thresholdRange(p, 'spHeat'), { min: 10, max: 31 });
});

test('a cap never inverts the range it narrows', () => {
  // The mirror clamps per MODE, so a cap valid against the merged range can still
  // fall outside one mode's: a ceiling of 12 against AUTO's floor of 16.
  assert.deepStrictEqual(
    capRange({ min: 16, max: 31 }, 'spHeat', GX15({ userMaxHeatSetPoint: 12 })), { min: 16, max: 16 });
  assert.deepStrictEqual(
    capRange({ min: 16, max: 31 }, 'spCool', GX15({ userMinCoolSetPoint: 35 })), { min: 31, max: 31 });
});
