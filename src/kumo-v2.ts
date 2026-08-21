import { Logger } from 'homebridge';

import type { SerialCreds } from './local-api';
import {
  CloudRegion,
  DeviceProfile,
  DeviceStatus,
  FAN_SPEEDS,
  VANE_DIRECTIONS,
  localSecretProblem,
} from './settings';

/**
 * The Kumo **v2** cloud, used as a one-shot bootstrap for LAN control.
 *
 * Why this exists at all. Two independent facts about the vendor's clouds:
 *  - Canadian accounts are not served by the v3 API this plugin otherwise speaks.
 *    `POST https://app-prod.kumocloud.com/v3/login` answers HTTP 500 for them (a
 *    non-existent account answers 403, so the 500 is specific to accounts the
 *    backend knows but does not serve). They live on `mesca-prod.kumocloud.com`,
 *    which speaks the older v2 protocol.
 *  - Since about 2026-07-31 the v3 cloud serves NOBODY the two per-device secrets
 *    the LAN adapter authenticates with — the `password` vanished from
 *    `adapter_update` and `cryptoSerial` from `GET /devices/{serial}/status`
 *    (pykumo issue #78). Home Assistant's `mitsubishi_comfort` integration solved
 *    that in v0.5.2 by falling back to the AMERICAN v2 endpoint,
 *    `https://geo-c.kumocloud.com/login`.
 *
 * So one v2 sign-in answers both problems, and it answers more than the secrets:
 * the reply carries the unit inventory (serial, room label, MAC, port, sometimes
 * the LAN address) and each unit's REAL capability profile, which is what lets the
 * plugin stop asking the user to hand-declare capabilities and setpoint bounds.
 *
 * Scope, deliberately narrow — v2 is a BOOTSTRAP, not a status source:
 *  - exactly one POST, at startup (and on the bounded retry schedule);
 *  - nothing is written back, to the cloud or to config.json;
 *  - there is no socket, no streaming and no MQTT anywhere in the v2 tree, so
 *    status must keep coming from the LAN poller. Do not grow this into a
 *    per-unit status fallback the way cloud streaming is for `localControl`.
 *
 * LOGGING RULE, non-negotiable: never pass a v2 object (or any part of one) to a
 * log call, not even at debug level. The reply carries each unit's local
 * `password` and `cryptoSerial` in clear text, a session token, and — in the parts
 * this module refuses to read — the account holder's name, phone, email and every
 * site's postal address. The Homebridge logger `util.inspect`s extra arguments, so
 * the rule is "never hand it an object", not "never stringify it". Log derived
 * facts only: counts, serials, room labels, LAN addresses. `V2Device` below is the
 * type-level half of that rule: it structurally cannot hold a secret, so a
 * `log.debug('...', device)` stays safe and a leak becomes a compile error.
 *
 * Response shape (mapped live against a Canadian account, 2026-08-18). The root is
 * an ARRAY. Only `root[2]` is read here: it is the site tree, and each node may
 * carry a `zoneTable` keyed by device serial plus a `children` array of sub-sites.
 * `root[0]` (session token), `root[1]` (display preferences) and `root[4]`
 * (userDetails + siteDetails: name, phone, email, postal addresses) are
 * deliberately never touched — data that is never read cannot leak. The shape is
 * irregular between hosts (5 elements on mesca, 4 on geo-c, `root[3]` absent or a
 * bare string), so nothing is indexed without a guard.
 */

/** The version string the v2 login expects in its body. There is no X-App-Version header. */
export const V2_APP_VERSION = '2.2.0';

/**
 * Host AND path per region — they differ, which is why this is not a bare hostname
 * option. mesca answers `/login/v2`; geo-c answers `/login` (the path
 * mitsubishi-comfort 0.5.2 uses). Same body either way.
 */
export const V2_ENDPOINTS: Record<CloudRegion, { host: string; path: string }> = {
  us: { host: 'geo-c.kumocloud.com', path: '/login' },
  ca: { host: 'mesca-prod.kumocloud.com', path: '/login/v2' },
};

