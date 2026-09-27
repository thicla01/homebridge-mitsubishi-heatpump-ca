/**
 * Fahrenheit-anchored setpoint quantization.
 *
 * HomeKit is Celsius-native: the Home app converts to °F only for display, and a
 * controller writing "72°F" sends whatever Celsius float its own conversion produced.
 * The units accept 0.1°C granularity (live-verified — the cloud stored a 23.3
 * setpoint exactly, never snapping to 23.5), so every whole °F has a 0.1°C
 * representation that displays back as that same whole °F. This module snaps to it.
 *
 * Why this is not handled by HAP props. Upstream set `minStep: 0.1` on the setpoint
 * characteristics believing that would make °F round-trip. It does not:
 * hap-nodejs applies minStep only on the OUTBOUND path (`validateUserInput`); the
 * inbound controller-write path (`validateClientSuppliedValue`) hands the float
 * through verbatim. The minStep grid also introduces IEEE-754 dirt of its own,
 * because it is anchored at `minValue` — with minValue 10 and minStep 0.1 a 72°F
 * write lands on `10 + 122 * 0.1 = 22.200000000000003`, which then leaks into
 * commands, logs and mirror signatures.
 *
 * Rounding also used to live in the LAN transport only (`round1` in local-api.ts) and
 * never on the cloud path, so the same HomeKit tap stored a different value depending
 * on which transport won. Quantizing here — above both transports — makes the write
 * deterministic regardless of which one carries it.
 */

/** Half of the 0.1°C device resolution: the widest gap that is still "the same setpoint". */
const SETPOINT_TOLERANCE_C = 0.05;

/** Guard for arithmetic on range bounds that may themselves carry float dirt. */
const EPS = 1e-9;

export function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

export function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/**
 * The 0.1°C value a whole °F degree is stored as.
 *
 * CEILING, not rounding — this is the whole point of the module, and it is driven
 * by a measured fact about the vendor app rather than by taste.
 *
 * The Mitsubishi Comfort app TRUNCATES when it renders Celsius as Fahrenheit; the
 * Home app rounds. Confirmed live 2026-07-27: the Family Room held spCool
 * 22.200001°C, which is 71.96°F, and the Home app showed 72 while the Comfort app
 * showed 71 at the same moment. That one-degree split is the entire C/F complaint.
 *
 * Rounding to 0.1 lands up to 0.09°F BELOW the target degree (72°F → 22.2 →
 * 71.96°F), which a rounding renderer shows correctly and a truncating one shows
 * one degree low. Taking the ceiling instead lands 0 to 0.18°F ABOVE it (72°F →
 * 22.3 → 72.14°F), which is correct under BOTH: truncation floors 72.14 to 72,
 * and rounding is nowhere near the 0.5 needed to reach 73.
 *
 * Cost of the choice: at most 0.0999°C (0.18°F) warmer than the exact conversion,
 * and a stored value that differs by 0.1°C from what a round-to-0.1 writer would
 * have produced for the same degree. Both are far below anything perceptible, and
 * both apps then agree on the number.
 */
function storedC(f: number): number {
  const exact = fToC(f);
  // EPS absorbs float dirt so an exactly-representable degree (68°F = 20°C) is not
  // pushed up a whole step by a 19.999999999 intermediate.
  const ceiled = Math.ceil(exact * 10 - EPS) / 10;
  return Math.round(ceiled * 10) / 10; // clean one-decimal float, never 22.30000000000000004
}

/**
 * Snap a Celsius setpoint to the Celsius the units store for the nearest whole
 * Fahrenheit degree, at the 0.1°C resolution they accept.
 *
 * The result always displays back as the whole °F it came from, in a renderer that
 * rounds AND in one that truncates — see storedC for why that matters here.
 */
export function quantizeSetpointC(c: number): number {
  return storedC(Math.round(cToF(c)));
}

/**
 * Clamp to [min,max] AFTER quantizing, staying on the °F grid.
 *
 * A plain `Math.min/Math.max` clamp would hand back the raw bound, which is usually
 * not a whole °F (the real device range 10–31°C is 50–87.8°F) and would reintroduce
 * the half-degree display drift this module exists to remove. Instead, when the
 * quantized value falls outside the range we step along the °F grid toward the
 * interior — ceil at the bottom, floor at the top — and take the first whole °F that
 * lies inside. Note the consequence at a non-whole-°F bound: a request for 88°F
 * against a 31°C max lands on 87°F (30.6°C), not on 31°C/87.8°F, because 87.8 is not
 * a °F the display can show without drift.
 *
 * "Inside" is judged to within half the 0.1°C device resolution, not exactly. A bound
 * that is itself a whole °F — 80°F is 26.6666…°C — is stored as 26.7, which an exact
 * test would read as 0.033°C out of range and reject, making the range's own endpoint
 * unreachable. The allowance cannot loosen a bound that already sits on the 0.1°C grid
 * (every real device profile bound does): both bound and candidate are then multiples
 * of 0.1, so an out-of-range candidate misses by a full 0.1, well past the tolerance.
 */
