// NOTE: PLATFORM_NAME is deliberately left as 'KumoV3' across the fork. It is the
// `platform` key in every existing user's config.json; changing it would orphan
// their configured platform block and re-create every accessory. The npm package
// rename does not require it (Homebridge resolves plugin renames separately).
export const PLATFORM_NAME = 'KumoV3';
export const PLUGIN_NAME = 'homebridge-mitsubishi-heatpump';
export const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
export const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
export const TOKEN_REFRESH_INTERVAL = 20 * 60 * 1000; // 20 minutes (actual token lifetime)
export const APP_VERSION = '3.2.4';

/**
 * A unit declared entirely in config, for local-only operation (`localOnly: true`).
 *
 * The two secrets are the ones the adapter's local API authenticates with. They
 * normally come from the cloud, but that is not always a viable source: since
 * 2026-07-31 the v3 cloud serves neither of them, and Canadian accounts are
 * handled by a separate backend the v3 endpoints reject. Declaring them here
 * keeps local control working without any cloud contact at all.
 */
export interface LocalDeviceConfig {
  /** The adapter's device serial (the id the cloud and the plugin key on). */
  deviceSerial: string;
  /** Name shown in HomeKit. */
  name?: string;
  /** The unit's LAN address. */
  ip: string;
  /** Local API password, base64 — as the cloud reports it. */
  password: string;
  /** Local API cryptoSerial, hex, >= 9 bytes. */
  cryptoSerial: string;
  // --- Capabilities -------------------------------------------------------
  // Without a cloud `profile_update`, capability-gated services would never
  // appear. These stand in for it; the defaults suit a typical wall-mounted
  // heat pump.
  //
  // Over-declaring a capability costs an inert control rather than an error: the
  // local adapter answers HTTP 200 to a write it does not support and silently
  // ignores it (see the `vaneDir` note further down).
  /**
   * Unit supports dry (dehumidify) mode. Default false.
   *
   * In local-only mode this declaration also ADDS the Dry switch: HeaterCooler has
   * no dehumidify state, so the switch is the only way to reach the mode, and the
   * tile is the only thing this flag gates — requiring `showDrySwitch: true` on top
   * of a hand-written per-unit declaration made the declaration inert. Setting
   * `showDrySwitch: false` explicitly still suppresses it (logged once, since dry
   * then cannot be selected at all). On the cloud path the display option is what
   * decides, because there the capability is discovered rather than declared.
   */
  hasModeDry?: boolean;
  /**
   * Unit supports vent (fan-only) mode. Default false.
   *
   * Same rule as `hasModeDry`, with `showFanOnlySwitch`. Fan SPEED while
   * heating/cooling is on the main tile and does not depend on either flag.
   */
  hasModeVent?: boolean;
  /** Unit supports heating. Default true. Gates HEAT and AUTO in the mode picker. */
  hasModeHeat?: boolean;
  /** Dry mode accepts a setpoint (held in spCool). Default true. */
  usesSetPointInDryMode?: boolean;
  /** Unit supports `auto` fan speed. Default true. Gates TargetFanState. */
  hasFanSpeedAuto?: boolean;
  /** Unit has a steerable vane. Default true. Gates the optional Slats service. */
  hasVaneDir?: boolean;
  /** Unit's vane can swing. Default true. Gates SwingMode on the main tile. */
  hasVaneSwing?: boolean;
  /**
   * Discrete fan speeds, excluding auto. Default 4.
   *
   * ADVISORY ONLY: all five named speeds are offered on every unit regardless of
   * this value (see FAN_SPEEDS), which matches live hardware — a unit reporting
   * three accepted all five.
   */
  numberOfFanSpeeds?: number;
  /**
   * Setpoint floor in °C. Default 16.
   *
   * Should match the unit's own installer limits (MHK2 Function Code 181). Unlike
   * the cloud, which answers a write outside them with a 400
   * (`invalidSpHeatRange`), the local adapter accepts an out-of-range setpoint
   * with HTTP 200 and then ignores it, so a wrong bound here fails silently.
   */
  minSetPoint?: number;
  /** Setpoint ceiling in °C. Default 31. See `minSetPoint`. */
  maxSetPoint?: number;
}

