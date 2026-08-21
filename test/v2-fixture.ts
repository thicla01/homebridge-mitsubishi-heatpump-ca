// An anonymized v2 login reply, shaped like the one mapped live on 2026-08-18.
//
// EVERY value here is invented. The point of the file is the SHAPE — a 5-element
// root array whose third element is a site tree, units keyed by serial under
// `children[0].zoneTable`, snake_case profile and condition blocks — plus the four
// awkward cases a real account produces: a unit with no LAN address (must be found
// by the sweep), a unit whose `reportedCondition` is empty, a Kumo Station
// (`unitType: headless`, not a thermostat), and a unit whose secrets are missing.
//
// The obviously-fake strings in SENTINELS are load-bearing: v2-log-redaction.test.ts
// asserts first that they really are present in the payload, then that not one of
// them reaches any log line at any level. A renamed field would otherwise make that
// test pass by testing nothing.

/** Values that must never appear in a log, a cache file, or an accessory context. */
export const SENTINELS = {
  /** root[0].token — a session token. Never read by the parser. */
  token: 'SENTINELTOKEN00000000000000000000',
  /** The local adapter password of the first unit (base64 alphabet, 40 chars). */
  passwordA: 'SENTINELPASSWORDAAAAAAAAAAAAAAAAAAAAAA==',
  /** ...and of the second. */
  passwordB: 'SENTINELPASSWORDBBBBBBBBBBBBBBBBBBBBBB==',
  /** cryptoSerials: hex, exactly 9 bytes, which is the floor with no margin. */
  cryptoSerialA: 'dec0de0123456789ab',
  cryptoSerialB: 'dec0de9876543210cd',
  /** root[4].userDetails — personal data the parser deliberately never reads. */
  email: 'sentinel.person@example.invalid',
  phone: '555-0100',
  firstName: 'Sentinelle',
  lastName: 'Personne',
  /** root[4].siteDetails — a postal address, likewise never read. */
  street: '1 Sentinel Street',
  /** A vendor id with no use here. */
  salesforceSiteId: 'sentinel-site-uuid-0000',
};

export const SERIAL_A = '1234A0011100011A';
export const SERIAL_B = '1234A0011100022B';
/** A Kumo Station: in the same zoneTable, not an indoor unit. */
export const SERIAL_STATION = '1234A0011100033C';
/** A unit whose secrets did not come back. */
export const SERIAL_NO_SECRETS = '1234A0011100044D';

/** The LAN address the second unit's tree happens to carry. The first has none. */
export const ADDRESS_B = '192.168.9.42';

/**
 * A cryptoSerial the token algorithm cannot use: 4 bytes where the floor is 9.
 *
 * Its own constant because it is asserted about — a problem line must NAME the unit
 * and never quote the value, even a useless one.
 */
export const TRUNCATED_CRYPTO_SERIAL = 'dec0de01';

/**
 * The unit that exercises everything: extended temperature range (a 10 °C heating
 * floor against a 16 °C cooling floor — the whole reason the mapping is per-mode),
 * every capability, and a populated `reportedCondition` in dry mode.
 */
