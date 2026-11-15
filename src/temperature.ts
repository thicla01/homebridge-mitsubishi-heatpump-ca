/**
 * Fahrenheit-anchored setpoint quantization.
 *
 * HomeKit is Celsius-native: the Home app converts to °F only for display, and a
 * controller writing "72°F" sends whatever Celsius float its own conversion produced.
 * The Mitsubishi v3 cloud accepts setpoints only on a 0.5°C grid. It took 0.1°C values
 * until late October 2026; since then every other value is refused with HTTP 400
 * `invalidSpHeatIncrement` / `invalidSpCoolIncrement` — reported independently by
 * three projects, and by upstream live on 2026-11-04 (21.0 and 21.5 accepted, 21.3
 * and 22.7 refused). The LAN adapter still takes 0.1°C values, and units still hold
 * and report older ones; only cloud writes are checked. This module sits above both
 * transports, so it snaps every write to the 0.5°C point nearest a whole °F: the
 * same tap must store the same value whichever transport carries it. Ported from
 * upstream ukaratay/homebridge-mitsubishi-heatpump 8011c57.
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

import type { DeviceProfile } from './settings';

/**
 * The widest gap that is still "the same setpoint", and the slack every comparison
 * against a band or a Celsius bound gets: enough for float dirt and for a legacy
 * 0.1°C reading, nowhere near the 0.5°C that separates two grid points.
 */
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
 * The 0.5°C value a whole °F degree is stored as: the nearest one.
 *
 * Nearest keeps the stored value within 0.25°C (0.45°F) of the degree, so the Home
 * app, which rounds, always shows it back as that same degree. A whole °F never
 * converts to a .25/.75 tie, and adjacent degrees (0.556°C apart) never share a
 * grid point — though the grid has points no degree lands on (22.5 is one).
 *
 * Cost of the 0.5°C grid: the Mitsubishi Comfort app TRUNCATES when it renders
 * Celsius as Fahrenheit (confirmed live by upstream 2026-07-27: 22.200001°C, which
 * is 71.96°F, showed as 72 in Home and 71 in Comfort). About half the degrees land
 * just below their °F and show one degree low there (72°F → 22.0°C = 71.6°F). The
 * 0.1°C grid this replaces avoided that by taking the ceiling; the 0.5°C grid has
 * no point that is right in both apps for those degrees, and of the two the Home
 * app is the one kept exact.
 */
function storedC(f: number): number {
  return Math.round(fToC(f) * 2) / 2;
}

/**
 * Snap a Celsius setpoint to the 0.5°C the units store for the nearest whole
 * Fahrenheit degree.
 *
 * The result always displays back as the whole °F it came from in a renderer that
 * rounds; see storedC for the truncating one.
 */
export function quantizeSetpointC(c: number): number {
  return storedC(Math.round(cToF(c)));
}

/**
 * Whether a whole °F belongs to [min,max]: its stored value is inside, or its exact
 * conversion is.
 *
 * The second clause is what keeps a bound that is itself a whole °F reachable. 60°F
 * is 15.5555…°C and is stored as 15.5, which the first clause alone would read as
 * 0.056°C out of a range starting at 60°F, shaving a degree off the slider's end.
 * The first clause is what keeps the real device ceiling reachable: 88°F is 31.11°C,
 * outside 10–31, but it is stored as 31.0.
 *
 * Upstream gets the same two results from one widened tolerance (0.25°C, half the
 * grid). That also lets a degree through when both its exact and its stored value
 * sit outside a bound that is off the grid — a hand-declared 16.2 would admit 61°F,
 * stored as 16.0. Here such a degree is refused. The tolerance also could not simply
 * be widened: the AUTO band check and the outward rounding share it, and at 0.25
 * they would pass a 1.3°C band as the 1.5°C the vendor requires.
 */
function degreeFits(f: number, min: number, max: number): boolean {
  const stored = storedC(f);
  if (stored >= min - SETPOINT_TOLERANCE_C && stored <= max + SETPOINT_TOLERANCE_C) {
    return true;
  }
  const exact = fToC(f);
  return exact >= min - EPS && exact <= max + EPS;
}

/**
 * Clamp to [min,max] AFTER quantizing, staying on the °F grid.
 *
 * A plain `Math.min/Math.max` clamp would hand back the raw bound, which is usually
 * not a whole °F and need not sit on the 0.5°C grid the cloud accepts. Instead, when
 * the requested degree falls outside the range we step along the °F grid toward the
 * interior and take the first whole °F that belongs to it (degreeFits). The real
 * device range 10–31°C is 50–87.8°F, and 88°F stores as 31.0°C, so both ends are
 * reachable.
 */
export function quantizeSetpointInRange(c: number, min: number, max: number): number {
  let f = Math.round(cToF(c));
  if (degreeFits(f, min, max)) {
    return storedC(f);
  }

  const step = storedC(f) < min ? 1 : -1;
  // Bounded: the widest plausible range is ~50°F, and the walk bails the moment a
  // degree lies wholly past the far edge. The isFinite clause makes a NaN input
  // terminate at once.
  for (let i = 0; i < 128 && Number.isFinite(f); i++) {
    f += step;
    if (degreeFits(f, min, max)) {
      return storedC(f);
    }
    const nearest = Math.min(storedC(f), fToC(f));
    const farthest = Math.max(storedC(f), fToC(f));
    if (step === 1 ? nearest > max + SETPOINT_TOLERANCE_C : farthest < min - SETPOINT_TOLERANCE_C) {
      break;
    }
  }

  // No whole °F belongs to the range (it is narrower than 1°F, or degenerate).
  // Fall back to the 0.5°C grid point just inside the edge we came from. A range
  // that holds no grid point at all has no answer the cloud would take; none is
  // known to exist.
  return step === 1
    ? Math.ceil(min * 2 - EPS) / 2
    : Math.floor(max * 2 + EPS) / 2;
}