/** Which vendor backend serves the account. Not a preference: a fact about it. */
export type CloudRegion = 'us' | 'ca';

/** Where the two per-device LAN secrets come from. */
export type LocalCredentialSource = 'v3' | 'v2';

/**
 * Accept `"CA"`, `" ca "` and the like; reject anything else by returning undefined.
 *
 * Case and whitespace are forgiven because a local-control config is hand-edited
 * (the UI form cannot express `localDevices`' secrets, so users are already in the
 * JSON editor); a value that is not a region at all is NOT forgiven, because
 * silently defaulting it to `us` would send a Canadian account back to the v3
 * endpoint that answers it 500 forever. validatePlatformConfig rejects it instead.
 */
export function normalizeCloudRegion(v: unknown): CloudRegion | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const key = v.trim().toLowerCase();
  return key === 'us' || key === 'ca' ? key : undefined;
}

/** Same contract as normalizeCloudRegion, for the credential source. */
export function normalizeLocalCredentialSource(v: unknown): LocalCredentialSource | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const key = v.trim().toLowerCase();
  return key === 'v3' || key === 'v2' ? key : undefined;
}

/**
 * Which of the two LAN secrets is unusable, or null when both are fine.
 *
 * One rule, two callers: the hand-declared `localDevices` entries and the units a
 * v2 sign-in reports. They must agree, because the consequence of a bad value is
 * the same either way and it is expensive — `computeLocalToken` THROWS on a
 * cryptoSerial shorter than 9 bytes, and it is called outside the local client's
 * try/catch, so a half-credentialed unit rejects every poll and every command
 * rather than degrading.
 *
 * The cryptoSerial is checked as a hex STRING rather than by decoding it:
 * `Buffer.from(x, 'hex')` stops at the first non-hex character, so a truncated or
 * whitespace-polluted paste with 18 good characters in front of the damage decodes
 * to a passing 9 bytes and then fails every request as an opaque authentication
 * error. 18 characters is exactly the floor, with no margin — the live captures
 * report exactly 9 bytes.
 */
export function localSecretProblem(
  password: unknown,
  cryptoSerial: unknown,
): 'password' | 'cryptoSerial' | null {
  if (typeof password !== 'string' || password.trim().length === 0) {
    return 'password';
  }
  if (typeof cryptoSerial !== 'string' || !/^[0-9a-fA-F]+$/.test(cryptoSerial)
    || cryptoSerial.length % 2 !== 0 || cryptoSerial.length < 18) {
    return 'cryptoSerial';
  }
  return null;
}

/** One `localControlIps` entry in the array shape the UI form produces. */
export interface LocalIpOverride {
  deviceSerial?: string;
  ip?: string;
}

/**
 * Fold either accepted shape of `localControlIps` into the serial -> IP map the
 * code uses.
 *
 * The array shape exists because the Homebridge UI form cannot render a free-form
 * map, and an option the form cannot render is an option it DROPS: saving the
 * settings page, or reinstalling the plugin through the UI, rewrites the platform
 * block from the schema and silently takes the pin with it — observed on real
 * hardware 2026-08-21, where a reinstall removed the override and the startup LAN
 * sweep came back with no message saying why.
 *
 * Entries missing either half are skipped rather than fatal: a half-filled row is
 * what an in-progress edit in the UI looks like, and refusing to start over one
 * would be worse than ignoring it. A bad address is caught downstream by
 * `setCreds`, which names the unit and drops the override.
 */
export function normalizeLocalControlIps(
  value: Record<string, string> | LocalIpOverride[] | undefined,
): Record<string, string> {
  if (!value) {
    return {};
  }
  if (!Array.isArray(value)) {
    return value;
  }
  const out: Record<string, string> = {};
  for (const entry of value) {
    const serial = entry?.deviceSerial?.trim();
    const ip = entry?.ip?.trim();
    if (serial && ip) {
      out[serial] = ip;
    }
  }
  return out;
}

