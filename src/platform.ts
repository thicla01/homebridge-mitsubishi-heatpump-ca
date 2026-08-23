import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import * as os from 'os';

import {
  PLATFORM_NAME, PLUGIN_NAME, KumoConfig, LocalDeviceConfig, DeviceProfile, DeviceStatus,
  CloudRegion, LocalCredentialSource, localSecretProblem, normalizeCloudRegion,
  normalizeLocalCredentialSource,
  normalizeLocalControlIps,
} from './settings';
import { KumoAPI } from './kumo-api';
import { KumoThermostatAccessory } from './accessory';
import { LocalKumoClient, discoverDeviceIps, enumerateSubnet, SerialCreds,
  describeLocalFailure,
} from './local-api';
import { KumoV2Client, V2Inventory, v2Endpoint } from './kumo-v2';
import { MirrorController } from './mirror';

/** Stand-in siteId for units declared in config; local-only mode has no site. */
const LOCAL_ONLY_SITE_ID = 'local-only';

/** How long the initial credential gather waits before falling back to retries. */
const LOCAL_CRED_INITIAL_WAIT_MS = 25000;
/** First retry delay for devices that still owe us local credentials. */
const LOCAL_CRED_RETRY_BASE_MS = 60000;
/** Ceiling for the credential retry backoff. */
const LOCAL_CRED_RETRY_MAX_MS = 1800000; // 30 minutes
/**
 * Consecutive fruitless retry passes before we stop asking. With the doubling
 * backoff the passes land at 1, 3, 7, 15, 31 and 61 minutes after startup, so six
 * passes is roughly an hour of wall time.
 */
const LOCAL_CRED_MAX_FAILED_PASSES = 6;
/** How long each retry pass waits for a nudged device to answer. */
const LOCAL_CRED_RETRY_WAIT_MS = 10000;
/**
 * Consecutive failed local polls before one warning is logged per unit.
 *
 * Three, so a single dropped read (routine — the adapter takes about one
 * connection at a time) stays at debug while a genuinely unreachable unit is named
 * within ~45s at the default 15s interval.
 */
const LOCAL_POLL_WARN_AFTER = 3;

/**
 * Floor between two v2 sign-ins, far above the v3 login's 10s.
 *
 * A v2 login is a whole authentication, not a socket nudge, and it is a BOOTSTRAP:
 * the reply is complete, so re-asking sooner cannot produce anything new. The
 * credential-retry backoff starts here instead of at 60s when the source is v2.
 */
const V2_CRED_RETRY_BASE_MS = 900000; // 15 minutes

/**
 * One unit resolved from whichever inventory source is in play, ready to be
 * registered. `setupLocalUnits` consumes these; the two resolvers above it
 * (config declarations, or a v2 sign-in) are the only things that differ between
 * the modes, which keeps the registration loop — with its two non-obvious ordering
 * constraints — in one place.
 */
/**
 * How a set of LAN units was obtained, for the handful of log lines that must say
 * something different depending on it — chiefly the startup summary, which claims
 * "cloud never contacted" for local-only and must NOT claim it after a v2 sign-in.
 */
interface LocalUnitOrigin {
  /** What to point the user at when every unit is excluded. */
  label: string;
  /** 'declared' or 'discovered', for that same sentence. */
  adjective: string;
  /** The startup summary, with %s standing in for "ok/total". */
  summary: string;
}

interface ResolvedLocalUnit {
  deviceSerial: string;
  displayName: string;
  /** Known up front for a declared unit; resolved by the LAN sweep for a v2 one. */
  ip?: string;
  creds?: SerialCreds;
  profile: DeviceProfile;
  /** Optional startup state, so a tile is not blank until the first LAN poll. */
  seed?: Partial<DeviceStatus> | null;
  /**
   * Where the profile came from. 'config' means the capabilities were DECLARED by
   * hand, which is what makes the Dry/Fan tiles implicit in local-only mode;
   * 'v2' means they were discovered, so the tiles stay opt-in as on the cloud path.
   */
  source: 'config' | 'v2';
  /**
   * The account's temperature-unit preference, when the cloud reported one. Seeds
   * HomeKit's TemperatureDisplayUnits, which has no other source and so defaults
   * to Fahrenheit. Only ever a default: a user who flips the unit in HomeKit has
   * their choice persisted in the accessory context, and this must not undo it.
   */
  celsius?: boolean;
}

/**
 * Check the platform block. Returns the reason it is unusable, or null if it is fine.
 *
 * Separate from the constructor because of what the constructor may NOT do: throw.
 * Homebridge constructs platforms unguarded — `new constructor(...)` in `loadPlatforms()`
 * has no try/catch around it, unlike the plugin lookup either side of it — and an error
 * escaping there rejects `Server.start()`, which the CLI's handler answers by SIGTERMing
 * the process. Every other plugin in the install goes down with it, before the bridge is
 * even published, and hb-service restarts straight back into the same throw. Under a child
 * bridge it is `process.exit(1)` and a restart loop that gives up after five attempts.
 *
 * So there is no such thing as "refuse to start" for one platform here. The choice is
 * between staying idle and taking the whole install down, and a missing password is not
 * grounds for the second. Verified against homebridge 2.2.1 on 2026-08-01, including that
 * a second, unrelated platform plugin never had its constructor called.
 */
/**
 * Drop a defaulted value that contradicts an explicit one, and say so. Runs
 * BEFORE validatePlatformConfig, which then never sees the contradiction.
 *
 * The validator's rules were written on the assumption that a value present in
 * config.json is one the user chose — "only an EXPLICIT value contradicts". The
 * Homebridge UI breaks that assumption: saving the settings form materialises
 * every schema `default` into config.json, so an untouched field arrives looking
 * exactly like a deliberate choice. Merely opening the settings page of a working
 * Canadian install and pressing Save wrote `localCredentialSource: "v3"` into it
 * and the platform went idle on the next restart — observed on real hardware,
 * 2026-08-19. No amount of care in the schema fully fixes that, because the UI is
 * free to write whatever it likes; the runtime has to be able to absorb it.
 *
 * Only contradictions with ONE possible resolution are absorbed here. Under
 * `cloudRegion: "ca"` the v2 source and LAN control are not preferences, they are
 * the only things that exist — v3 answers those accounts HTTP 500 and there is no
 * other transport — so refusing to start buys no safety and costs the user their
 * heat pump. A genuinely ambiguous contradiction (localOnly with a cloud
 * credential source, a misspelled enum, missing credentials) stays fatal in the
 * validator, where failing loudly IS the safe answer.
 */
export function reconcileImpliedConfig(config: KumoConfig): string[] {
  const notes: string[] = [];
  const region = normalizeCloudRegion(config.cloudRegion);
  const source = normalizeLocalCredentialSource(config.localCredentialSource);

  if (region === 'ca' && source === 'v3') {
    delete config.localCredentialSource;
    notes.push(
      'cloudRegion "ca" cannot take its LAN secrets from the v3 cloud (it answers HTTP 500 for '
      + 'Canadian accounts), so localCredentialSource "v3" was ignored and v2 used instead. '
      + 'The Homebridge UI writes that value on its own when the settings form is saved; '
      + 'delete localCredentialSource in the config editor to silence this.',
    );
  }

  // Re-read: the delete above may have made the source implied rather than explicit.
  const effectiveSource = normalizeLocalCredentialSource(config.localCredentialSource)
    ?? (region === 'ca' ? 'v2' : 'v3');

  if (config.localControl === false && (region === 'ca' || effectiveSource === 'v2')) {
    delete config.localControl;
    notes.push(
      `${region === 'ca' ? 'cloudRegion "ca"' : 'localCredentialSource "v2"'} exists to control `
      + 'units over the LAN, so localControl "false" was ignored and LAN control left on. '
      + 'The Homebridge UI writes that value on its own when the settings form is saved; '
      + 'delete localControl in the config editor to silence this. To stop controlling these '
      + 'units, disable the plugin instead.',
    );
  }

  return notes;
}