function zoneA(): Record<string, unknown> {
  return {
    serial: SERIAL_A,
    mac: '8c:8b:5b:00:11:22',
    label: 'Salon',
    port: 80,
    unitType: 'ductless',
    lastUpdate: 1786000000000,
    password: SENTINELS.passwordA,
    cryptoSerial: SENTINELS.cryptoSerialA,
    cryptoKeySet: 'F',
    timezone: 'America/Toronto',
    firmwareVersion: '00.00.00',
    autoModeEnabled: true,
    roomTempOffset: 0,
    minCoolSetpoint: 16,
    maxHeatSetpoint: 31,
    autoDryModeCapable: 2,
    forceCloudUpdates: true,
    ledDisabled: false,
    systemChangeoverEnabled: false,
    optimalStart: false,
    _isRespondingLocally: null,
    _requestRescan: 3,
    success: 0,
    rssi: {},
    desiredConditionStack: [
      {
        power: 1,
        operation_mode: 2,
        sent: 1786000000001,
        cloudCommandId: 'sentinel-command-id',
        more: { operation_mode_text: 'Dehumidify', power_on: true },
      },
    ],
    reportedCondition: {
      _created: 1786000000002,
      id: 'condition-a',
      record_time: '2026-08-17T16:37:05.000Z',
      device_serial: SERIAL_A,
      it_status: null,
      rssi: -37,
      power: 1,
      operation_mode: 2,
      set_temp: null,
      set_temp_a: null,
      fan_speed: 0,
      air_direction: 0,
      prohibit_local_remote_control: null,
      room_temp: 21.5,
      room_temp_beyond: null,
      room_temp_a: null,
      out_of_use: null,
      unusual_figures: 32768,
      two_figures_code: 'A0',
      actual_fan_speed: null,
      sp_cool: 22,
      sp_heat: 20.5,
      sp_auto: null,
      raw_frames: null,
      run_test: 0,
      active_thermistor: null,
      temp_source: null,
      seconds_since_contact: 24,
      lastAdapterUpdated: '2026-08-17T16:37:05.000Z',
      more: {
        operation_mode_text: 'Dehumidify',
        fan_speed_text: 'Auto',
        air_direction_text: 'Auto',
        power_on: true,
      },
      status_display: { filter: false, defrost: false, hot_adjust: false, standby: false },
    },
    reportedProfile: {
      fan_speed_stages: 5,
      has_air_direction: true,
      has_auto_fan_speed: true,
      has_dry_function: true,
      has_extended_temp_range: true,
      has_heat_function: true,
      has_swing_direction: true,
      has_test_run: false,
      has_unit_function_setting: false,
      has_ventilation_function: true,
      display_setting_temp_of_dry: true,
      maximum_auto_temp: 31,
      maximum_cool_or_dry_temp: 31,
      maximum_heat_temp: 31,
      minimum_auto_temp: 16,
      minimum_cool_or_dry_temp: 16,
      minimum_heat_temp: 10,
    },
    overrideSettings: { heatMode: true, dryMode: true },
    mhk2Settings: {
      status: { outdoorTemp: 0, outdoorHumid: null, indoorHumid: 41 },
      connected: { thermostat: false, outdoorAir: false, indoorAir: false },
    },
    kumoSensorSettings: { _uuid: 0, _humidity: 0 },
    autoDrySettings: { isAutoDry: false, enable: false, targetHumid: 35 },
    prohibits: {
      global: { power: false, mode: false, setpoint: false },
      local: { power: false, mode: false, setpoint: false },
      effective: { power: false, mode: false, setpoint: false },
    },
  };
}

/**
 * A cooling-only unit that HAS an `address` (so the sweep can be skipped for it),
 * different setpoint floors, and the empty `reportedCondition` every unit shows in
 * both pykumo sample accounts — `{_created, more: {}}` and nothing else.
 */
function zoneB(): Record<string, unknown> {
  return {
    serial: SERIAL_B,
    mac: '8c:8b:5b:00:33:44',
    label: 'Chambre',
    port: 80,
    unitType: 'ductless',
    address: ADDRESS_B,
    password: SENTINELS.passwordB,
    cryptoSerial: SENTINELS.cryptoSerialB,
    autoModeEnabled: false,
    minCoolSetpoint: 15.5,
    maxHeatSetpoint: 30.5,
    reportedCondition: { _created: 1786000000003, more: {} },
    reportedProfile: {
      fan_speed_stages: 3,
      has_air_direction: false,
      has_auto_fan_speed: false,
      has_dry_function: false,
      has_extended_temp_range: true,
      has_heat_function: false,
      has_swing_direction: false,
      has_ventilation_function: false,
      display_setting_temp_of_dry: false,
      maximum_auto_temp: 30,
      maximum_cool_or_dry_temp: 30,
      maximum_heat_temp: 30,
      minimum_auto_temp: 15,
      minimum_cool_or_dry_temp: 15,
      minimum_heat_temp: 9,
    },
    overrideSettings: {},
    mhk2Settings: { status: { indoorHumid: null } },
  };
}

/** A Kumo Station. Sits in the zoneTable and is not a thermostat. */
function station(): Record<string, unknown> {
  return {
    serial: SERIAL_STATION,
    label: 'Kumo Station',
    unitType: 'headless',
    port: 80,
    password: 'SENTINELSTATIONPASSWORD0000000000000000=',
    cryptoSerial: 'dec0de5555555555ef',
  };
}