export function quantizeSetpointInRange(c: number, min: number, max: number): number {
  const lo = min - SETPOINT_TOLERANCE_C;
  const hi = max + SETPOINT_TOLERANCE_C;

  const quantized = quantizeSetpointC(c);
  if (quantized >= lo && quantized <= hi) {
    return quantized;
  }

  const step = quantized < min ? 1 : -1;
  let f = Math.round(cToF(quantized));
  // Bounded: the widest plausible range is ~50°F, and the walk bails the moment it
  // steps past the far edge. The isFinite clause makes a NaN input terminate at once.
  for (let i = 0; i < 128 && Number.isFinite(f); i++) {
    f += step;
    const candidate = storedC(f);
    if (candidate >= lo && candidate <= hi) {
      return candidate;
    }
    if (step === 1 ? candidate > hi : candidate < lo) {
      break;
    }
  }

  // No whole °F fits inside the range (it is narrower than 1°F, or degenerate).
  // Fall back to the range edge itself, on the 0.1°C grid, rounded inward so the
  // result cannot land outside the range.
  return step === 1
    ? Math.ceil(min * 10 - EPS) / 10
    : Math.floor(max * 10 + EPS) / 10;
}

/**
 * True if two Celsius setpoints are the same to within half a 0.1°C step.
 *
 * Used to decide whether a write is a real change. Values that came out of
 * quantizeSetpointC are at least 0.5°C apart when they differ (1°F ≈ 0.556°C), so the
 * exact-0.05 boundary is unreachable in practice — do not rely on which side it
 * falls, floats put |22.25 - 22.2| at 0.05000000000000071.
 */
export function sameSetpoint(a: number, b: number): boolean {
  return Math.abs(a - b) < SETPOINT_TOLERANCE_C;
}

/** The Celsius grid the Home app renders setpoints on. */
const CELSIUS_DISPLAY_STEP = 0.5;

/**
 * Snap to the 0.5°C grid the Home app displays Celsius setpoints on.
 *
 * The °F-anchored ceiling above exists to make one whole Fahrenheit degree survive
 * two renderers that disagree. For an account reading Celsius that trade is pure
 * cost: 22.0°C is 71.6°F, whose nearest degree stores as 22.3, and the Home app's
 * 0.5 grid then shows 22.5 — the setpoint the user just asked for, half a degree
 * higher. Observed live 2026-08-19; 22 is the only point in 20–24 where it shows,
 * because 71.6°F sits almost exactly between two Fahrenheit degrees.
 *
 * Snapping to 0.5 instead makes what is stored, what is displayed and what was
 * asked for the same number. The cost is symmetric and one the °F path already
 * pays: a value up to 0.25°C from the request, and a stored setpoint that renders
 * to a whole °F only by chance — which does not matter to someone reading Celsius.
 */
export function quantizeSetpointCelsius(c: number): number {
  return Math.round(c / CELSIUS_DISPLAY_STEP) * CELSIUS_DISPLAY_STEP;
}

/**
 * Clamp to [min,max] after snapping to the 0.5°C grid, stepping inward so the
 * result stays on the grid rather than landing on a raw bound. Mirrors
 * quantizeSetpointInRange, whose reasoning about the tolerance applies here too:
 * a real profile bound (16, 31, 10) is already a multiple of 0.5.
 */
export function quantizeSetpointInRangeCelsius(c: number, min: number, max: number): number {
  const lo = min - SETPOINT_TOLERANCE_C;
  const hi = max + SETPOINT_TOLERANCE_C;

  const quantized = quantizeSetpointCelsius(c);
  if (quantized >= lo && quantized <= hi) {
    return quantized;
  }
  // One step inward is always enough: the grid is uniform, so the nearest grid point
  // inside the range is adjacent to the one that fell out.
  const stepped = quantized < min
    ? Math.ceil(min / CELSIUS_DISPLAY_STEP - EPS) * CELSIUS_DISPLAY_STEP
    : Math.floor(max / CELSIUS_DISPLAY_STEP + EPS) * CELSIUS_DISPLAY_STEP;
  return Math.round(stepped * 10) / 10;
}

// ---- The AUTO deadband ------------------------------------------------------

/**
 * The narrowest AUTO band the vendor app lets anyone set, in °C. Measured, not
 * assumed: on 2026-09-27 the kumo cloud app refused to hold `spHeat` and `spCool`
 * closer than 1.5 °C, on a Celsius account.
 *
 * The unit itself enforces nothing — a 0.5° band sent over the LAN was accepted and
 * held — so without this, HomeKit (scenes, Shortcuts, other controllers) could put
 * the unit in a state the vendor never allows, including an INVERTED band with
 * heating above cooling. See docs/protocol.md.
 *
 * What the vendor app does on a Fahrenheit account is not known. Rounding the
 * pushed edge outward (below) keeps the Celsius distance at or above 1.5 on either
 * grid, which on the whole-°F grid means at least 3 °F.
 */