export function validatePlatformConfig(config: KumoConfig): string | null {
  // The two new axes first, because every rule below reads them.
  //
  // The schema polices the form, but a config for this plugin's local paths is
  // routinely hand-edited, so the runtime has to police them too. And a typo here
  // must not fall back to a default: `cloudRegion: "can"` silently meaning `us`
  // would point a Canadian account at the v3 endpoint that answers it HTTP 500,
  // forever, with no clue in the log.
  const region = normalizeCloudRegion(config.cloudRegion);
  if (config.cloudRegion !== undefined && region === undefined) {
    return 'cloudRegion must be "us" or "ca".';
  }
  const source = normalizeLocalCredentialSource(config.localCredentialSource);
  if (config.localCredentialSource !== undefined && source === undefined) {
    return 'localCredentialSource must be "v3" or "v2".';
  }
  // Contradictions, and only the ones with no single right answer. The three that
  // DO have one — a "ca" region told to use v3 secrets, and LAN control switched
  // off under a region or credential source that has no other transport — are
  // absorbed by reconcileImpliedConfig before this runs, because the Homebridge UI
  // manufactures exactly those out of its schema defaults. Re-adding them here
  // would be dead code: reconcile has already removed what they test for.
  //
  // This one stays fatal because both readings are defensible: the user either
  // wants no cloud (drop the v2 source) or wants the secrets fetched (drop
  // localOnly), and guessing wrong either exposes credentials or silently controls
  // nothing.
  if (config.localOnly && source === 'v2') {
    return 'localOnly forbids any cloud contact, so localCredentialSource "v2" cannot be used '
      + 'with it. Remove localOnly to let the plugin fetch the secrets, or keep declaring them '
      + 'in localDevices.';
  }

  if (config.localOnly) {
    // Local-only mode never authenticates, so cloud credentials are not required;
    // every unit must instead be fully declared in config.
    const devices = config.localDevices;
    if (!Array.isArray(devices) || devices.length === 0) {
      return 'localOnly requires a non-empty localDevices array. If you meant the plugin to '
        + 'fetch each unit\'s secrets from the v2 cloud, remove localOnly and set cloudRegion '
        + 'instead.';
    }
    const seen = new Set<string>();
    for (const d of devices) {
      if (!d || typeof d.deviceSerial !== 'string' || d.deviceSerial.trim().length === 0) {
        return 'Each localDevices entry requires a deviceSerial.';
      }
      if (seen.has(d.deviceSerial)) {
        // setCreds is keyed on the serial, so a duplicate silently overwrites the
        // first entry's credentials while the accessory keeps the first entry's
        // name — a confusing half-state to debug. Reject it instead.
        return `localDevices lists ${d.deviceSerial} more than once.`;
      }
      seen.add(d.deviceSerial);
      if (typeof d.ip !== 'string' || d.ip.trim().length === 0) {
        return `localDevices entry ${d.deviceSerial} requires an ip.`;
      }
      // One rule, shared with the units a v2 sign-in reports (settings.ts:
      // localSecretProblem) — the failure mode is identical either way, and the
      // hex check is a STRING match rather than a decode for the reason documented
      // there.
      const problem = localSecretProblem(d.password, d.cryptoSerial);
      if (problem === 'password') {
        return `localDevices entry ${d.deviceSerial} requires a password (base64).`;
      }
      if (problem === 'cryptoSerial') {
        return `localDevices entry ${d.deviceSerial} requires a cryptoSerial of at least 9 bytes `
          + '(18 hex characters).';
      }
    }
  } else {
    if (!config.username || !config.password) {
      return 'Username and password are required in config.';
    }
    if (typeof config.username !== 'string' || !config.username.includes('@')) {
      return 'Username must be a valid email address.';
    }
    if (typeof config.password !== 'string' || config.password.trim().length === 0) {
      return 'Password must be a non-empty string.';
    }
  }
  if (config.pollInterval !== undefined
    && (typeof config.pollInterval !== 'number' || config.pollInterval < 5)) {
    return 'Poll interval must be a number >= 5 seconds.';
  }
  // Only the schema policed this, and local-only users hand-edit config.json (the
  // form cannot express localDevices' secrets). A negative or sub-millisecond
  // value reaches setInterval, which Node clamps to 1ms: the local poller then
  // hammers the adapter without pause.
  if (config.localPollInterval !== undefined
    && (typeof config.localPollInterval !== 'number' || config.localPollInterval < 5)) {
    return 'Local poll interval must be a number >= 5 seconds.';
  }
  return null;
}

/**
 * Config that is accepted but pointless, as log-ready lines.
 *
 * Separate from validatePlatformConfig because these cannot misbehave: the option
 * is inert, so refusing to start over it would be worse than saying so. The
 * validator returns a single fatal reason; this returns any number of notes.
 */
export function configWarnings(config: KumoConfig): string[] {
  const notes: string[] = [];
  if (config.localOnly && config.cloudRegion !== undefined) {
    notes.push('cloudRegion is ignored in local-only mode (no cloud of any version is contacted).');
  }
  if (!config.localOnly && Array.isArray(config.localDevices) && config.localDevices.length > 0) {
    notes.push(
      `localDevices is only read in local-only mode; ignoring ${config.localDevices.length} `
      + 'entry(ies). Use localControlIps to pin an address, or cloudRegion/localCredentialSource '
      + 'to have the secrets fetched.',
    );
  }
  if (normalizeCloudRegion(config.cloudRegion) === 'ca') {
    const inert = ['pollInterval', 'disablePolling', 'degradedPollInterval', 'streamingHealthCheckInterval']
      .filter((key) => (config as unknown as Record<string, unknown>)[key] !== undefined);
    if (inert.length > 0) {
      notes.push(`cloudRegion "ca" never contacts the v3 API, so ${inert.join(', ')} do nothing.`);
    }
  }
  return notes;
}