export interface KumoConfig {
  platform: string;
  name?: string;
  /**
   * Kumo Cloud email. Required EXCEPT in local-only mode (see `localOnly`), which
   * never authenticates — hence optional here and enforced by
   * validatePlatformConfig, which knows which mode is in play.
   */
  username?: string;
  /** Kumo Cloud password. Optional for the same reason as `username`. */
  password?: string;
  /**
   * Which backend serves the account. Default `us`.
   *
   * `us` is the v3 API this plugin has always spoken. `ca` selects
   * https://mesca-prod.kumocloud.com/login/v2, where Canadian accounts live — v3
   * answers them HTTP 500 — and with it the v3 API is never contacted at all: no
   * login, no streaming, no zone polling, no cloud fallback for a command. One v2
   * sign-in at startup supplies the unit list, each unit's real capability profile
   * and the two LAN secrets, and control then runs entirely over the LAN.
   *
   * Two axes, two options: this one is about the ACCOUNT's backend, while
   * `localCredentialSource` is about where the per-device secrets come from. They
   * are independent — the common case today is a US account whose v3 control works
   * fine but whose secrets v3 no longer serves (pykumo #78) — which is why one
   * region enum cannot express both.
   *
   * Rejected alternatives, so the debate is not replayed: a free-form
   * `v2Endpoint` URL (an opaque host does not imply the protocol — mesca is
   * `/login/v2`, geo-c is `/login` — and it would be a credential-exfiltration
   * footgun); `auto` detection from v3's 500 (a 500 is also a transient outage,
   * and it would post the account's credentials to a host the user never named);
   * a single four-value enum (it stacks the two axes inside value names).
   */
  cloudRegion?: CloudRegion;
  /**
   * Where the two per-device LAN secrets come from. Default `v3`, or `v2` when
   * `cloudRegion` is `ca` (v3 cannot serve those accounts at all).
   *
   * `v2` posts the account credentials once at startup to the region's v2 login
   * (US: https://geo-c.kumocloud.com/login) and reads the secrets from the reply.
   * Nothing else is read from it, nothing is written back to config.json, and
   * neither secret is ever logged — not even with `debug` on. Setting it implies
   * local control.
   */
  localCredentialSource?: LocalCredentialSource;
  pollInterval?: number;
  disablePolling?: boolean;
  debug?: boolean;
  excludeDevices?: string[];
  streamingHealthCheckInterval?: number;
  streamingStaleThreshold?: number;
  degradedPollInterval?: number;
  // Local LAN control (opt-in). When true, the plugin discovers each unit's IP on
  // the LAN and controls/reads it directly, falling back to cloud per-unit when a
  // unit is unreachable. Cloud streaming stays connected as the fallback.
  localControl?: boolean;
  /**
   * Optional manual serial -> IP overrides, skipping LAN discovery for those units.
   *
   * Two accepted shapes, and the reason both exist: the array is what the Homebridge
   * UI form writes and can render, the bare map is what earlier configs (and the JSON
   * editor) use. Read them through `normalizeLocalControlIps`, never directly — a
   * config written by the form is an array, and indexing an array by serial silently
   * finds nothing.
   */
  localControlIps?: Record<string, string> | LocalIpOverride[];
  // Seconds between local status polls (default 15).
  localPollInterval?: number;
  /**
   * Local-only mode: never contact the cloud, on any path. No login, no
   * site/zone fetch, no streaming, and no per-unit cloud fallback for a failed
   * local command. Every unit comes from `localDevices` below, and
   * `username`/`password` are not required.
   */
  localOnly?: boolean;
  /** Units to control, when `localOnly` is true. */
  localDevices?: LocalDeviceConfig[];
  // --- Display options -----------------------------------------------------
  // Fan speed and vane now live on the HeaterCooler tile itself, so the two
  // extra Switch tiles per unit are opt-in rather than automatic. They still
  // only appear on units whose profile reports the capability.
  /**
   * Add a per-unit "Dry" switch (dehumidify). Default false.
   *
   * Only consulted where the capability is DISCOVERED. In local-only mode a unit
   * that declares `hasModeDry` gets the switch without this, since the declaration
   * is already per-unit and deliberate; an explicit `false` here still wins.
   */
  showDrySwitch?: boolean;
  /** Add a per-unit "Fan" switch (fan-only, no heating/cooling). Default false. See showDrySwitch. */
  showFanOnlySwitch?: boolean;
  /**
   * Expose indoor humidity as a HumiditySensor service. Default TRUE.
   *
   * Turn this off if humidity is dominating the accessory's tile in the Apple
   * Home app. Home collapses an accessory's services into a single tile and
   * favours a sensor reading for what that tile displays, so a unit with a
   * paired humidity sensor can show humidity where you wanted temperature and
   * fan. Home's per-accessory "Show as Separate Tiles" setting is the
   * alternative that keeps both.
   */
  showHumiditySensor?: boolean;
  /**
   * Expose vane direction as a HomeKit Slats service in addition to SwingMode.
   * Default FALSE, deliberately.
   *
   * Apple Home categorises Slats as a WINDOW COVERING. On a home with real
   * blinds or shades, a vane Slats service joins their room grouping and their
   * category summary tile, so the heat pump's louvre starts appearing among the
   * blinds — and a room-level "close the blinds" control can reach it. Observed
   * 2026-07-27 on a house with Matter blinds paired directly to HomeKit.
   *
   * Swing on/off is always available on the HeaterCooler tile itself via
   * SwingMode; this option only adds the discrete tilt positions.
   */
  exposeVaneSlat?: boolean;
  /**
   * Record room temperature (and humidity when known) for the Eve app's history
   * graphs. Default TRUE.
   *
   * On by default because history is only useful if it was already being
   * collected when someone first looks: an opt-in that nobody discovers records
   * nothing. The cost is one commit every ten minutes to a small JSON file per
   * unit under the Homebridge storage path, and one extra service that the Apple
   * Home app does not render at all — only Eve (and other apps that speak the
   * Elgato history protocol) read it.
   *
   * Implemented natively (src/eve-history.ts) rather than via fakegato-history,
   * whose hard dependency `googleapis` weighs 204MB for an optional Google Drive
   * backup this plugin would never use.
   */
  eveHistory?: boolean;
  // Device mirroring (opt-in). Each pair makes `target` follow `source`: whenever
  // the source's commanded state changes (via any control path — wall thermostat,
  // Kumo app, or HomeKit), the source's full state is pushed to the target. One-way;
  // a manual change to the target persists until the next source change re-syncs it.
  mirror?: MirrorPair[];
}