export const MIN_AUTO_BAND_C = 1.5;

/**
 * The grid point at or beyond `c` in `direction`, on the grid the reader sees:
 * 0.5 °C for a Celsius account, the stored value of a whole °F otherwise.
 *
 * Outward, not nearest, and that is the point. The pushed edge has to land at least
 * MIN_AUTO_BAND_C from the edge that moved, and nearest can land it short — though
 * not from a value this plugin quantized: an on-grid °F edge plus 1.5 always rounds
 * up to three whole degrees on (checked across the whole range). The short landing
 * comes from an edge set somewhere else, off this grid: heating at 22.0, set in the
 * vendor app on a Celsius account or at the IR remote, read by a Fahrenheit
 * accessory. 22.0 + 1.5 = 23.5 is 74.3 °F; nearest stores 74 °F as 23.4, a 1.4°
 * band. Outward takes 75 °F, 23.9.
 */
export function quantizeOutward(c: number, direction: 1 | -1, celsius: boolean): number {
  if (celsius) {
    const steps = direction === 1
      ? Math.ceil(c / CELSIUS_DISPLAY_STEP - EPS)
      : Math.floor(c / CELSIUS_DISPLAY_STEP + EPS);
    return Math.round(steps * CELSIUS_DISPLAY_STEP * 10) / 10;
  }
  // storedC ceils each degree onto the 0.1 °C grid, so a degree's stored value can
  // sit just past its exact conversion. Start one degree back and walk outward to
  // the first stored value on the far side of `c`. A whole °F is 0.56 °C, so this
  // ends within three steps; the bound only guards a NaN.
  let f = direction === 1 ? Math.floor(cToF(c)) - 1 : Math.ceil(cToF(c)) + 1;
  for (let i = 0; i < 8 && Number.isFinite(f); i++, f += direction) {
    const candidate = storedC(f);
    if (direction === 1
      ? candidate >= c - SETPOINT_TOLERANCE_C
      : candidate <= c + SETPOINT_TOLERANCE_C) {
      return candidate;
    }
  }
  return storedC(f);
}

export interface AutoBand {
  spHeat: number;
  spCool: number;
}

export interface SetpointRange {
  min: number;
  max: number;
}

/**
 * Keep an AUTO band at least MIN_AUTO_BAND_C wide after an edge moved — the way the
 * vendor app does it, which is by pushing the edge that did NOT move, and only ever
 * away. Measured on the app: raising heating from 22 to 22.5 against cooling at 23.5
 * pushed cooling to 24; lowering cooling into the band pushed heating down; and
 * widening the band again never pulled the pushed edge back. A band that is already
 * wide enough comes back untouched, which is what makes the push one-way.
 *
 * `moved` is the edge that changed. 'both' is a case the vendor app cannot produce —
 * it edits one handle at a time — but HomeKit can: a scene or a Shortcut sets both
 * edges in one burst. There the heating edge is protected and cooling yields. That
 * tie-break is this plugin's choice, not the vendor's: heating is what a Canadian
 * winter runs on, and it matches the one direction measured above.
 *
 * At a range limit the pushed edge may have nowhere to go (heating at 30 against a
 * cooling ceiling of 31); the pushed edge then pins to its limit and the moved edge
 * gives way instead, so the band stays valid rather than the request staying exact.
 */
export function enforceAutoBand(
  band: AutoBand,
  moved: 'spHeat' | 'spCool' | 'both',
  celsius: boolean,
  heatRange: SetpointRange,
  coolRange: SetpointRange,
): AutoBand {
  if (band.spCool - band.spHeat >= MIN_AUTO_BAND_C - SETPOINT_TOLERANCE_C) {
    return band;
  }
  const fits = (v: number, r: SetpointRange) =>
    v >= r.min - SETPOINT_TOLERANCE_C && v <= r.max + SETPOINT_TOLERANCE_C;
  const pin = (v: number, r: SetpointRange) => (celsius
    ? quantizeSetpointInRangeCelsius(v, r.min, r.max)
    : quantizeSetpointInRange(v, r.min, r.max));

  if (moved === 'spCool') {
    const heat = quantizeOutward(band.spCool - MIN_AUTO_BAND_C, -1, celsius);
    if (fits(heat, heatRange)) {
      return { spHeat: heat, spCool: band.spCool };
    }
    const floor = pin(heatRange.min, heatRange);
    return { spHeat: floor, spCool: quantizeOutward(floor + MIN_AUTO_BAND_C, 1, celsius) };
  }

  const cool = quantizeOutward(band.spHeat + MIN_AUTO_BAND_C, 1, celsius);
  if (fits(cool, coolRange)) {
    return { spHeat: band.spHeat, spCool: cool };
  }
  const ceiling = pin(coolRange.max, coolRange);
  return { spHeat: quantizeOutward(ceiling - MIN_AUTO_BAND_C, -1, celsius), spCool: ceiling };
}