/** A unit whose secrets did not come back — the shape HA 0.5.2 normalizes to ''. */
function incomplete(): Record<string, unknown> {
  return {
    serial: SERIAL_NO_SECRETS,
    label: 'Bureau',
    unitType: 'ductless',
    port: 80,
    password: '',
    cryptoSerial: '',
    reportedProfile: { minimum_heat_temp: 10, maximum_heat_temp: 31 },
  };
}

/**
 * The whole reply. `zones: false` gives the same tree with an EMPTY zoneTable at
 * the site level, which is the "account served but nothing reported" case.
 *
 * `badCryptoSerial` is the HALF-credentialed variant, and a different failure from
 * `noSecrets`: the password is perfectly good and only the cryptoSerial is unusable.
 * It is what exercises the second branch of the shared secret rule (settings.ts,
 * localSecretProblem) — the fixture's `noSecrets` unit has BOTH values empty and the
 * rule tests the password first, so on its own it can never reach that branch. The
 * distinction matters because admitting such a unit does not degrade: the token
 * algorithm validates the 9-byte floor and THROWS outside the local client's
 * try/catch, so every poll and every command for it fails.
 *
 * `noSecrets` blanks the two secrets of units that are otherwise entirely present
 * in the tree — the provider-side failure this whole feature works around, as a v2
 * reply expresses it. The v3 cloud stopped serving both secrets on 2026-07-31
 * (pykumo #78), and mitsubishi-comfort normalizes a missing one to `''`; a v2 store
 * can go the same way for one unit while the rest of the account is fine. It is a
 * DEGRADED reply, not a shorter one: the unit is still listed, still named, still
 * profiled.
 */
export function makeV2Reply(
  opts: { zones?: boolean; noSecrets?: string[]; badCryptoSerial?: string[] } = {},
): unknown[] {
  const zoneTable: Record<string, unknown> = opts.zones === false ? {} : {
    [SERIAL_A]: zoneA(),
    [SERIAL_B]: zoneB(),
    [SERIAL_STATION]: station(),
    [SERIAL_NO_SECRETS]: incomplete(),
  };
  for (const serial of opts.noSecrets ?? []) {
    const zone = zoneTable[serial] as Record<string, unknown> | undefined;
    if (!zone) {
      throw new Error(`noSecrets names ${serial}, which is not in the fixture`);
    }
    zone.password = '';
    zone.cryptoSerial = '';
  }
  for (const serial of opts.badCryptoSerial ?? []) {
    const zone = zoneTable[serial] as Record<string, unknown> | undefined;
    if (!zone) {
      throw new Error(`badCryptoSerial names ${serial}, which is not in the fixture`);
    }
    zone.cryptoSerial = TRUNCATED_CRYPTO_SERIAL;
  }
  return [
    {
      token: SENTINELS.token,
      username: SENTINELS.email,
      device: null,
      emailIsVerified: true,
    },
    { lastUpdate: 1786000000000, celsius: true, filterReminder: true },
    {
      id: '1785368433584-0000000',
      label: 'kumo cloud',
      level: 1,
      lastScheduleChange: 0,
      lastUpdate: 1786000000000,
      'v1.2+': 1,
      version: 89,
      // Empty at the account level in the live capture: the units live one level
      // down, which is why the walk cannot assume a fixed depth.
      zoneTable: {},
      children: [
        {
          id: '1785368544695-0000000',
          label: 'Rue Fictive',
          level: 2,
          lastScheduleChange: 0,
          lastUpdate: 1786000000000,
          'v1.2+': 1,
          salesforceSiteId: SENTINELS.salesforceSiteId,
          children: [],
          zoneTable,
        },
      ],
    },
    'no device token',
    {
      userDetails: {
        id: 'sentinel-user',
        firstName: SENTINELS.firstName,
        lastName: SENTINELS.lastName,
        phone: SENTINELS.phone,
        email: SENTINELS.email,
        IsPersonAccount: true,
      },
      siteDetails: [
        {
          'sentinel-site': {
            address: SENTINELS.street,
            address2: '',
            city: 'Ville Fictive',
            state: 'QC',
            zip: 'H0H 0H0',
            country: 'CA',
            contractor: 'Sentinel HVAC',
          },
        },
      ],
    },
  ];
}

/** Every sentinel value, for the "no secret is logged" assertions. */
export function sentinelValues(): string[] {
  return Object.values(SENTINELS);
}
