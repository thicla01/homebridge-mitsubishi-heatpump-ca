/**
 * Lockouts the indoor unit reports: `indoorUnit.prohibits` on the LAN adapter.
 *
 * Found by enumerating a real GX15 on 2026-10-03 (tools/kumo-probe.mjs, see
 * docs/protocol.md): three scopes — `global`, `local`, `effective` — each with
 * `{power, mode, setpoint}` booleans. All false on the unit measured.
 *
 * WHY READ IT AT ALL
 *   The adapter does not reject writes it ignores: `vaneDir: "notARealVane"` answers
 *   success and changes nothing. So while a lock is on, the plugin's "Command accepted
 *   by API" cannot be taken to mean "applied" — and a user who changes a setpoint,
 *   sees nothing happen and finds "accepted" in the log has been told something false.
 *   Reading the lock is how the log stops saying that.
 *
 * WHY WARN AND NEVER BLOCK
 *   What a real adapter does with a write to a locked control is UNMEASURED. It might
 *   ignore it, refuse it, or honour it anyway. Measuring would mean setting a lock on
 *   someone's heat pump, which this project does not do. Under that uncertainty the
 *   costs are lopsided: a needless warning costs a log line, a needless refusal costs
 *   heat. So commands are always sent, and the lock only changes what the log says.
 *
 * WHY `effective` DRIVES EVERYTHING
 *   It is the scope named for what is in force. How it combines `global` and `local`
 *   is inferred from the names, not measured, so neither is folded into it here —
 *   they are carried only so a warning can say where a lock comes from.
 */

import { Commands } from './settings';

export type LockedControl = 'power' | 'mode' | 'setpoint';

const CONTROLS: readonly LockedControl[] = ['power', 'mode', 'setpoint'];

export interface UnitProhibits {
  effective: ReadonlySet<LockedControl>;
  global: ReadonlySet<LockedControl>;
  local: ReadonlySet<LockedControl>;
}

/**
 * The controls a scope marks locked.
 *
 * A control counts as locked only when it is literally `true`. Missing, null or a
 * string is "cannot tell", which must not raise a warning: a false alarm here would
 * teach the reader to ignore the real one.
 */
function lockedIn(scope: unknown): Set<LockedControl> {
  const out = new Set<LockedControl>();
  if (!scope || typeof scope !== 'object') {
    return out;
  }
  const record = scope as Record<string, unknown>;
  for (const control of CONTROLS) {
    if (record[control] === true) {
      out.add(control);
    }
  }
  return out;
}

/**
 * Parse the `prohibits` object from an `indoorUnit` reply.
 *
 * Null when there is no `effective` scope to read: without it there is nothing to
 * act on, and inventing one from `global` and `local` would be guessing at how the
 * firmware combines them.
 */
export function parseProhibits(raw: unknown): UnitProhibits | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!record.effective || typeof record.effective !== 'object') {
    return null;
  }
  return {
    effective: lockedIn(record.effective),
    global: lockedIn(record.global),
    local: lockedIn(record.local),
  };
}

/**
 * The controls a command would exercise, for deciding whether a lock affects it.
 *
 * On the LAN, power IS the mode: local commands carry no `power` field, and "off" is
 * `operationMode: 'off'`. So an off exercises power; a mode sent to a unit that is
 * off exercises power and mode (it turns the unit on in that mode); a mode sent to a
 * unit that is on exercises mode only. When the unit's state is not known, a mode
 * exercises both — a lock this might hit is worth mentioning.
 *
 * The `power` field is ignored for the same reason: buildLocalCommandBody never puts
 * it on the wire, and this is only consulted after a LOCAL send. Counting it would
 * flag a power lock on commands that cannot touch power.
 *
 * Fan speed and vane direction are not covered by any of the three locks.
 */
export function controlsTouchedBy(commands: Commands, unitIsOn: boolean | null): LockedControl[] {
  const touched: LockedControl[] = [];
  const mode = commands.operationMode;
  if (mode === 'off') {
    touched.push('power');
  } else if (mode !== undefined) {
    if (unitIsOn !== true) {
      touched.push('power');
    }
    touched.push('mode');
  }
  if (commands.spHeat !== undefined || commands.spCool !== undefined) {
    touched.push('setpoint');
  }
  return touched;
}

/** A stable rendering of a set of locks, for change detection and for the log. */
export function describeLocks(locks: ReadonlySet<LockedControl>): string {
  const listed = CONTROLS.filter((control) => locks.has(control));
  return listed.length === 0 ? 'none' : listed.join(', ');
}