/** A one-way mirror: `target` follows `source` (both device serials). */
export interface MirrorPair {
  source: string;
  target: string;
}

/**
 * The subset of a device's state the mirror copies from source to target.
 * `operationMode` is the raw status value (may be autoHeat/autoCool); `fanSpeed`
 * is the raw adapter/cloud fan-speed string (mirrored verbatim).
 */
export interface MirrorState {
  operationMode: string;
  power: number;
  spHeat: number;
  spCool: number;
  fanSpeed: string;
}

export interface LoginResponse {
  id: string;
  username: string;
  email: string;
  token: {
    access: string;
    refresh: string;
  };
  preferences?: Record<string, unknown>;
}

export interface Site {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  name: string;
  isActive: boolean;
  adapter: Adapter;
}

export interface Adapter {
  id: string;
  deviceSerial: string;
  roomTemp: number;
  spHeat: number;
  spCool: number;
  spAuto: number | null;
  humidity: number | null;
  power: number;
  operationMode: string;
  previousOperationMode: string;
  // NOT PRESENT in the `GET /sites/{siteId}/zones` payload — optional on purpose.
  // The zones adapter object carries roomTemp/setpoints/power/operationMode but
  // neither fan speed nor vane; those live in the streaming `device_update` event
  // and in `GET /devices/{serial}`. They were typed as required `string` here,
  // which is how the debug poll log ended up printing "Fan: undefined" for every
  // unit and why vane data looked unavailable from the cloud. Any read must
  // default (see accessory.ts, which does `|| 'auto'` on the streaming paths).
  fanSpeed?: string;
  airDirection?: string;
  connected: boolean;
  isSimulator: boolean;
  hasSensor: boolean;
  hasMhk2: boolean;
  scheduleOwner: string;
  scheduleHoldEndTime: number;
  rssi?: number;
}

export interface DeviceStatus {
  id: string;
  deviceSerial: string;
  rssi: number;
  power: number;
  operationMode: string;
  humidity: number | null;
  fanSpeed: string;
  airDirection: string;
  roomTemp: number;
  spCool: number;
  spHeat: number;
  spAuto: number | null;
  // Extended fields from device_update streaming
  modelNumber?: string;
  connected?: boolean;
  standby?: boolean;
  defrost?: boolean;
  filterDirty?: boolean;
  /** Wireless-sensor battery percent, when the unit has a paired sensor. */
  sensorBattery?: number | null;
}