/**
 * True if two Celsius setpoints are the same to within 0.05°C.
 *
 * Used to decide whether a write is a real change. Values that came out of either
 * quantizer are at least 0.5°C apart when they differ, so the exact-0.05 boundary is
 * unreachable in practice — do not rely on which side it falls, floats put
 * |22.25 - 22.2| at 0.05000000000000071.
 */
export function sameSetpoint(a: number, b: number): boolean {
  return Math.abs(a - b) < SETPOINT_TOLERANCE_C;
}

/** The Celsius grid the Home app renders setpoints on. */
const CELSIUS_DISPLAY_STEP = 0.5;

/**
 * Snap to the 0.5°C grid the Home app displays Celsius setpoints on.
 *
 * The °F path above picks, for each whole Fahrenheit degree, one point of this same
 * grid — and skips the points no degree lands on. For an account reading Celsius
 * that is pure cost: 22.5°C is 72.5°F, which the °F path sends to 73°F and stores as
 * 23.0, half a degree above the setpoint the user just asked for. (Under the 0.1°C
 * grid it replaced the same thing happened at 22.0, stored as 22.3 and shown as
 * 22.5 — observed live 2026-08-19, which is why this path exists.)
 *
 * Snapping straight to 0.5 makes what is stored, what is displayed and what was
 * asked for the same number, at every point of the grid. A stored setpoint then
 * renders to a whole °F only by chance — which does not matter to someone reading
 * Celsius. So the two paths share a grid now and are still not interchangeable.
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
 * grid. On the whole-°F grid that can read as two degrees apart (72 °F and 74 °F
 * store as 22.0 and 23.5), since each degree is stored on the nearest 0.5 °C.
 */
export const MIN_AUTO_BAND_C = 1.5;

/**
 * The grid point at or beyond `c` in `direction`, on the grid the reader sees:
 * 0.5 °C for a Celsius account, the stored value of a whole °F otherwise.
 *
 * Outward, not nearest, and that is the point. The pushed edge has to land at least
 * MIN_AUTO_BAND_C from the edge that moved, and nearest can land it short. From an
 * edge on the 0.5 °C grid the target is on the grid too, but may be a point no whole
 * °F stores as: heating at 22.5, set on a Celsius account, gives 24.0 — fine — while
 * heating at 21.0 gives 22.5, which no degree lands on; outward takes 73 °F, 23.0.
 * From an edge off the grid — a legacy 20.9 a unit still holds from before the cloud
 * enforced 0.5 °C — nearest falls short outright: 20.9 + 1.5 = 22.4 is 72.3 °F, and
 * 72 °F stores as 22.0, a 1.1° band. Outward takes 73 °F, 23.0.
 */
export function quantizeOutward(c: number, direction: 1 | -1, celsius: boolean): number {
  if (celsius) {
    const steps = direction === 1
      ? Math.ceil(c / CELSIUS_DISPLAY_STEP - EPS)
      : Math.floor(c / CELSIUS_DISPLAY_STEP + EPS);
    return Math.round(steps * CELSIUS_DISPLAY_STEP * 10) / 10;
  }
  // storedC rounds each degree onto the 0.5 °C grid, so a degree's stored value can
  // sit up to 0.25 °C either side of its exact conversion. Start one degree back and
  // walk outward to the first stored value on the far side of `c`. A whole °F is
  // 0.56 °C, so this ends within three steps; the bound only guards a NaN.
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
 * Narrow a range by the user's own setpoint caps, by FIELD.
 *
 * `userMaxHeatSetPoint` lowers the ceiling of anything that sets spHeat;
 * `userMinCoolSetPoint` raises the floor of anything that sets spCool. Never by mode:
 * in AUTO both setpoints are live and share the `auto` bounds, so a cap written into
 * those bounds would cap the OTHER setpoint too — the mirror clamps both AUTO
 * setpoints against them.
 *
 * Never inverts. A cap that falls outside the range it narrows is held at that
 * range's edge, so a cap below a mode's own floor pins the ceiling at the floor rather
 * than producing a range with min above max. The platform only attaches caps that lie
 * inside the merged threshold range, so in practice this guards the per-mode ranges
 * the mirror uses, where a cap valid overall can still fall outside one mode.
 */
export function capRange(range: SetpointRange, field: 'spHeat' | 'spCool', profile: DeviceProfile): SetpointRange {
  if (field === 'spHeat' && profile.userMaxHeatSetPoint !== undefined) {
    return { min: range.min, max: Math.max(range.min, Math.min(range.max, profile.userMaxHeatSetPoint)) };
  }
  if (field === 'spCool' && profile.userMinCoolSetPoint !== undefined) {
    return { min: Math.min(range.max, Math.max(range.min, profile.userMinCoolSetPoint)), max: range.max };
  }
  return range;
}

/**
 * The range a threshold characteristic offers: its own mode's bounds widened to cover
 * AUTO (in AUTO both handles are live), then narrowed by the user's cap for that field.
 *
 * Was computed inline in two places in accessory.ts — the published HAP range and
 * the range quantization and the AUTO band clamp against. Two copies of one rule is
 * how a cap applied to one and not the other would have published a range the writer
 * then contradicted.
 */
export function thresholdRange(profile: DeviceProfile, field: 'spHeat' | 'spCool'): SetpointRange {
  const mode = field === 'spHeat' ? 'heat' : 'cool';
  return capRange({
    min: Math.min(profile.minimumSetPoints[mode], profile.minimumSetPoints.auto),
    max: Math.max(profile.maximumSetPoints[mode], profile.maximumSetPoints.auto),
  }, field, profile);
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