export class KumoV3Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly accessoryHandlers: KumoThermostatAccessory[] = [];
  private readonly kumoAPI: KumoAPI;
  // Read by KumoThermostatAccessory for the per-accessory display options
  // (showDrySwitch / showFanOnlySwitch / exposeVaneSlat).
  public readonly kumoConfig: KumoConfig;
  /**
   * The three predicates the old single `localOnly` boolean was standing in for.
   * Named separately because they are NOT the same question, and collapsing them is
   * how "half a kill switch" happens:
   *
   *  - `v3Unavailable` — the v3 API must never be contacted. True for `localOnly`
   *    AND for `cloudRegion: 'ca'`, whose accounts v3 answers HTTP 500. Drives the
   *    KumoAPI kill switch, the site pollers, and the accessory's cloud fallback.
   *  - `inventoryFromV2` — units come from a v2 sign-in rather than from config or
   *    the v3 zones endpoint.
   *  - `localOnly` (unchanged, read directly) — the capabilities were DECLARED by
   *    hand, which is what makes the Dry/Fan tiles implicit. Under v2 they are
   *    DISCOVERED, and both are true on real hardware, so a v2 account must keep
   *    the tiles opt-in or every unit sprouts two tiles nobody asked for.
   */
  public readonly cloudRegion: CloudRegion;
  public readonly localCredentialSource: LocalCredentialSource;
  public readonly v3Unavailable: boolean;
  public readonly inventoryFromV2: boolean;
  private readonly sitePollers: Map<string, NodeJS.Timeout> = new Map();
  private readonly siteAccessories: Map<string, KumoThermostatAccessory[]> = new Map();
  private readonly degradedPollInterval: number;
  private isStreamingHealthy: boolean = false;
  private isDegradedMode: boolean = false;

  // Local LAN control (opt-in). The client is shared with accessories for
  // local-first command routing; the platform drives discovery + status polling.
  public localClient: LocalKumoClient | null = null;
  private localPollTimer: NodeJS.Timeout | null = null;
  private localSerials: string[] = [];
  private localCredRetryTimer: NodeJS.Timeout | null = null;
  private localCredRetryRunning: boolean = false;
  // Doubles per failed pass. Re-based to credRetryBaseMs once the source is known.
  private localCredRetryDelayMs: number = LOCAL_CRED_RETRY_BASE_MS;
  private localCredFailedPasses: number = 0;
  // Set once we stop chasing credentials. In-memory only: config.json is never
  // rewritten, so a restart retries from scratch and local control comes back by
  // itself if the cloud starts serving the credentials again.
  private localCredGaveUp: boolean = false;
  // The v2 bootstrap client, built on first use. Pre-assignable, which is what lets
  // a test drive the v2 path without putting HTTP on the wire.
  private v2Client: KumoV2Client | null = null;
  /**
   * Set when the v2 host REJECTED the credentials (401/403). Retrying an
   * authentication failure on a loop risks locking the account, and no amount of
   * waiting fixes a wrong password, so this stops both the discovery retry and the
   * credential retry for good. In-memory only: a restart tries again.
   */
  private v2AuthFatal: boolean = false;
  // Consecutive failed local polls per serial, for the latched unreachability
  // warning (see noteLocalPollFailure). Reset by the first successful poll.
  private readonly localPollFailures: Map<string, number> = new Map();

  // Device mirroring (opt-in). Constructed once after discovery when `mirror`
  // config is present; makes one unit follow another.
  private mirror: MirrorController | null = null;

  // Hysteresis for mode switching - prevents rapid oscillation on flaky connections
  private readonly modeChangeHysteresisMs: number = 10000; // 10 second stability required
  private pendingModeChange: NodeJS.Timeout | null = null;
  private pendingModeHealthy: boolean | null = null;

  // Discovery retry — self-heals from transient startup failures (e.g. DNS/login blips)
  private discoveryRetryTimer: NodeJS.Timeout | null = null;
  private discoveryRetryDelayMs: number = 30000; // grows via backoff, reset on success
  private readonly discoveryRetryBaseMs: number = 30000; // first retry after 30s
  private readonly discoveryRetryMaxMs: number = 300000; // cap backoff at 5 minutes

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.kumoConfig = config as unknown as KumoConfig;
    this.log.debug('Initializing platform:', this.config.name);

    // Normalize `localOnly` ONCE, before anything reads it. It used to be tested
    // two different ways — truthiness in validatePlatformConfig, startSitePoller
    // and attemptDiscovery, `=== true` for the KumoAPI kill switch and the
    // per-command cloud fallback — so a hand-edited `"localOnly": "true"` (or `1`)
    // selected the mode, was excused from providing credentials, and yet left the
    // cloud armed on the paths that matter. Local-only users hand-edit
    // config.json (the UI form cannot express localDevices' secrets), so a
    // non-boolean here is a realistic typo, and half a kill switch is worse than
    // none: it fails exactly when a LAN write fails. Truthiness is what decides,
    // matching the validator, and every later site now reads this one boolean.
    this.kumoConfig.localOnly = !!this.kumoConfig.localOnly;

    // Same treatment for the two enums, and for the same reason: normalize ONCE,
    // before anything reads them, so `"CA"` or `" ca "` from a hand-edited
    // config.json cannot select the mode on one site and miss it on another. A value
    // that does not normalize is left untouched, so the validator below rejects it
    // by name rather than defaulting it to something the user did not ask for.
    const normalizedRegion = normalizeCloudRegion(this.kumoConfig.cloudRegion);
    if (normalizedRegion !== undefined) {
      this.kumoConfig.cloudRegion = normalizedRegion;
    }
    const normalizedSource = normalizeLocalCredentialSource(this.kumoConfig.localCredentialSource);
    if (normalizedSource !== undefined) {
      this.kumoConfig.localCredentialSource = normalizedSource;
    }

    const kumoConfig = this.kumoConfig;
    // Before validation, not after: this removes the contradictions the Homebridge
    // UI manufactures out of schema defaults, which the validator would otherwise
    // treat as deliberate and go idle over.
    const reconciled = reconcileImpliedConfig(kumoConfig);
    const configError = validatePlatformConfig(kumoConfig);

    // Derived once, as readonly fields, rather than recomputed at each of the eight
    // sites that used to test `localOnly` directly. Assigned before the bail-out
    // below because `strict` requires every readonly field on every path out.
    this.cloudRegion = normalizedRegion ?? 'us';
    // `ca` implies the v2 source: v3 cannot serve those accounts at all.
    this.localCredentialSource = normalizeLocalCredentialSource(kumoConfig.localCredentialSource)
      ?? (this.cloudRegion === 'ca' ? 'v2' : 'v3');
    this.v3Unavailable = !!kumoConfig.localOnly || this.cloudRegion === 'ca';
    this.inventoryFromV2 = !kumoConfig.localOnly && this.cloudRegion === 'ca';
    this.localCredRetryDelayMs = this.credRetryBaseMs;

    // Configure degraded mode polling interval
    this.degradedPollInterval = (kumoConfig.degradedPollInterval || 10) * 1000;
    this.log.debug(`Degraded polling interval: ${this.degradedPollInterval / 1000}s`);

    // Assigned before the bail-out below because `strict` requires every readonly field to
    // be set on every path out of the constructor. Constructing KumoAPI is inert — it sets
    // two flags and logs — so building one that will never be used costs nothing. Streaming
    // is passed as disabled on the error path purely so it does not announce itself.
    // Local-only mode gets streaming disabled and the cloud transport hard-disabled,
    // so "never contacts the cloud" is enforced inside KumoAPI rather than by every
    // call site remembering the mode (and so startup does not announce a streaming
    // connection that will never be made).
    // The kill switch is armed for `cloudRegion: 'ca'` exactly as for `localOnly`.
    // That is the counter-intuitive part of the region: it DOES contact a cloud (one
    // v2 sign-in, from a separate module with its own fetch), and it must still
    // disable v3 completely — otherwise a command fallback, a site poller or a token
    // refresh reaches app-prod for an account that answers it HTTP 500, which is
    // permanent noise and repeated failed logins.
    this.kumoAPI = new KumoAPI(
      kumoConfig.username,
      kumoConfig.password,
      this.log,
      kumoConfig.debug || false,
      !configError && !this.v3Unavailable,
      this.v3Unavailable,
      // Told, not inferred: under a v2 credential source the v3 payloads are not
      // expected to carry the per-device LAN secrets, so KumoAPI must not report
      // their absence as an outage — and must not advise `localControl: false`, which
      // validatePlatformConfig rejects next to `localCredentialSource: 'v2'`.
      this.localCredentialSource,
    );

    for (const note of reconciled) {
      this.log.warn(note);
    }

    if (configError) {
      this.log.error(
        `${configError} This platform will stay idle until that is fixed in the Homebridge UI. `
        + 'Homebridge and your other plugins are unaffected.',
      );
      return;
    }

    for (const note of configWarnings(kumoConfig)) {
      this.log.warn(note);
    }

    // Configure streaming health monitoring
    const healthCheckInterval = kumoConfig.streamingHealthCheckInterval || 30;
    this.kumoAPI.setStreamingHealthCheckInterval(healthCheckInterval);

    // Register for streaming health changes
    this.kumoAPI.onStreamingHealthChange((isHealthy: boolean) => {
      this.handleStreamingHealthChange(isHealthy);
    });

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      log.debug('Shutting down platform');
      this.cleanup();
    });
  }

  private cleanup() {
    // Cancel any pending discovery retry
    if (this.discoveryRetryTimer) {
      clearTimeout(this.discoveryRetryTimer);
      this.discoveryRetryTimer = null;
    }

    // Stop local polling
    if (this.localPollTimer) {
      clearInterval(this.localPollTimer);
      this.localPollTimer = null;
    }

    // Stop the background local-credential retry
    this.stopLocalCredRetry();

    // Tear down mirroring timers
    if (this.mirror) {
      this.mirror.destroy();
      this.mirror = null;
    }

    // Clean up all site pollers
    for (const [siteId, timer] of this.sitePollers) {
      clearInterval(timer);
      this.log.debug(`Stopped site poller for ${siteId}`);
    }
    this.sitePollers.clear();

    // Clean up all accessory handlers
    for (const handler of this.accessoryHandlers) {
      handler.destroy();
    }
    this.accessoryHandlers.length = 0;

    // Clean up API
    this.kumoAPI.destroy();
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices(): Promise<void> {
    const success = await this.attemptDiscovery();

    if (success) {
      // Device mirroring (opt-in). Out here rather than at the end of the cloud
      // branch so local-only gets it too: MirrorController is transport-agnostic —
      // it listens on the handlers and writes through sendDeviceCommand — so it
      // works over the LAN, and better than over the cloud (no 7-10s lag). Inside
      // attemptDiscovery it sat after the local-only early return and a configured
      // `mirror` was silently ignored. Construct once — discovery can retry, so
      // guard on an existing controller to avoid double-registering source listeners.
      if (!this.mirror && this.kumoConfig.mirror && this.kumoConfig.mirror.length > 0) {
        this.mirror = new MirrorController(this.log, this.kumoConfig.mirror, this.accessoryHandlers);
        this.log.info(`Device mirroring enabled for ${this.kumoConfig.mirror.length} pair(s)`);
      }

      // Discovery succeeded: cancel any pending retry and reset the backoff.
      if (this.discoveryRetryTimer) {
        clearTimeout(this.discoveryRetryTimer);
        this.discoveryRetryTimer = null;
      }
      this.discoveryRetryDelayMs = this.discoveryRetryBaseMs;
      return;
    }

    this.scheduleDiscoveryRetry();
  }

  /**
   * Re-run discovery after a transient failure (e.g. a DNS/login blip at startup).
   * Without this, a single failed login left the plugin idle until a manual restart.
   * Backoff grows 30s -> 5min and then retries indefinitely, so the plugin recovers
   * on its own whenever connectivity returns.
   */
  private scheduleDiscoveryRetry(): void {
    if (this.discoveryRetryTimer) {
      return; // a retry is already queued
    }

    const delaySec = Math.round(this.discoveryRetryDelayMs / 1000);
    this.log.warn(`Device discovery did not complete - retrying in ${delaySec}s`);

    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = null;
      this.discoverDevices();
    }, this.discoveryRetryDelayMs);

    this.discoveryRetryDelayMs = Math.min(this.discoveryRetryDelayMs * 2, this.discoveryRetryMaxMs);
  }

  private async attemptDiscovery(): Promise<boolean> {
    try {
      if (this.kumoConfig.localOnly) {
        return await this.setupLocalOnly();
      }

      // A region whose accounts v3 cannot serve. Its inventory comes from a v2
      // sign-in and its control is LAN-only, but it is NOT local-only: capabilities
      // are discovered rather than declared, so the Dry/Fan tiles stay opt-in.
      if (this.inventoryFromV2) {
        return await this.setupV2Inventory();
      }

      this.log.info('Starting device discovery');

      // Login to API
      const loginSuccess = await this.kumoAPI.login();
      if (!loginSuccess) {
        this.log.error('Failed to login to Kumo Cloud API');
        return false;
      }

      // Get all sites
      const sites = await this.kumoAPI.getSites();
      if (sites.length === 0) {
        this.log.warn('No sites found');
        return false;
      }

      this.log.info(`Found ${sites.length} site(s)`);

      const discoveredDevices: Array<{ uuid: string; displayName: string; deviceSerial: string; zoneName: string }> = [];

      // For each site, get zones
      for (const site of sites) {
        this.log.debug(`Fetching zones for site: ${site.name}`);
        const zones = await this.kumoAPI.getZones(site.id);

        for (const zone of zones) {
          if (!zone.isActive) {
            this.log.debug(`Skipping inactive zone: ${zone.name}`);
            continue;
          }

          const deviceSerial = zone.adapter.deviceSerial;
          const displayName = zone.name;

          // Skip hidden devices
          if (this.kumoConfig.excludeDevices?.includes(deviceSerial)) {
            this.log.info(`Hiding device from HomeKit: ${displayName} (${deviceSerial})`);
            continue;
          }

          // Generate unique ID for this device
          const uuid = this.api.hap.uuid.generate(deviceSerial);

          discoveredDevices.push({
            uuid,
            displayName,
            deviceSerial,
            zoneName: zone.name,
          });

          this.log.info(`Discovered device: ${displayName} (${deviceSerial})`);

          // Idempotency: a previous (partial) discovery attempt may have already
          // created a handler for this device. Skip it so retries never double-register.
          if (this.accessoryHandlers.some(handler => handler.getDeviceSerial() === deviceSerial)) {
            this.log.debug(`Handler already initialized for ${deviceSerial}, skipping`);
            continue;
          }

          // Check if accessory already exists
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            // Update existing accessory
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            existingAccessory.context.device = {
              deviceSerial,
              zoneName: zone.name,
              displayName,
              siteId: site.id,
            };

            // Create accessory handler
            const handler = new KumoThermostatAccessory(this, existingAccessory, this.kumoAPI, this.kumoConfig.pollInterval);
            this.accessoryHandlers.push(handler);

            // Update accessory if needed
            this.api.updatePlatformAccessories([existingAccessory]);
          } else {
            // Create new accessory
            this.log.info('Adding new accessory:', displayName);

            const accessory = new this.api.platformAccessory(displayName, uuid);

            accessory.context.device = {
              deviceSerial,
              zoneName: zone.name,
              displayName,
              siteId: site.id,
            };

            // Create accessory handler
            const handler = new KumoThermostatAccessory(this, accessory, this.kumoAPI, this.kumoConfig.pollInterval);
            this.accessoryHandlers.push(handler);

            // Register accessory
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.push(accessory);
          }
        }
      }

      // A transient zones-fetch failure returns no zones, leaving this empty.
      // Treat that as a failure and retry rather than unregistering every cached
      // accessory as "stale".
      if (discoveredDevices.length === 0) {
        this.log.warn('No devices discovered - likely a transient API failure; will retry');
        return false;
      }

      // Remove accessories that were not discovered
      const staleAccessories = this.accessories.filter(
        accessory => !discoveredDevices.find(device => device.uuid === accessory.UUID),
      );

      if (staleAccessories.length > 0) {
        this.log.info(`Removing ${staleAccessories.length} stale accessory(ies)`);
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          staleAccessories,
        );
      }

      this.log.info('Device discovery completed');

      // Start streaming for all devices
      const allDeviceSerials = discoveredDevices.map(d => d.deviceSerial);
      if (allDeviceSerials.length > 0) {
        this.log.info('Starting streaming for real-time updates...');
        const streamingStarted = await this.kumoAPI.startStreaming(allDeviceSerials);

        if (streamingStarted) {
          this.log.info('✓ Streaming enabled - devices will update in real-time');
        } else {
          // startStreaming resolves false when the socket did not connect (error or
          // timeout). Nothing will fire a health change in that case - the socket was
          // never healthy to begin with - so this branch has to start the fallback
          // itself. Under `disablePolling: true` it is the only thing that starts any
          // poller at all; the branch used to log this line and poll nothing.
          this.log.warn('Streaming failed to start - falling back to polling');
          this.enterDegradedMode();
        }

        // Log startup configuration summary
        const healthCheckInterval = this.kumoConfig.streamingHealthCheckInterval || 30;

        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info('Mitsubishi Comfort Plugin Configuration');
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info(`Streaming: ${streamingStarted ? 'ENABLED' : 'DISABLED'}`);
        this.log.info(`Polling mode: ${this.kumoConfig.disablePolling ? 'On-demand only' : 'Enabled'}`);
        this.log.info(`Normal poll interval: ${(this.kumoConfig.pollInterval || 30)}s`);
        this.log.info(`Degraded poll interval: ${this.degradedPollInterval / 1000}s`);
        this.log.info(`Health check interval: ${healthCheckInterval}s`);
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (streamingStarted) {
          if (this.kumoConfig.disablePolling) {
            this.log.info('Strategy: Streaming primary, polling fallback only');
          } else {
            this.log.info('Strategy: Streaming primary, polling supplemental');
          }
        }

        // Local LAN control (opt-in). Set up in the background: it waits for the
        // adapter passwords (which arrive via adapter_update after streaming
        // connects), then discovers each unit's IP. Never blocks startup, and
        // cloud streaming stays up as the per-unit fallback.
        // `localCredentialSource: 'v2'` implies local control: fetching per-device LAN
        // secrets is only worth doing in order to use them (and the validator rejects
        // the explicit contradiction).
        if (this.kumoConfig.localControl || this.localCredentialSource === 'v2') {
          this.initLocalControl(allDeviceSerials).catch(err =>
            this.log.error('Local control setup failed:', err));
        }
      }

      // Start site-level polling based on configuration and streaming health
      if (!this.kumoConfig.disablePolling) {
        const uniqueSites = new Set(discoveredDevices.map(d =>
          this.accessories.find(a => a.UUID === d.uuid)?.context.device.siteId
        ).filter(Boolean));

        this.log.info(`Initializing pollers for ${uniqueSites.size} site(s)`);

        for (const siteId of uniqueSites) {
          this.startSitePoller(siteId as string);
        }
      } else {
        this.log.info('Polling disabled - will activate only if streaming fails');
      }

      return true;
    } catch (error) {
      this.log.error('Error during device discovery:', error);
      return false;
    }
  }

  /**
   * Local-only mode: build every accessory from `localDevices` and talk to each
   * unit exclusively over the LAN. No cloud of any version, on any path.
   *
   * The cloud is not always a usable source of the two per-device secrets the
   * local API needs: since 2026-07-31 the v3 cloud serves neither of them
   * (pykumo #78), and Canadian accounts are handled by a separate backend that
   * the v3 endpoints reject outright. Anyone holding their secrets can keep
   * local control by declaring them in config. Where a v2 sign-in IS possible,
   * `cloudRegion`/`localCredentialSource` fetch them instead — this mode is now
   * only for running with no cloud contact whatsoever.
   */
  private async setupLocalOnly(): Promise<boolean> {
    const devices = this.kumoConfig.localDevices || [];
    this.log.info(`Local-only mode: ${devices.length} device(s) declared in config`);
    return this.setupLocalUnits(
      devices.map((device) => this.resolveConfigUnit(device)),
      {
        label: 'localDevices',
        adjective: 'declared',
        // Unchanged wording: in this mode NO cloud of any version is contacted, and
        // that is the promise the line is making.
        summary: 'Local-only control active for %s device(s) — cloud never contacted',
      },
    );
  }

  /** A hand-declared unit: address and secrets given, capabilities synthesised. */
  private resolveConfigUnit(device: LocalDeviceConfig): ResolvedLocalUnit {
    return {
      deviceSerial: device.deviceSerial,
      displayName: device.name || device.deviceSerial,
      ip: device.ip,
      creds: { password: device.password, cryptoSerial: device.cryptoSerial },
      profile: this.syntheticProfile(device),
      source: 'config',
    };
  }

  /**
   * `cloudRegion: 'ca'`: one v2 sign-in supplies the whole inventory — units, room
   * names, each unit's REAL capability profile, and the two LAN secrets — and the
   * LAN does everything after that. The v3 API is never touched (its kill switch is
   * armed in the constructor), and neither is any other v2 endpoint: there is no
   * socket, no streaming and no MQTT anywhere in the v2 tree, so the LAN poller is
   * the only status source in this mode.
   *
   * Registration is deliberately the SAME code path as local-only below. Only the
   * resolution above it differs, which is what keeps the loop's two non-obvious
   * ordering constraints (credentials before the handler, profile strictly after
   * it) in one place.
   */
  private async setupV2Inventory(): Promise<boolean> {
    if (this.v2AuthFatal) {
      // `true` means "not transient": the retry loop would re-post rejected
      // credentials every 30s-5min forever. Already reported once, loudly.
      return true;
    }

    const inventory = await this.v2SignIn();
    if (!inventory) {
      // A refused sign-in is permanent (return true, no retry); anything else is
      // worth the caller's 30s -> 5min backoff.
      return this.v2AuthFatal;
    }

    const units = this.resolveV2Units(inventory);
    if (units.length === 0) {
      this.log.warn(
        'V2: not one unit came back with usable local credentials, so there is nothing to '
        + 'control. Every unit is listed above with the reason.',
      );
      return false;
    }

    return this.setupLocalUnits(
      units,
      {
        label: 'the v2 cloud reply',
        adjective: 'discovered',
        // Deliberately different from local-only's: one v2 sign-in DID happen, so
        // claiming "cloud never contacted" here would be false.
        summary: 'Local control active for %s device(s) — LAN only, the v3 cloud never contacted',
      },
      // EVERY unit the tree listed, not just the ones we could credential. This is
      // what keeps the stale sweep below from unregistering a cached accessory whose
      // secrets merely came back empty — see the parameter's doc comment.
      inventory.devices.map((device) => device.deviceSerial),
    );
  }

  /**
   * One v2 sign-in. Everything logged from here is DERIVED — counts, serials, room
   * labels, a host name. The reply itself never reaches a log call at any level:
   * it carries every unit's local password and cryptoSerial, a session token, and
   * (in the parts the parser refuses to read) the account holder's name, phone,
   * email and every site's postal address. See the header of src/kumo-v2.ts.
   */
  private async v2SignIn(): Promise<V2Inventory | null> {
    const { host } = v2Endpoint(this.cloudRegion);
    // Pre-assignable, exactly like localClient, so a test can drive this path
    // without putting HTTP on the wire.
    this.v2Client = this.v2Client ?? new KumoV2Client(this.log, this.cloudRegion);

    const outcome = await this.v2Client.login(this.kumoConfig.username, this.kumoConfig.password);
    const inventory = outcome.inventory;
    if (!inventory || inventory.devices.length === 0) {
      if (outcome.fatal) {
        this.v2AuthFatal = true;
        this.log.error(
          `V2 sign-in refused (${outcome.reason}). Check the username and password, and that `
          + `cloudRegion names the backend that serves this account — ${host} is the one for `
          + 'this setting. Not retrying: repeating a rejected sign-in risks locking the account. '
          + 'Fix the credentials and restart Homebridge.',
        );
      } else {
        this.log.warn(`V2 sign-in did not complete (${outcome.reason})`);
      }
      return null;
    }

    this.log.info(
      `V2: signed in to ${host}; ${inventory.devices.length} unit(s) in `
      + `${inventory.siteCount} site(s), ${inventory.creds.size} with local secrets`,
    );
    for (const note of inventory.problems) {
      this.log.warn(`V2: ${note}`);
    }
    return inventory;
  }

  /**
   * The units a v2 reply can actually be used for.
   *
   * A unit with no usable secrets is skipped rather than registered: with no cloud
   * control path in this region it would be a permanently dead tile. The parser has
   * already named it and said which value was wrong (never what the value was).
   */
  private resolveV2Units(inventory: V2Inventory): ResolvedLocalUnit[] {
    const manual = normalizeLocalControlIps(this.kumoConfig.localControlIps);
    const units: ResolvedLocalUnit[] = [];
    for (const device of inventory.devices) {
      const creds = inventory.creds.get(device.deviceSerial);
      if (!creds) {
        continue;
      }
      units.push({
        deviceSerial: device.deviceSerial,
        displayName: device.label || device.deviceSerial,
        // A configured override wins over the address the cloud reported: the user
        // set it precisely because the cloud's answer was absent or wrong. Either
        // way, an address here spares this unit the 5-30s LAN sweep.
        ip: manual[device.deviceSerial] || device.ip,
        creds,
        // The real profile is the point of the v2 bootstrap. A unit that has not
        // reported one yet (`success: 0`, `firmwareVersion: "00.00.00"` in the wild)
        // falls back to the same defaults the cloud path uses — per unit, not as one
        // global decision.
        profile: device.profile ?? this.syntheticProfile({}),
        seed: device.condition,
        source: 'v2',
        celsius: inventory.celsius,
      });
    }
    return units;
  }

  /**
   * Register a resolved set of LAN units and start polling them.
   *
   * Shared by local-only (units from config) and `cloudRegion: 'ca'` (units from a
   * v2 sign-in). Two ordering constraints in here are easy to get wrong and silent
   * when they are:
   *
   *  - `setCreds` BEFORE the handler is constructed, so the accessory's first read
   *    can be served over the LAN straight away.
   *  - `emitDeviceProfile` strictly AFTER it: the accessory subscribes to profile
   *    updates in its own constructor, so emitting first drops the profile on the
   *    floor — leaving default setpoint bounds, every mode offered, and no
   *    Dry/Fan/Slats services.
   */
  private async setupLocalUnits(
    units: ResolvedLocalUnit[],
    origin: LocalUnitOrigin,
    /**
     * Every serial the inventory still lists, including the ones that could not be
     * admitted. Only the stale sweep reads it, and only to NOT sweep them.
     *
     * The distinction it draws is the whole point: "this unit is gone" and "this
     * unit's local secrets came back empty" are different facts with the same shape
     * here, because an uncredentialed unit gets no accessory. Treating the second as
     * the first unregisters the accessory — and with it the user's room assignment,
     * custom name and every scene and automation that referenced it — on precisely
     * the provider-side failure this feature exists to work around (the v3 cloud
     * stopped serving both secrets on 2026-07-31, pykumo #78; a v2 reply can come
     * back with `password: ""` the same way). Next restart it returns as a brand-new
     * accessory. The v3 discovery path already refuses to sweep on a transient
     * failure, and the "everything excluded" branch below states the same principle.
     *
     * Empty for local-only, where an undeclared unit genuinely is gone from config.
     */
    retainSerials: string[] = [],
  ): Promise<boolean> {
    // `?? new` rather than plain `new`: a pre-assigned client is honoured, which
    // is what lets a test drive this path without putting HTTP on the wire. In
    // production it is always null here.
    this.localClient = this.localClient ?? new LocalKumoClient(this.log);

    const liveUuids: string[] = [];
    // Filled from the units we actually admit, NOT from every one offered: an
    // excluded unit gets no accessory and no credentials, so counting it here would
    // make countLocalDevices under-report and pendingLocalSerials list it as forever
    // awaiting credentials.
    this.localSerials = [];
    const admitted: ResolvedLocalUnit[] = [];

    for (const unit of units) {
      const { deviceSerial, displayName } = unit;

      if (this.kumoConfig.excludeDevices?.includes(deviceSerial)) {
        this.log.info(`Hiding device from HomeKit: ${displayName} (${deviceSerial})`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(deviceSerial);
      liveUuids.push(uuid);
      this.localSerials.push(deviceSerial);
      admitted.push(unit);

      // Seed the transport before the accessory exists. A v2 unit whose address is
      // not known yet is seeded after the LAN sweep instead (resolveMissingLocalIps).
      if (unit.ip && unit.creds) {
        this.localClient.setCreds(deviceSerial, { ip: unit.ip, ...unit.creds });
      }

      // Idempotency, mirroring the cloud path: a retry must never double-register.
      if (this.accessoryHandlers.some(handler => handler.getDeviceSerial() === deviceSerial)) {
        this.log.debug(`Handler already initialized for ${deviceSerial}, skipping`);
        continue;
      }

      // LOCAL_ONLY_SITE_ID even for a v2 account, which HAS a real site id. Nothing
      // would poll it — startSitePoller is guarded — but a real id sitting in
      // accessory context is one mistake away from `GET /v3/sites/<v2-id>/zones`,
      // the exact request this mode promises never to make.
      const context = { deviceSerial, zoneName: displayName, displayName, siteId: LOCAL_ONLY_SITE_ID };
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      // Seed HomeKit's temperature unit from the account preference, ONCE. The
      // characteristic has no other source, so it otherwise reads Fahrenheit on a
      // Celsius account. Writing it only when unset is the whole point: flipping the
      // unit in HomeKit persists 'C'/'F' into this same context, and re-applying the
      // cloud's answer on every restart would silently undo the user's choice.
      const target = existingAccessory ?? undefined;
      if (unit.celsius !== undefined && target && target.context.displayUnits === undefined) {
        target.context.displayUnits = unit.celsius ? 'C' : 'F';
      }
      let handler: KumoThermostatAccessory;

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = context;
        handler = new KumoThermostatAccessory(
          this, existingAccessory, this.kumoAPI, this.kumoConfig.pollInterval,
        );
        this.accessoryHandlers.push(handler);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info('Adding new accessory:', displayName);
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context.device = context;
        if (unit.celsius !== undefined) {
          accessory.context.displayUnits = unit.celsius ? 'C' : 'F';
        }
        handler = new KumoThermostatAccessory(
          this, accessory, this.kumoAPI, this.kumoConfig.pollInterval,
        );
        this.accessoryHandlers.push(handler);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }

      // Capability-gated services (Dry/Fan switches, setpoint ranges) normally wait
      // on the cloud's `profile_update`, which never arrives in either of these
      // modes. Feed the accessory the profile resolved above instead — the real one
      // from v2 where there is one, the config-assembled stand-in otherwise.
      //
      // MUST stay after the handler construction above (see the doc comment).
      this.kumoAPI.emitDeviceProfile(deviceSerial, unit.profile);

      // A cloud-lagged snapshot, where the source had one. Only ever a seed: the
      // first LAN poll follows within a second and overwrites it, and processing it
      // as 'local' costs nothing in a mode that has no other status source. Without
      // it a unit that is unreachable on the LAN shows a blank tile rather than the
      // last state the cloud saw.
      if (unit.seed) {
        handler.updateFromLocal(unit.seed);
      }
    }

    if (liveUuids.length === 0) {
      // A permanent config fault, so return true: `false` means "transient, retry",
      // and no amount of retrying un-excludes a device. Cached accessories are
      // deliberately left registered rather than swept — an excludeDevices typo
      // should not cost the user their HomeKit room assignments and automations.
      this.log.error(
        `Local control: every ${origin.adjective} device is excluded — nothing to register. `
        + `Check excludeDevices against ${origin.label}; retrying cannot help.`,
      );
      return true;
    }

    // A unit is stale only when the inventory no longer mentions it at all. An
    // excluded serial is deliberately NOT retained: hiding it from HomeKit is the
    // point of excludeDevices, so unregistering it is correct.
    const keepUuids = new Set(liveUuids);
    for (const serial of retainSerials) {
      if (this.kumoConfig.excludeDevices?.includes(serial)) {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(serial);
      if (!keepUuids.has(uuid) && this.accessories.some(accessory => accessory.UUID === uuid)) {
        this.log.warn(
          `Local control: keeping ${serial}'s existing HomeKit accessory even though it cannot be `
          + 'controlled right now — it will stop responding rather than lose its room, its name '
          + 'and its automations. It recovers by itself once the credentials come back.',
        );
      }
      keepUuids.add(uuid);
    }

    const staleAccessories = this.accessories.filter(accessory => !keepUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      this.log.info(`Removing ${staleAccessories.length} stale accessory(ies)`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      // Also drop them from our own list, or a later pass would hand the same
      // accessories to unregisterPlatformAccessories again — and HAP-NodeJS throws
      // ("Cannot find the bridged Accessory to remove") rather than ignoring it.
      for (const stale of staleAccessories) {
        const i = this.accessories.indexOf(stale);
        if (i >= 0) {
          this.accessories.splice(i, 1);
        }
      }
    }

    await this.resolveMissingLocalIps(admitted);
    this.startLocalPolling();
    await this.reportLocalReachability(admitted, origin);
    return true;
  }

  /**
   * Find the LAN address of any admitted unit that does not have one yet.
   *
   * A no-op for hand-declared units (config carries the address) and for a v2
   * account whose tree happened to include `address`. Otherwise this is the
   * existing token-matching sweep, reused verbatim: the v2 reply carries a MAC, but
   * a MAC cannot prove identity for our purposes — the token probe has to run
   * anyway to confirm the serial after a DHCP lease moves — and an ARP read is L2,
   * so it cannot see a unit on another subnet the way the L3 sweep can.
   */
  private async resolveMissingLocalIps(units: ResolvedLocalUnit[]): Promise<void> {
    const local = this.localClient;
    if (!local) {
      return;
    }
    const pending = new Map<string, SerialCreds>();
    for (const unit of units) {
      if (unit.creds && !local.hasLocal(unit.deviceSerial)) {
        pending.set(unit.deviceSerial, unit.creds);
      }
    }
    if (pending.size === 0) {
      return;
    }
    this.log.info(`Local control: ${pending.size} unit(s) have no address yet — looking on the LAN`);
    await this.admitLocalDevices(pending);
  }

  /**
   * Read each declared unit once and report which ones actually answered.
   *
   * Everything above this trusts config completely — credentials and addresses are
   * seeded, accessories are registered, and a wrong cryptoSerial or a stale DHCP
   * lease shows up only as a debug-level poll error. That was survivable while a
   * failed local write fell through to the cloud. It is not now: local-only has no
   * fallback, so an unreachable unit is a tile that never updates and never
   * responds, and the startup line has to say so instead of claiming success.
   *
   * Best-effort by construction: one read per unit, in parallel, each guarded, and
   * the outcome never changes whether discovery succeeded.
   */
  private async reportLocalReachability(
    units: ResolvedLocalUnit[],
    origin: LocalUnitOrigin,
  ): Promise<void> {
    const local = this.localClient;
    if (!local) {
      return;
    }
    const reachable = await Promise.all(units.map(async (unit) => {
      try {
        return (await local.getStatus(unit.deviceSerial)) !== null;
      } catch {
        return false;
      }
    }));

    const ok = reachable.filter(Boolean).length;
    units.forEach((unit, i) => {
      if (!reachable[i]) {
        // The address may have come from config, from the v2 reply, or from the LAN
        // sweep — the client is the one place that knows which one won.
        const ip = local.getIp(unit.deviceSerial) ?? unit.ip;
        this.log.warn(
          `Local control: no answer from ${unit.displayName} `
          + `${ip ? `at ${ip}` : '(no address found on the LAN)'}. `
          + 'Check the address (a DHCP reservation avoids this) and that the password and '
          + 'cryptoSerial belong to THIS unit — there is no cloud fallback in this mode.',
        );
      }
    });
    this.log.info(`✓ ${origin.summary.replace('%s', `${ok}/${units.length}`)}`);
  }

  /**
   * A profile assembled from config, standing in for the cloud's `profile_update`.
   *
   * Defaults suit a typical wall-mounted heat pump. hasModeDry / hasModeVent
   * declare what the UNIT can do, and in this mode that declaration also brings the
   * Dry / Fan-only switch tile with it (see LocalDeviceConfig.hasModeDry and
   * accessory.wantsModeSwitch) — an explicit showDrySwitch/showFanOnlySwitch
   * `false` still suppresses it.
   *
   * The 16-31°C fallback is the same one the cloud path uses when profile_update
   * omits the range (kumo-api.ts), so an undeclared local-only unit behaves like a
   * cloud unit with an incomplete profile rather than inventing a third policy.
   */
  private syntheticProfile(device: Partial<LocalDeviceConfig>): DeviceProfile {
    const min = device.minSetPoint ?? 16;
    const max = device.maxSetPoint ?? 31;
    return {
      numberOfFanSpeeds: device.numberOfFanSpeeds ?? 4,
      hasFanSpeedAuto: device.hasFanSpeedAuto ?? true,
      hasModeDry: device.hasModeDry ?? false,
      // true, where the cloud fallback is false: here the profile is DECLARED, not
      // guessed, and dryUsesSetpoint() already assumes a setpoint exists whenever
      // the profile is unknown. Set it false for a unit that dehumidifies without
      // a target.
      usesSetPointInDryMode: device.usesSetPointInDryMode ?? true,
      hasModeHeat: device.hasModeHeat ?? true,
      hasModeVent: device.hasModeVent ?? false,
      hasVaneDir: device.hasVaneDir ?? true,
      hasVaneSwing: device.hasVaneSwing ?? true,
      // Neither flag is read anywhere in the plugin; the value is immaterial.
      hasDefrost: true,
      hasStandby: true,
      minimumSetPoints: { cool: min, heat: min, auto: min },
      maximumSetPoints: { cool: max, heat: max, auto: max },
    };
  }

  /**
   * Set up local LAN control: wait for the per-device credentials, resolve each
   * unit's IP (manual override or LAN sweep), and start local status polling.
   * Best-effort and per-device — any unit we can't reach locally simply stays on
   * the cloud path. Runs in the background; never blocks discovery.
   */
  private async initLocalControl(serials: string[]): Promise<void> {
    this.log.info(
      `Local control enabled — gathering credentials from the ${this.localCredentialSource} cloud...`,
    );
    this.localClient = new LocalKumoClient(this.log);
    this.localSerials = serials;

    const creds = await this.gatherCreds(serials, LOCAL_CRED_INITIAL_WAIT_MS);
    if (creds.size > 0) {
      this.log.info(`Local control: credentials for ${creds.size}/${serials.length} device(s)`);
      await this.admitLocalDevices(creds);
    } else {
      this.log.warn('Local control: no credentials obtained yet — staying on cloud for now');
    }

    const localCount = this.countLocalDevices();
    if (localCount > 0) {
      this.log.info(`✓ Local control active for ${localCount}/${serials.length} device(s)`);
      this.startLocalPolling();
    } else {
      this.log.warn('Local control: no devices reachable on the LAN — staying on cloud');
    }

    // Some adapters answer `adapterStatus` slowly (or not at all until they
    // recover from a wedged cloud session), so a fixed startup window silently
    // strands them on the cloud for the life of the process. Keep nudging the
    // stragglers in the background and admit each one the moment its
    // credentials show up. The nudging backs off and eventually gives up: since
    // 2026-07-31 the cloud serves no credentials at all, and an endless retry
    // against that is only noise (see abandonLocalCreds).
    this.scheduleLocalCredRetry();
  }

  /**
   * Both halves of the local key for the given devices, from whichever source is
   * configured.
   *
   * A dispatcher rather than an overload of gatherLocalCreds: the v3 gather is a
   * socket-nudging poll loop and the v2 gather is a single sign-in, and they share
   * nothing but the return type. Everything downstream (admitLocalDevices,
   * startLocalPolling, the retry schedule) consumes the same
   * `Map<serial, SerialCreds>` and does not care which produced it.
   */
  private async gatherCreds(serials: string[], waitMs: number): Promise<Map<string, SerialCreds>> {
    if (this.localCredentialSource === 'v2') {
      return this.gatherV2Creds(serials);
    }
    return this.gatherLocalCreds(serials, waitMs);
  }

  /**
   * The v2 sign-in as a credential source for units discovered over v3.
   *
   * This is the majority case since 2026-07-31: a US account whose v3 control works
   * perfectly but whose v3 payloads no longer carry the two secrets (pykumo #78).
   * The v2 reply is filtered to the serials v3 already discovered, so a unit that
   * only exists on one of the two backends is ignored rather than half-registered.
   * Profiles are NOT taken from here in this mode — the v3 `profile_update` already
   * supplies them, and one source per fact is easier to reason about.
   */
  private async gatherV2Creds(serials: string[]): Promise<Map<string, SerialCreds>> {
    const creds = new Map<string, SerialCreds>();
    if (this.v2AuthFatal) {
      return creds;
    }
    const inventory = await this.v2SignIn();
    if (!inventory) {
      return creds;
    }
    const wanted = new Set(serials);
    for (const [serial, c] of inventory.creds) {
      if (wanted.has(serial)) {
        creds.set(serial, c);
      }
    }
    const extra = inventory.creds.size - creds.size;
    if (extra > 0) {
      this.log.debug(`V2: ignoring ${extra} unit(s) the v3 cloud did not discover`);
    }
    return creds;
  }

  /**
   * Nudge each device for its `adapter_update` and collect both halves of the
   * local key (password from the socket, cryptoSerial from REST), giving up
   * after `waitMs`. Only returns entries for devices that yielded both.
   */
  private async gatherLocalCreds(serials: string[], waitMs: number): Promise<Map<string, SerialCreds>> {
    for (const serial of serials) {
      this.kumoAPI.requestAdapterStatus(serial);
    }
    const creds = new Map<string, SerialCreds>();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && creds.size < serials.length) {
      for (const serial of serials) {
        if (creds.has(serial)) {
          continue;
        }
        const password = this.kumoAPI.getAdapterPassword(serial);
        if (!password) {
          continue;
        }
        const cryptoSerial = await this.kumoAPI.getDeviceCryptoSerial(serial);
        if (cryptoSerial) {
          creds.set(serial, { password, cryptoSerial });
        }
      }
      if (creds.size < serials.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        for (const serial of serials) {
          if (!creds.has(serial)) {
            this.kumoAPI.requestAdapterStatus(serial);
          }
        }
      }
    }
    return creds;
  }

  /**
   * Resolve each credentialed device's IP (configured override first, then a LAN
   * sweep for the rest) and hand it to the local client.
   */
  private async admitLocalDevices(creds: Map<string, SerialCreds>): Promise<void> {
    if (!this.localClient) {
      return;
    }
    const manual = normalizeLocalControlIps(this.kumoConfig.localControlIps);
    const toDiscover = new Map<string, SerialCreds>();
    for (const [serial, c] of creds) {
      if (manual[serial]) {
        this.localClient.setCreds(serial, { ...c, ip: manual[serial] });
        this.log.info(`Local control: ${serial} -> ${manual[serial]} (configured)`);
      } else {
        toDiscover.set(serial, c);
      }
    }
    if (toDiscover.size === 0) {
      return;
    }
    const hostIp = this.getHostIpv4();
    if (!hostIp) {
      this.log.warn('Local control: could not determine the host LAN subnet for discovery');
      return;
    }
    const candidates = enumerateSubnet(hostIp);
    this.log.info(`Local control: sweeping ${candidates.length} addresses on ${hostIp}'s subnet...`);
    const ips = await discoverDeviceIps(this.log, candidates, toDiscover);
    for (const [serial, ip] of ips) {
      this.localClient.setCreds(serial, { ...toDiscover.get(serial)!, ip });
    }
  }

  private countLocalDevices(): number {
    if (!this.localClient) {
      return 0;
    }
    return this.localSerials.filter(serial => this.localClient!.hasLocal(serial)).length;
  }

  private pendingLocalSerials(): string[] {
    if (!this.localClient) {
      return [];
    }
    return this.localSerials.filter(serial => !this.localClient!.hasLocal(serial));
  }

  /**
   * Background retry for devices that haven't yielded local credentials yet.
   * A nudge is a single socket emit and the expensive part (the LAN sweep) only
   * runs when a device actually hands over its credentials, but a pass re-nudges
   * every pending device every couple of seconds for the length of its window, so
   * a fixed 60s interval against devices that will never answer cost ~1440 emits
   * an hour and never stopped. Same self-scheduling backoff as
   * scheduleDiscoveryRetry: 60s doubling to a 30 minute cap, then give up.
   * Stops early once every device is local.
   */
  private scheduleLocalCredRetry(): void {
    if (this.localCredRetryTimer || this.localCredGaveUp || this.pendingLocalSerials().length === 0) {
      return;
    }
    if (this.v2AuthFatal) {
      return; // rejected credentials: already reported, and no retry can help
    }
    this.localCredRetryTimer = setTimeout(() => {
      this.localCredRetryTimer = null;
      void this.retryLocalCreds().then(() => this.scheduleLocalCredRetry());
    }, this.localCredRetryDelayMs);

    this.localCredRetryDelayMs = Math.min(this.localCredRetryDelayMs * 2, LOCAL_CRED_RETRY_MAX_MS);
  }

  /**
   * Where the credential-retry backoff starts. A v2 sign-in is a full
   * authentication whose reply is complete, so re-asking within minutes cannot
   * produce anything new — it starts a quarter of an hour out rather than at 60s.
   */
  private get credRetryBaseMs(): number {
    return this.localCredentialSource === 'v2' ? V2_CRED_RETRY_BASE_MS : LOCAL_CRED_RETRY_BASE_MS;
  }

  private async retryLocalCreds(): Promise<void> {
    // A sweep can outlast the delay; never let two passes overlap.
    if (this.localCredRetryRunning || !this.localClient || this.localCredGaveUp) {
      return;
    }
    const pending = this.pendingLocalSerials();
    if (pending.length === 0) {
      this.stopLocalCredRetry();
      return;
    }
    this.localCredRetryRunning = true;
    try {
      const creds = await this.gatherCreds(pending, LOCAL_CRED_RETRY_WAIT_MS);
      if (creds.size === 0) {
        this.log.debug(
          `Local control: still waiting on ${pending.length} device(s) ` +
          `(pass ${this.localCredFailedPasses + 1}/${LOCAL_CRED_MAX_FAILED_PASSES})`,
        );
        this.noteFailedCredPass(pending);
        return;
      }
      // Credentials are flowing again, so restart the backoff at its base delay
      // for whatever is still pending.
      this.localCredFailedPasses = 0;
      this.localCredRetryDelayMs = this.credRetryBaseMs;
      this.log.info(`Local control: credentials arrived for ${creds.size} more device(s)`);
      await this.admitLocalDevices(creds);
      const localCount = this.countLocalDevices();
      if (localCount > 0) {
        this.log.info(`✓ Local control active for ${localCount}/${this.localSerials.length} device(s)`);
        // No-op if it's already running.
        this.startLocalPolling();
      }
      if (this.pendingLocalSerials().length === 0) {
        this.stopLocalCredRetry();
      }
    } catch (error) {
      this.log.debug(`Local control retry failed: ${(error as Error).message}`);
      this.noteFailedCredPass(pending);
    } finally {
      this.localCredRetryRunning = false;
    }
  }

  /** Count one fruitless pass and stop for good once we hit the ceiling. */
  private noteFailedCredPass(pending: string[]): void {
    this.localCredFailedPasses++;
    if (this.localCredFailedPasses >= LOCAL_CRED_MAX_FAILED_PASSES) {
      this.abandonLocalCreds(pending);
    }
  }

  /**
   * Stop chasing credentials that are not coming, and say so once.
   *
   * Verified 2026-07-31: Mitsubishi's v3 cloud stopped distributing both halves of
   * the local key. `password` is gone from the `adapter_update` socket event and
   * `cryptoSerial` is gone from GET /devices/{serial}/status. Reproduced on
   * unrelated accounts and on a second client stack (pykumo issue #78), so it is a
   * cloud-side change, not a per-account or per-network fault. Retrying forever is
   * noise, and a debug-only line is a silent failure.
   *
   * Nothing is persisted: the give-up flag lives in this process only and the
   * plugin never rewrites config.json, so `localControl` stays true and the next
   * Homebridge restart runs the whole credential gather again. If the cloud starts
   * serving the fields, local control returns with no user action.
   */
  private abandonLocalCreds(pending: string[]): void {
    this.localCredGaveUp = true;
    this.stopLocalCredRetry();

    // With no device on the local path, keeping a client around only makes the
    // plugin present as local-capable: accessory.sendDeviceCommand and
    // scheduleSetpointReconcile evaluate their local guards on every write for a
    // path that cannot work. Drop it so they go straight to the cloud. A partial
    // result (some units local) keeps the client, since those units still work.
    if (this.countLocalDevices() === 0) {
      this.localClient = null;
      if (this.localPollTimer) {
        clearInterval(this.localPollTimer);
        this.localPollTimer = null;
      }
    }

    this.log.warn(
      `Local control unavailable: Kumo Cloud stopped returning the per-device local credentials ` +
      `(the adapter password in adapter_update and cryptoSerial in GET /devices/{serial}/status are ` +
      `both absent), so after ${LOCAL_CRED_MAX_FAILED_PASSES} attempts over about an hour ` +
      `${pending.length} device(s) are using cloud control. This is a cloud-side change, not a ` +
      `problem with your network or your units, and every feature keeps working over the cloud. ` +
      `Set "localControl": false in the Homebridge config to silence this; leaving it true costs ` +
      `nothing and local control resumes on its own at the next restart if the credentials come back.`,
    );
  }

  private stopLocalCredRetry(): void {
    if (this.localCredRetryTimer) {
      clearTimeout(this.localCredRetryTimer);
      this.localCredRetryTimer = null;
    }
  }

  /** Find the host's primary private-LAN IPv4 (to derive the sweep subnet). */
  private getHostIpv4(): string | null {
    const ifaces = os.networkInterfaces();
    let fallback: string | null = null;
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family !== 'IPv4' || ni.internal || ni.address.startsWith('169.254.')) {
          continue;
        }
        // Prefer a private-LAN address (10/8, 192.168/16, 172.16/12) over e.g. a
        // CGNAT/VPN range like Tailscale's 100.64/10.
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
          return ni.address;
        }
        fallback = fallback || ni.address;
      }
    }
    return fallback;
  }

  /** Poll the locally-reachable units and feed their status into the accessories. */
  private startLocalPolling(): void {
    if (this.localPollTimer) {
      return;
    }
    const interval = (this.kumoConfig.localPollInterval || 15) * 1000;
    this.log.info(`Local status polling every ${interval / 1000}s`);

    void this.pollLocalDevices();
    this.localPollTimer = setInterval(() => void this.pollLocalDevices(), interval);
  }

  /**
   * One pass over the locally-reachable units: read each, feed the accessory.
   *
   * A method rather than a closure inside startLocalPolling so a test can run a
   * single pass without arming a 15s interval or waiting one out.
   */
  private async pollLocalDevices(): Promise<void> {
    if (!this.localClient) {
      return;
    }
    for (const handler of this.accessoryHandlers) {
      const serial = handler.getDeviceSerial();
      if (!this.localClient.hasLocal(serial)) {
        continue;
      }
      try {
        const { status, error } = await this.localClient.getStatusDetailed(serial);
        if (status) {
          handler.updateFromLocal(status);
          this.noteLocalPollSuccess(serial);
        } else {
          // A null status is not an exception: the adapter answers HTTP 200 with
          // `{"_api_error": ...}` to a bad credential, and a read returns nothing
          // usable for a body with no roomTemp. Silence here is what made a wrong
          // cryptoSerial or a moved DHCP lease invisible for the life of the
          // process — see noteLocalPollFailure.
          //
          // The CAUSE is named, not just the failure. One string for six causes is
          // what made three real episodes unreadable — up to four minutes of stale
          // tile each, all logged identically — when the classification already
          // existed one call down and was thrown away here. "unreachable" and
          // "wedged" call for opposite responses from the person reading the log.
          this.noteLocalPollFailure(serial, describeLocalFailure(error));
        }
      } catch (error) {
        this.noteLocalPollFailure(serial, (error as Error).message);
      }
    }
  }

  /**
   * Record a local poll that produced no status, and say so once per outage.
   *
   * Every individual failure stays at debug: the adapter tolerates roughly one
   * connection at a time, so a single dropped read is routine and warning on each
   * one would train the user to ignore the log. What is NOT routine is a unit that
   * has answered nothing for LOCAL_POLL_WARN_AFTER polls in a row — at the default
   * 15s interval, three quarters of a minute of a tile that is quietly frozen, and in
   * local-only mode there is no other status source to correct it (nor does anything
   * here mark an accessory Not Responding: the cloud's `device_status_v2` is logged
   * and nothing more). That gets one warning, latched until the unit answers again,
   * so it can neither flood nor be missed.
   */
  private noteLocalPollFailure(serial: string, reason: string): void {
    const failures = (this.localPollFailures.get(serial) || 0) + 1;
    this.localPollFailures.set(serial, failures);
    this.log.debug(`Local poll failed for ${serial} (${failures} in a row): ${reason}`);
    if (failures !== LOCAL_POLL_WARN_AFTER) {
      return; // latched: exactly one warning per outage
    }
    const ip = this.localClient?.getIp(serial);
    this.log.warn(
      `Local status for ${serial}${ip ? ` at ${ip}` : ''} has failed ${failures} polls in a row `
      + `(last reason: ${reason}). Its HomeKit tile is showing stale data. Check that the unit is `
      + 'powered and at that address (a DHCP reservation avoids a moved lease), and that its '
      + 'password and cryptoSerial belong to THIS unit.',
    );
  }

  /** Note a local poll that worked, and report recovery if we had warned. */
  private noteLocalPollSuccess(serial: string): void {
    const failures = this.localPollFailures.get(serial) || 0;
    if (failures >= LOCAL_POLL_WARN_AFTER) {
      this.log.info(`Local status for ${serial} recovered after ${failures} failed poll(s)`);
    }
    if (failures > 0) {
      this.localPollFailures.set(serial, 0);
    }
  }

  private startSitePoller(siteId: string) {
    // The LAN-only modes have no site: LOCAL_ONLY_SITE_ID is a stand-in, and polling
    // it would GET /sites/local-only/zones. Unreachable today (nothing starts the
    // streaming health checks that lead here), but it is one call away, and the
    // whole promise of these modes is that no such request is ever made. Keyed on
    // v3Unavailable, so `cloudRegion: 'ca'` is covered too — that is the case where
    // a real site id exists and a poll would look plausible.
    if (this.v3Unavailable) {
      return;
    }

    // Don't start if already polling
    if (this.sitePollers.has(siteId)) {
      return;
    }

    // If streaming is healthy and polling is disabled, don't start
    if (this.isStreamingHealthy && this.kumoConfig.disablePolling) {
      this.log.info(`Skipping poller for site ${siteId} (streaming healthy, polling disabled)`);
      return;
    }

    const interval = this.isDegradedMode ? this.degradedPollInterval : (this.kumoConfig.pollInterval || 30) * 1000;
    const intervalSec = interval / 1000;
    const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';

    this.log.info(`Starting ${mode} poller for site ${siteId}: ${intervalSec}s intervals`);

    // Group accessories by site for efficient distribution
    const accessories = this.accessoryHandlers.filter(
      handler => handler.getSiteId() === siteId
    );
    this.siteAccessories.set(siteId, accessories);

    // Do immediate poll
    this.pollSite(siteId);

    // Then poll at regular intervals
    const timer = setInterval(() => {
      this.pollSite(siteId);
    }, interval);

    this.sitePollers.set(siteId, timer);
  }

  private async pollSite(siteId: string) {
    if (this.v3Unavailable) {
      return; // see startSitePoller
    }
    try {
      const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';
      const health = this.isStreamingHealthy ? 'healthy' : 'unhealthy';
      this.log.debug(`[${mode}] Polling site ${siteId} (streaming: ${health})`);

      // Fetch all zones for this site
      const zones = await this.kumoAPI.getZones(siteId);

      // A failed fetch returns no zones at all, already logged by getZones. Saying
      // so once beats one "Zone not found" warning per device: degraded polling runs
      // every 10s, and the outage that put us in degraded mode is exactly when every
      // poll comes back empty.
      if (zones.length === 0) {
        this.log.debug(`No zones returned for site ${siteId}`);
        return;
      }

      // Distribute zone data to each accessory
      const accessories = this.siteAccessories.get(siteId) || [];
      for (const handler of accessories) {
        const zone = zones.find(z => z.adapter.deviceSerial === handler.getDeviceSerial());
        if (zone) {
          handler.updateFromZone(zone);
        } else {
          this.log.warn(`Zone not found for device: ${handler.getDeviceSerial()}`);
        }
      }
    } catch (error) {
      this.log.error(`Error polling site ${siteId}:`, error);
    }
  }

  /**
   * Handle streaming health state changes with hysteresis
   *
   * Hysteresis prevents rapid mode switching on flaky connections:
   * - Entering degraded mode: IMMEDIATE (we need polling fallback right away)
   * - Exiting degraded mode: DELAYED (wait for stable connection before stopping polling)
   */
  private handleStreamingHealthChange(isHealthy: boolean): void {
    const wasHealthy = this.isStreamingHealthy;
    this.isStreamingHealthy = isHealthy;

    // If streaming is unhealthy, switch to degraded mode IMMEDIATELY
    // (No hysteresis - we need polling fallback right away)
    //
    // Deliberately not gated on `wasHealthy`: a socket that never connected in the
    // first place has never been healthy, so requiring a healthy->unhealthy edge
    // meant the one case with no updates at all could not reach the fallback.
    // enterDegradedMode is idempotent.
    if (!isHealthy) {
      // Cancel any pending mode change (e.g., pending exit from degraded mode)
      if (this.pendingModeChange) {
        clearTimeout(this.pendingModeChange);
        this.pendingModeChange = null;
        this.pendingModeHealthy = null;
        this.log.debug('Cancelled pending mode change due to new disconnect');
      }

      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log.warn('⚠ STREAMING INTERRUPTED');
      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.enterDegradedMode();
    }

    // If streaming became healthy, schedule exit from degraded mode WITH HYSTERESIS
    // (Wait for stable connection before stopping polling fallback)
    if (!wasHealthy && isHealthy) {
      // If already pending the same mode change, do nothing
      if (this.pendingModeHealthy === true) {
        this.log.debug('Mode change to healthy already pending, waiting for stability...');
        return;
      }

      // Cancel any conflicting pending mode change
      if (this.pendingModeChange) {
        clearTimeout(this.pendingModeChange);
      }

      this.pendingModeHealthy = true;
      const hysteresisSec = this.modeChangeHysteresisMs / 1000;
      this.log.info(`Streaming reconnected - waiting ${hysteresisSec}s for stable connection...`);

      this.pendingModeChange = setTimeout(() => {
        this.pendingModeChange = null;
        this.pendingModeHealthy = null;

        // Double-check health is still good before switching
        if (this.isStreamingHealthy) {
          this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.log.info('✓ STREAMING RESUMED (stable)');
          this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.exitDegradedMode();
        } else {
          this.log.warn('Streaming became unhealthy during stability check, staying in degraded mode');
        }
      }, this.modeChangeHysteresisMs);
    }
  }

  /**
   * Enter degraded mode - start/speed up polling
   */
  private enterDegradedMode(): void {
    if (this.isDegradedMode) {
      return; // Already in degraded mode
    }

    this.isDegradedMode = true;

    const intervalSec = this.degradedPollInterval / 1000;
    this.log.warn(`→ Switching to DEGRADED MODE`);
    this.log.warn(`→ Polling activated: ${intervalSec}s intervals`);
    this.log.warn(`→ Updates will continue via API polling`);

    // If polling is disabled, temporarily enable it
    if (this.kumoConfig.disablePolling) {
      this.log.warn('→ Overriding disablePolling setting for fallback');
    }

    // Start (or speed up) a poller for every site. Under `disablePolling: true` none
    // exist yet, so this is the only place they are ever created.
    this.restartAllPollers(this.degradedPollInterval);
  }

  /**
   * Exit degraded mode - stop or slow down polling
   */
  private exitDegradedMode(): void {
    if (!this.isDegradedMode) {
      return; // Not in degraded mode
    }

    this.isDegradedMode = false;

    // If polling was disabled in config, stop all pollers
    if (this.kumoConfig.disablePolling) {
      this.log.info('→ Returning to NORMAL MODE');
      this.log.info('→ Polling halted (streaming active)');
      this.log.info('→ Updates resume via real-time streaming');
      this.stopAllPollers();
    } else {
      // Otherwise restart with normal interval
      const normalInterval = (this.kumoConfig.pollInterval || 30) * 1000;
      const normalSec = normalInterval / 1000;
      this.log.info('→ Returning to NORMAL MODE');
      this.log.info(`→ Polling reduced to ${normalSec}s intervals`);
      this.log.info('→ Primary updates via streaming');
      this.restartAllPollers(normalInterval);
    }
  }

  /** Every site that has at least one accessory. */
  private siteIds(): string[] {
    return [...new Set(this.accessoryHandlers.map(handler => handler.getSiteId()).filter(Boolean))];
  }

  /**
   * Bring every site's poller up at `intervalMs`, starting the ones that do not
   * exist yet.
   *
   * Starting the missing ones is what makes the degraded-mode fallback real. Under
   * the recommended `disablePolling: true`, discovery never calls startSitePoller,
   * so this map is empty when streaming fails: a "restart all" restarted nothing
   * while logging "0 site poller(s) active", and the fallback polled nothing at all.
   */
  private restartAllPollers(intervalMs: number): void {
    const intervalSec = intervalMs / 1000;

    for (const siteId of this.siteIds()) {
      const timer = this.sitePollers.get(siteId);

      // startSitePoller derives its interval from isDegradedMode, which both callers
      // set before calling us, so a site started here comes up at intervalMs too. It
      // also does its own immediate poll and groups the site's accessories.
      if (!timer) {
        this.startSitePoller(siteId);
        continue;
      }

      clearInterval(timer);

      // Do immediate poll
      this.pollSite(siteId);

      // Start new interval
      const newTimer = setInterval(() => {
        this.pollSite(siteId);
      }, intervalMs);

      this.sitePollers.set(siteId, newTimer);
      this.log.debug(`Poller restarted for site ${siteId}: ${intervalSec}s interval`);
    }

    const siteCount = this.sitePollers.size;
    this.log.info(`✓ ${siteCount} site poller(s) active at ${intervalSec}s intervals`);
  }

  /**
   * Stop all site pollers
   */
  private stopAllPollers(): void {
    for (const [siteId, timer] of this.sitePollers) {
      clearInterval(timer);
      this.log.debug(`Poller stopped for site ${siteId}`);
    }
    this.sitePollers.clear();
    this.log.info('✓ All polling halted');
  }
}