export function v2Endpoint(region: CloudRegion): { host: string; path: string; url: string } {
  const { host, path } = V2_ENDPOINTS[region] ?? V2_ENDPOINTS.us;
  return { host, path, url: `https://${host}${path}` };
}

/**
 * One unit as the v2 tree describes it, with every secret removed.
 *
 * This type is a boundary, not a convenience: the secrets travel separately in a
 * `Map<serial, SerialCreds>` that goes straight to the local transport, so nothing
 * that could be logged, cached in `accessory.context` or stored on the platform
 * carries a password or a cryptoSerial.
 */
export interface V2Device {
  deviceSerial: string;
  /** Room name the user gave the zone. Becomes the HomeKit display name. */
  label?: string;
  /** ductless / mvz / sez / pead = indoor unit; `headless` is a Kumo Station and is dropped. */
  unitType?: string;
  /** Present in the payload; kept for logs and future serial->IP caching. Never a match proof. */
  mac?: string;
  /** Always 80 in every capture. The local transport hard-codes port 80. */
  port?: number;
  /** The unit's LAN address, when the account's tree carries one (`address`). Often absent. */
  ip?: string;
  /** The unit's REAL capability profile, mapped from `reportedProfile`. */
  profile?: DeviceProfile;
  /** A cloud-lagged state snapshot, usable as a startup seed only. Null when unusable. */
  condition?: Partial<DeviceStatus> | null;
}

export interface V2Inventory {
  devices: V2Device[];
  /** Only for units whose secrets are present AND well-formed. */
  creds: Map<string, SerialCreds>;
  /** Log-ready notes (serials and reasons — never values). */
  problems: string[];
  /** How many nodes of the site tree carried at least one unit. For the startup line. */
  siteCount: number;
  /**
   * The account's temperature-unit preference, from `root[1].celsius`. Undefined
   * when the host does not send that element — the array shape differs between
   * hosts, so this is read defensively and its absence is not an error.
   *
   * It seeds HomeKit's TemperatureDisplayUnits, which otherwise defaults to
   * Fahrenheit for want of any source. Only this one boolean is taken from
   * `root[1]`; nothing else in that element is of use here.
   */
  celsius?: boolean;
}

// ---- narrow, defensive readers -------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Reduce a vendor label to a comparison key: lower-case, letters and digits only.
 *
 * The stripping is the point. `normalizeFanSpeed` in settings.ts lower-cases but
 * keeps spaces and hyphens, so a v2 label like "Super Quiet" or "Mid-Horizontal"
 * would miss its vocabulary entry. That function is on the cloud read path and is
 * left alone; this one is v2's own.
 */