/**
 * A reading from a unit's paired wireless sensor, via the cloud `sensor_update` event.
 *
 * This exists because the v3 cloud stopped distributing the two secrets local LAN
 * control needs: the per-device `password` vanished from the `adapter_update` payload
 * and `cryptoSerial` vanished from `GET /devices/{serial}/status` (confirmed cloud-side
 * and account-independent — pykumo issue #78, 2026-07-31, reproduced by its maintainer).
 * Local control is dead until that reverses, and with it went the `{"c":{"sensors":...}}`
 * leaf that `local-api.ts:getSensorReadings` used for the sensor's fine-grained
 * temperature, humidity and battery.
 *
 * A `sensor_update` Socket.IO event appeared in the same window carrying exactly that
 * data per device, so it is now the only source for it. It matters for more than
 * humidity: the unit quantizes `roomTemp` to 0.5°C before reporting while the sensor
 * reports ~6 decimals (22.30543 against 22.5), and three of the four units tested
 * regulate FROM the sensor (`tempSource: 'sensor0'`), so the sensor is the real
 * thermostat. The finer value also removes a display ambiguity: 22.5°C is exactly
 * 72.5°F, the one 0.5°C step where a rounding renderer shows 73 and a truncating one
 * shows 72.
 *
 * Every field but `deviceSerial` is optional and nullable: the event is coerced
 * defensively, and anything that did not arrive as a number becomes null.
 */
export interface SensorReading {
  deviceSerial: string;
  uuid?: string;
  battery?: number | null;
  rssi?: number | null;
  txPower?: number | null;
  temperature?: number | null;
  humidity?: number | null;
}

export interface DeviceProfile {
  numberOfFanSpeeds: number;
  hasFanSpeedAuto: boolean;
  hasModeDry: boolean;
  // Dry mode holds its setpoint in spCool on the Kumo v3 cloud (there is no
  // spDry field). When true, dry has a settable target; when false the unit
  // dehumidifies at a fixed setpoint and ignores writes. See accessory.ts.
  usesSetPointInDryMode: boolean;
  hasModeHeat: boolean;
  hasModeVent: boolean;
  hasVaneDir: boolean;
  hasVaneSwing: boolean;
  hasDefrost: boolean;
  hasStandby: boolean;
  minimumSetPoints: { cool: number; heat: number; auto: number };
  maximumSetPoints: { cool: number; heat: number; auto: number };
}

// ---- Vane and fan-speed vocabularies --------------------------------------
// Both lists are live-verified by write test on the author's four units
// (MLZ-KX06NL-U1 x2, MLZ-KX12NL-U1, MSZ-GX06NL-U1): every value below was
// accepted by the local adapter API.
//
// These lists are the ONLY validation layer. The adapter does not validate: a
// write of `vaneDir:"notARealVane"` returns HTTP 200 and is silently ignored, so
// a typo produces an invisible no-op rather than an error. Validate before every
// write (isVaneDirection / isFanSpeed) — never pass an unchecked string through.

/**
 * Vane (louver) positions, listed in physical order: 'horizontal' is the most
 * horizontal blade angle, 'vertical' the most downward, with the three mid steps
 * between them. 'auto' (unit decides) leads and 'swing' (continuous sweep) trails,
 * since neither is a fixed angle.
 */
export type VaneDirection =
  | 'auto'
  | 'horizontal'
  | 'midhorizontal'
  | 'midpoint'
  | 'midvertical'
  | 'vertical'
  | 'swing';

export const VANE_DIRECTIONS: readonly VaneDirection[] = [
  'auto',
  'horizontal',
  'midhorizontal',
  'midpoint',
  'midvertical',
  'vertical',
  'swing',
];

export function isVaneDirection(v: unknown): v is VaneDirection {
  return typeof v === 'string' && (VANE_DIRECTIONS as readonly string[]).includes(v);
}

/** Named fan speeds the adapter accepts. */
export type FanSpeed = 'auto' | 'superQuiet' | 'quiet' | 'low' | 'powerful' | 'superPowerful';