function vocabKey(v: unknown): string | undefined {
  const s = asString(v);
  return s === undefined ? undefined : s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Match a vendor label against one of our vocabularies, ignoring case and separators. */
function matchVocab<T extends string>(text: unknown, list: readonly T[]): T | undefined {
  const key = vocabKey(text);
  return key === undefined ? undefined : list.find((v) => v.toLowerCase() === key);
}

// ---- reportedProfile -> DeviceProfile ------------------------------------

/**
 * The unit's real capabilities and setpoint bounds.
 *
 * The one mapping worth stating out loud is that v2 reports THREE setpoint floors
 * and the plugin has three slots for them, so they are copied one by one:
 * `minimum_heat_temp` -> heat, `minimum_cool_or_dry_temp` -> cool (v2 shares one
 * pair between cool and dry, which suits a plugin that routes the dry setpoint
 * through `spCool`), `minimum_auto_temp` -> auto. On a unit with the extended
 * temperature range these disagree — 10 / 16 / 16 in the mapped account, 9 / 15 /
 * 15 on another — and collapsing them onto one number is exactly what the
 * hand-declared `minSetPoint` has to do. That costs the whole 50-61 °F heating
 * band: `applyDeviceProfile` narrows HeatingThresholdTemperature to the profile
 * floor and hap-nodejs REJECTS a client write below `minValue` (-70410) rather
 * than clamping it, so freeze protection and vacation setback become unreachable.
 * Per-mode is not tidiness; it is the feature.
 *
 * Returns undefined when the zone carries no profile — the unit may simply not
 * have reported yet (`success: 0`, `firmwareVersion: "00.00.00"`) — so the caller
 * can fall back per unit rather than as one global decision.
 */
export function mapV2Profile(zone: Record<string, unknown>): DeviceProfile | undefined {
  const p = asRecord(zone.reportedProfile);
  if (!p) {
    return undefined;
  }
  // `overrideSettings` is the cloud's likely counterpart of the local
  // `userHasModeHeat`/`userHasModeDry`, which pykumo ANDs into the capability
  // (py_kumo.py). Inferred from the names, not proven — so only an EXPLICIT false
  // takes a mode away. In the pykumo sample accounts this object is `{}`, and
  // treating a missing key as false would strip dry and heat (and with heat, AUTO)
  // from every unit in them.
  const override = asRecord(zone.overrideSettings) ?? {};
  return {
    numberOfFanSpeeds: asNumber(p.fan_speed_stages) ?? 4,
    hasFanSpeedAuto: p.has_auto_fan_speed !== false,
    // A mode tile is only added on an explicit true: an absent flag must not
    // conjure a Dry or Fan switch nobody asked for.
    hasModeDry: p.has_dry_function === true && override.dryMode !== false,
    // v2's `display_setting_temp_of_dry` is the only candidate in the tree for
    // "dry shows a target temperature", and it is what `usesSetPointInDryMode`
    // gates (dry writes go to spCool). Inferred from the name; default true, which
    // is also what dryUsesSetpoint() assumes for an unknown profile, so a wrong
    // true only reproduces today's behaviour while a wrong false would remove a
    // setpoint that works. `autoDryModeCapable` is a different field.
    usesSetPointInDryMode: p.display_setting_temp_of_dry !== false,
    hasModeHeat: p.has_heat_function !== false && override.heatMode !== false,
    hasModeVent: p.has_ventilation_function === true,
    hasVaneDir: p.has_air_direction !== false,
    hasVaneSwing: p.has_swing_direction !== false,
    // Neither flag is read anywhere in the plugin; v2 has no equivalent field and
    // the value is immaterial (the local status reports both events directly).
    hasDefrost: true,
    hasStandby: true,
    minimumSetPoints: {
      cool: asNumber(p.minimum_cool_or_dry_temp) ?? 16,
      heat: asNumber(p.minimum_heat_temp) ?? 16,
      auto: asNumber(p.minimum_auto_temp) ?? 16,
    },
    maximumSetPoints: {
      cool: asNumber(p.maximum_cool_or_dry_temp) ?? 31,
      heat: asNumber(p.maximum_heat_temp) ?? 31,
      auto: asNumber(p.maximum_auto_temp) ?? 31,
    },
  };
}

// ---- reportedCondition -> DeviceStatus -----------------------------------

/**
 * Operation modes by their v2 label, normalized through `vocabKey`.
 *
 * The TEXT is the authority here, and the numeric code only a fallback, because
 * the text is the payload's one self-describing field: `operation_mode: 2` came
 * with `more.operation_mode_text: "Dehumidify"`, which is the only member of the
 * numeric table that is actually proven.
 */
const V2_MODE_BY_TEXT: Record<string, string> = {
  off: 'off',
  heat: 'heat',
  heating: 'heat',
  cool: 'cool',
  cooling: 'cool',
  dry: 'dry',
  dehumidify: 'dry',
  dehumidifying: 'dry',
  fan: 'vent',
  fanonly: 'vent',
  vent: 'vent',
  ventilation: 'vent',
  auto: 'auto',
  autoheat: 'autoHeat',
  autocool: 'autoCool',
};

/**
 * Numeric fallback. `2` is proven ("Dehumidify"); `8` came from the live mapping
 * session; `1`/`3`/`7` are corroborated by the Mitsubishi CN105 mode byte that 2
 * and 8 fit, but were not observed. Nothing else is guessed: `16` (off) and
 * `33`/`35` (autoHeat/autoCool) are unknown, and off is covered by `power: 0`
 * anyway. An unrecognized code yields no status at all rather than a wrong one —
 * `mapToCurrentHeaterCoolerState` renders an unknown mode as INACTIVE, i.e. a
 * running unit displayed as off, and `mapToTargetHeaterCoolerState` collapses it
 * to COOL.
 */
const V2_MODE_BY_CODE: Record<number, string> = {
  1: 'heat',
  2: 'dry',
  3: 'cool',
  7: 'vent',
  8: 'auto',
};

/** The mode a v2 condition describes, or undefined if it cannot be known. */
export function v2Mode(code: unknown, text: unknown): string | undefined {
  const byText = V2_MODE_BY_TEXT[vocabKey(text) ?? ''];
  if (byText) {
    return byText;
  }
  const n = asNumber(code);
  return n === undefined ? undefined : V2_MODE_BY_CODE[n];
}

/**
 * A cloud-lagged snapshot of the unit's state, or null when it cannot be trusted.
 *
 * Null, not a default-filled object, and that is the whole design of this
 * function: in both pykumo sample accounts EVERY unit's `reportedCondition` is
 * `{"_created": ..., "more": {}}` — no room_temp, no power, no mode. A mapper that
 * filled in zeros would show every unit off and push a NaN at CurrentTemperature.
 * The credentials and the profile stay usable when the condition is empty, which
 * is why they are not coupled to it.
 *
 * `fanSpeed` and `airDirection` are set only when the label matches a vocabulary
 * entry, or the code is the one value proven (`0` = Auto for both). A misguessed
 * index would be SILENTLY wrong — 'quiet' where the unit is on 'low' is a
 * perfectly valid string that every guard accepts — so an unknown value is left
 * unset and the LAN poll fills it in seconds later.
 */
export function mapV2Condition(zone: Record<string, unknown>): Partial<DeviceStatus> | null {
  const rc = asRecord(zone.reportedCondition);
  if (!rc) {
    return null;
  }
  const more = asRecord(rc.more) ?? {};
  const roomTemp = asNumber(rc.room_temp);
  if (roomTemp === undefined) {
    return null;
  }
  const power = asNumber(rc.power)
    ?? (more.power_on === true ? 1 : more.power_on === false ? 0 : undefined);
  if (power === undefined) {
    return null;
  }
  // power carries on/off unambiguously, so an off unit needs no mode decoding.
  const mode = power === 0 ? 'off' : v2Mode(rc.operation_mode, more.operation_mode_text);
  if (mode === undefined) {
    return null;
  }

  const display = asRecord(rc.status_display) ?? {};
  const status: Partial<DeviceStatus> = {
    id: asString(rc.id) ?? '',
    deviceSerial: asString(rc.device_serial) ?? asString(zone.serial) ?? '',
    power,
    operationMode: mode,
    roomTemp,
    spHeat: asNumber(rc.sp_heat),
    spCool: asNumber(rc.sp_cool),
    spAuto: asNumber(rc.sp_auto) ?? null,
    // NOT zone.rssi, which is `{}` in the capture.
    rssi: asNumber(rc.rssi),
    filterDirty: display.filter === true,
    defrost: display.defrost === true,
    standby: display.standby === true,
  };

  const fan = matchVocab(more.fan_speed_text, FAN_SPEEDS)
    ?? (asNumber(rc.fan_speed) === 0 ? 'auto' : undefined);
  if (fan !== undefined) {
    status.fanSpeed = fan;
  }
  const vane = matchVocab(more.air_direction_text, VANE_DIRECTIONS)
    ?? (asNumber(rc.air_direction) === 0 ? 'auto' : undefined);
  if (vane !== undefined) {
    status.airDirection = vane;
  }

  // Humidity is not in reportedCondition at all. The only v2 leaf for it is the
  // MHK2 block — the same source the LAN path reads — and it is null on a unit
  // with no wall thermostat, so it is set only when it is a real number.
  const mhk2 = asRecord(asRecord(zone.mhk2Settings)?.status);
  const indoorHumid = asNumber(mhk2?.indoorHumid);
  if (indoorHumid !== undefined) {
    status.humidity = indoorHumid;
  }

  // v2 has no `connected` boolean and no device_status_v2 event. The adapter's
  // last contact is the only signal, and `_isRespondingLocally` is null in the
  // capture. A seed only — under LAN control the successful local read is truth.
  const since = asNumber(rc.seconds_since_contact);
  if (since !== undefined) {
    status.connected = since < 300;
  }

  return status;
}

// ---- the site tree -------------------------------------------------------

/**
 * How deep the `children` recursion may go. The tree is two levels in every
 * capture (account -> site -> units); the cap exists so a malformed or cyclic
 * reply cannot spin.
 */
const MAX_TREE_DEPTH = 8;

/**
 * Walk `root[2]` and collect every unit, its secrets, and its profile.
 *
 * Fully recursive on `children` and reading `zoneTable` at EVERY level, which is
 * mitsubishi-comfort 0.5.2's shape rather than pykumo's fixed two levels. The
 * mapped Canadian tree needs it: `root[2].zoneTable` is `{}` and the units live in
 * `root[2].children[0].zoneTable`, and an account with more than one site (the
 * capture lists 17 site addresses) nests differently again.
 *
 * Never throws. A missing `root[2]`, an absent or empty `zoneTable`, a node with
 * no `serial`, and a unit with no `password` all yield "fewer units", never an
 * exception: this runs inside discovery, and a parse error would take the whole
 * platform into its retry loop over a reply that will not change.
 */
export function parseV2Login(raw: unknown): V2Inventory {
  const devices: V2Device[] = [];
  const creds = new Map<string, SerialCreds>();
  const problems: string[] = [];
  let siteCount = 0;

  // Only root[2]. See the module header for what the other elements hold and why
  // they are not read: unread personal data cannot leak.
  const tree = Array.isArray(raw) && raw.length >= 3 ? asRecord(raw[2]) : undefined;
  // root[1] is the account's display preferences. One boolean is taken from it and
  // nothing is retained: a host that omits the element simply leaves this undefined.
  const prefs = Array.isArray(raw) && raw.length >= 2 ? asRecord(raw[1]) : undefined;
  const celsius = typeof prefs?.celsius === 'boolean' ? prefs.celsius : undefined;
  if (!tree) {
    return { devices, creds, problems, siteCount, celsius };
  }

  const seen = new Set<string>();
  const harvest = (node: Record<string, unknown>, depth: number): void => {
    const zoneTable = asRecord(node.zoneTable);
    if (zoneTable && Object.keys(zoneTable).length > 0) {
      siteCount++;
      for (const [key, value] of Object.entries(zoneTable)) {
        const zone = asRecord(value);
        if (!zone) {
          continue;
        }
        // The entry's own `serial` first, the table key second: both agree in the
        // capture, and both reference implementations key on the field.
        const serial = asString(zone.serial) ?? asString(key);
        if (!serial || seen.has(serial)) {
          continue;
        }
        seen.add(serial);

        const unitType = asString(zone.unitType);
        if (unitType === 'headless') {
          // A Kumo Station, not an indoor unit. As a HeaterCooler it would accept
          // every command and honour none. Everything else is treated as an indoor
          // unit, which is pykumo's permissive default.
          problems.push(`${serial}: a Kumo Station (unitType headless), not a thermostat — skipped`);
          continue;
        }

        const device: V2Device = {
          deviceSerial: serial,
          label: asString(zone.label),
          unitType,
          mac: asString(zone.mac),
          port: asNumber(zone.port),
          // pykumo reads this and documents it as sometimes absent. When present it
          // is worth 5-30s and 253 requests per unit of LAN sweep.
          ip: asString(zone.address),
          profile: mapV2Profile(zone),
          condition: mapV2Condition(zone),
        };
        devices.push(device);

        const problem = localSecretProblem(zone.password, zone.cryptoSerial);
        if (problem === null) {
          creds.set(serial, {
            password: zone.password as string,
            cryptoSerial: zone.cryptoSerial as string,
          });
        } else {
          // Named, never quoted: mitsubishi-comfort normalizes a missing field to an
          // empty string, and computeLocalToken THROWS on a cryptoSerial under 9
          // bytes — outside the local client's try — so admitting a half-credentialed
          // unit would reject every poll and every command.
          problems.push(`${serial}: unusable local ${problem} in the v2 reply — cannot control it locally`);
        }
        if (device.profile === undefined) {
          problems.push(`${serial}: no capability profile reported yet — using defaults`);
        }
        if (device.port !== undefined && device.port !== 80) {
          problems.push(`${serial}: reports port ${device.port}, but local control always uses port 80`);
        }
      }
    }

    if (depth >= MAX_TREE_DEPTH) {
      return;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      const record = asRecord(child);
      if (record) {
        harvest(record, depth + 1);
      }
    }
  };

  harvest(tree, 0);
  return { devices, creds, problems, siteCount, celsius };
}

// ---- the client ----------------------------------------------------------

export interface V2LoginOutcome {
  /** Present only on success. */
  inventory?: V2Inventory;
  /**
   * True when retrying cannot help: the host rejected the credentials (401/403).
   * Retrying an authentication failure on a loop risks locking the account.
   */
  fatal: boolean;
  /** Safe to log: a status code and a host, never a body, a secret or an email. */
  reason?: string;
}

/**
 * A single-purpose v2 client: one POST, one parse, no state.
 *
 * Deliberately NOT a method on KumoAPI and holding no reference to it. That class
 * carries a transport-level kill switch (`cloudDisabled`) whose value is that
 * "the v3 API is forbidden" holds structurally rather than depending on call sites
 * remembering the mode; the first in-class exemption would destroy that property.
 * It also has debug log lines that print request bodies and error bodies verbatim
 * (`makeAuthenticatedRequest`), which a v2 login must never touch — the body is
 * the account's username and password.
 *
 * `globalThis.fetch` is read at call time, not captured, so a test can stub it.
 */
export class KumoV2Client {
  constructor(
    private readonly log: Logger,
    private readonly region: CloudRegion,
    private readonly timeoutMs: number = 20000,
  ) {}

  get endpoint(): { host: string; path: string; url: string } {
    return v2Endpoint(this.region);
  }

  async login(username: string | undefined, password: string | undefined): Promise<V2LoginOutcome> {
    const { host, url } = this.endpoint;
    if (!username || !password) {
      // Not fatal in the "stop asking" sense — it is a config fault the user fixes
      // and restarts — but there is nothing to retry against either.
      return { fatal: true, reason: 'no username/password configured for the v2 sign-in' };
    }

    let response: Response;
    try {
      this.log.debug(`V2: POST ${url}`);
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // The header set both reference implementations send. No X-App-Version:
          // that is a v3 header, and v2 carries the version in the body instead.
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
        },
        // Credentials go in the BODY, never in the query string.
        body: JSON.stringify({ username, password, appVersion: V2_APP_VERSION }),
        signal: AbortSignal.timeout(this.timeoutMs),
        // A redirect would re-send the credentials to a host the user never named.
        redirect: 'error',
      });
    } catch (error) {
      return { fatal: false, reason: `${host} did not answer (${(error as Error).message})` };
    }

    if (!response.ok) {
      // The body is NOT read, let alone logged: a v2 error body can echo the
      // account address back. Status and host are enough to act on.
      const fatal = response.status === 401 || response.status === 403;
      return { fatal, reason: `${host} answered HTTP ${response.status}` };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { fatal: false, reason: `${host} answered 200 with a body that is not JSON` };
    }

    const inventory = parseV2Login(raw);
    if (inventory.devices.length === 0) {
      // A well-formed reply for an account with no units, or a shape this parser
      // does not recognize. Either way, not something a retry fixes quickly — but
      // not fatal either, since a site can come back.
      return { fatal: false, reason: `${host} returned no units`, inventory };
    }
    return { fatal: false, inventory };
  }
}