/**
 * Ordering decision: indices 1..5 are the airflow ladder in ASCENDING order
 * (superQuiet < quiet < low < powerful < superPowerful). 'auto' is index 0 and is
 * deliberately outside that ladder — it is not an airflow level but "let the unit
 * decide", so it has no rank relative to the others. Anything mapping a speed onto
 * a linear control (a HomeKit RotationSpeed slider, say) must treat index 0 as the
 * auto sentinel and rank only `FAN_SPEEDS.slice(1)`.
 *
 * The device profile's `numberOfFanSpeeds` is ADVISORY ONLY and must not gate this
 * list: a unit reporting 3 accepted all five named speeds (verified). pykumo agrees;
 * Home Assistant's `_FAN_SPEEDS_BY_COUNT[3] = [quiet, low, powerful]` is wrong here.
 */
export const FAN_SPEEDS: readonly FanSpeed[] = [
  'auto',
  'superQuiet',
  'quiet',
  'low',
  'powerful',
  'superPowerful',
];

export function isFanSpeed(v: unknown): v is FanSpeed {
  return typeof v === 'string' && (FAN_SPEEDS as readonly string[]).includes(v);
}

/**
 * Match a fan speed REPORTED by a unit against our vocabulary, ignoring case.
 *
 * Read path only. pykumo lists both `low` and `Low` in its vocabulary and returns
 * the capitalised form for units reporting `numberOfFanSpeeds: 4`, so an exact
 * match would miss it: the speed would fall through to index -1 and render as
 * "auto" on the tile, and the real speed could never be selected again. Writes
 * still go out in our canonical lower-case form, which is what the adapter
 * accepted on every unit tested.
 *
 * Returns undefined for a genuinely unknown speed — callers must not silently
 * treat that as 'auto', since it would misreport the unit's actual state.
 */
export function normalizeFanSpeed(v: unknown): FanSpeed | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const lower = v.toLowerCase();
  return FAN_SPEEDS.find((f) => f.toLowerCase() === lower);
}

export interface Commands {
  spHeat?: number;
  spCool?: number;
  operationMode?: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry';
  // Was the coarse `'auto'|'low'|'medium'|'high'` enum through 1.8.2, translated to
  // the adapter's vocabulary by a lossy `mapFanSpeedToLocal` in local-api.ts. That
  // enum had no producer anywhere in the plugin (every call site set `fanSpeedRaw`
  // instead, precisely because the coarse strings collided with the real ones —
  // coarse 'low' meant 'quiet'), so it is replaced by the real vocabulary and the
  // lossy mapping is gone with it. Validate with isFanSpeed before writing.
  fanSpeed?: FanSpeed;
  // A verbatim adapter/cloud fan-speed string. Retained alongside the now-typed
  // `fanSpeed` for the mirror path only: mirroring copies whatever the source unit
  // reported, which may be a value this fork has not enumerated, and that must be
  // passed through unvalidated rather than rejected. Takes precedence over
  // `fanSpeed` on the local path; folded into `fanSpeed` on the cloud path
  // (see toCloudCommands). Prefer `fanSpeed` for anything the plugin originates.
  fanSpeedRaw?: string;
  // Vane/louver position. The local field is `vaneDir`; the cloud calls the same
  // thing `airDirection` (translated in toCloudCommands).
  vaneDir?: VaneDirection;
  power?: 0 | 1;
}

/**
 * The cloud wire shape for `POST /devices/send-command`. Deliberately not `Commands`:
 * the cloud names the vane field `airDirection` and has no notion of `fanSpeedRaw`.
 * `toCloudCommands` performs the translation.
 */
export interface CloudCommands {
  spHeat?: number;
  spCool?: number;
  operationMode?: Commands['operationMode'];
  // Verbatim, not narrowed to FanSpeed: the mirror passthrough may carry a string
  // this fork has not enumerated, and the cloud accepts whatever the unit reported.
  fanSpeed?: string;
  airDirection?: VaneDirection;
  power?: 0 | 1;
}

export interface SendCommandRequest {
  deviceSerial: string;
  commands: CloudCommands;
}

export interface SendCommandResponse {
  devices: string[]; // Array of device serial numbers that received the command
}
