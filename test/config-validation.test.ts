// Regression tests for the config gate in the platform constructor.
//
// Until 2.1.0 each of these four cases threw. Homebridge does not guard a platform
// constructor, so the throw rejected `Server.start()` and the CLI answered by SIGTERMing
// the process: a missing password took down every other plugin in the install, before the
// bridge published, and the supervisor restarted into the same throw. Verified against
// homebridge 2.2.1 — a second, unrelated platform plugin never had its constructor called.
//
// What these tests pin is therefore not the message but the shape: the constructor
// returns, and it does NOT subscribe to didFinishLaunching, which is what would start it.

import test from 'node:test';
import assert from 'node:assert';
import type { PlatformConfig } from 'homebridge';

import { KumoV3Platform, validatePlatformConfig, reconcileImpliedConfig } from '../dist/platform.js';
import type { KumoConfig } from '../dist/settings.js';
import { makeLog } from './helpers';

const VALID: PlatformConfig = {
  name: 'test',
  platform: 'KumoV3',
  username: 'user@example.com',
  password: 'secret',
};

/** Records the lifecycle events the platform subscribes to. */
function makeApi() {
  const events: string[] = [];
  const api = {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s: string) => `uuid-${s}` } },
    on: (event: string) => events.push(event),
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
  return { api, events };
}

const BAD_CONFIGS: Array<[string, Partial<KumoConfig>, string]> = [
  ['no credentials at all', { username: undefined, password: undefined }, 'Username and password'],
  ['username present, password missing', { password: undefined }, 'Username and password'],
  ['username is not an email', { username: 'notanemail' }, 'valid email'],
  ['password is whitespace', { password: '   ' }, 'non-empty'],
  ['pollInterval below the floor', { pollInterval: 1 }, 'Poll interval'],
  ['pollInterval hand-edited to a string', { pollInterval: '30' as never }, 'Poll interval'],
  // The two axes added for the v2 bootstrap. A typo must NOT fall back to a default:
  // `cloudRegion: "can"` silently meaning "us" would point a Canadian account at the
  // v3 endpoint that answers it HTTP 500 forever, with nothing in the log to say why.
  ['a misspelled region', { cloudRegion: 'can' as never }, 'cloudRegion must be'],
  ['a region hand-edited to a boolean', { cloudRegion: true as never }, 'cloudRegion must be'],
  ['a misspelled credential source', { localCredentialSource: 'v1' as never }, 'localCredentialSource must be'],
  // The one contradiction with no single right answer: the user either wants no
  // cloud, or wants the secrets fetched, and guessing wrong either exposes
  // credentials or silently controls nothing.
  [
    'local-only asked to sign in to the v2 cloud anyway',
    { localOnly: true, localCredentialSource: 'v2' as never },
    'localOnly forbids any cloud contact',
  ],
];

/**
 * Contradictions that must NOT stop the platform, because they have exactly one
 * possible resolution — and because the Homebridge UI manufactures them.
 *
 * Saving the plugin's settings form materialises every schema `default` into
 * config.json. On 2026-08-19 that turned a working Canadian install idle: merely
 * opening the settings page and pressing Save wrote `localCredentialSource: "v3"`,
 * which the validator then read as a deliberate choice contradicting
 * `cloudRegion: "ca"`. The user had chosen nothing. Schema defaults were removed
 * for the fields whose absence is meaningful, but the runtime must absorb this
 * regardless: the UI is free to write whatever it likes.
 */
const RECONCILED: Array<[string, Partial<KumoConfig>, string, 'v2' | 'v3']> = [
  [
    'region ca handed the v3 source the UI writes by default',
    { cloudRegion: 'ca' as never, localCredentialSource: 'v3' as never },
    'localCredentialSource "v3" was ignored',
    'v2',
  ],
  [
    'region ca handed the localControl false the UI writes by default',
    { cloudRegion: 'ca' as never, localControl: false },
    'localControl "false" was ignored',
    'v2',
  ],
  [
    'an explicit v2 source handed the localControl false the UI writes by default',
    { localCredentialSource: 'v2' as never, localControl: false },
    'localControl "false" was ignored',
    'v2',
  ],
];

for (const [label, overrides, expectedNote, expectedSource] of RECONCILED) {
  test(`reconcileImpliedConfig absorbs, and says so: ${label}`, () => {
    const config = { ...VALID, ...overrides } as unknown as KumoConfig;
    const notes = reconcileImpliedConfig(config);

    assert.strictEqual(notes.length, 1, 'exactly one note, naming the value it ignored');
    assert.match(notes[0], new RegExp(expectedNote.replace(/["]/g, '"'), 'i'));
    assert.match(notes[0], /Homebridge UI writes that value on its own/,
      'and explains where it came from, so the user does not hunt their own config');

    assert.strictEqual(
      validatePlatformConfig(config), null,
      'the contradiction is gone by the time the validator runs',
    );
  });

  test(`the platform STARTS despite: ${label}`, () => {
    const { api, events } = makeApi();
    const platform = new KumoV3Platform(
      makeLog() as never,
      { ...VALID, ...overrides } as PlatformConfig,
      api as never,
    );

    assert.deepStrictEqual(
      events, ['didFinishLaunching', 'shutdown'],
      'going idle here is what cost a working install its heat pump',
    );
    assert.strictEqual(platform.localCredentialSource, expectedSource);
    // Dropping the contradicting `localControl: false` loses nothing: LAN control is
    // gated on `localControl || localCredentialSource === 'v2'` (platform.ts), and the
    // v2 source — implied by "ca", or explicit — satisfies the second half on its own.
    assert.strictEqual(platform.kumoConfig.localControl, undefined,
      'the contradicting value is gone, not merely overridden');
  });
}

test('a contradiction the user really typed is left alone', () => {
  // The absorbing above must not become a blanket "fix the config for them". Only
  // a value the UI is known to manufacture out of a default is absorbed, and only
  // toward the one resolution that exists.
  const config = { ...VALID, localOnly: true, localCredentialSource: 'v2' } as unknown as KumoConfig;
  assert.deepStrictEqual(reconcileImpliedConfig(config), [], 'nothing absorbed');
  assert.strictEqual(config.localCredentialSource, 'v2', 'and nothing deleted');
  assert.ok(validatePlatformConfig(config), 'so it is still fatal');
});

for (const [label, overrides, expected] of BAD_CONFIGS) {
  test(`validatePlatformConfig rejects: ${label}`, () => {
    const reason = validatePlatformConfig({ ...VALID, ...overrides } as unknown as KumoConfig);
    assert.ok(reason, 'a reason is returned');
    assert.match(reason, new RegExp(expected, 'i'));
  });

  test(`constructor stays inert instead of throwing: ${label}`, () => {
    const { api, events } = makeApi();
    const config = { ...VALID, ...overrides } as PlatformConfig;

    let platform: KumoV3Platform | undefined;
    assert.doesNotThrow(() => {
      platform = new KumoV3Platform(makeLog() as never, config, api as never);
    }, 'a throw here SIGTERMs the whole Homebridge process');

    assert.ok(platform, 'construction completed');
    assert.deepStrictEqual(events, [], 'no lifecycle hooks: the platform never starts');
  });
}

test('validatePlatformConfig accepts a minimal valid config', () => {
  assert.strictEqual(validatePlatformConfig(VALID as unknown as KumoConfig), null);
});

test('pollInterval is optional, and the floor of 5 is inclusive', () => {
  assert.strictEqual(validatePlatformConfig({ ...VALID, pollInterval: 5 } as unknown as KumoConfig), null);
  assert.ok(validatePlatformConfig({ ...VALID, pollInterval: 4.9 } as unknown as KumoConfig));
});

test('a valid config still subscribes to both lifecycle events', () => {
  const { api, events } = makeApi();
  const platform = new KumoV3Platform(makeLog() as never, VALID, api as never);
  assert.ok(platform);
  assert.deepStrictEqual(events, ['didFinishLaunching', 'shutdown']);
});

// ---- local-only mode -----------------------------------------------------
//
// `localOnly: true` never signs in, so it deliberately does NOT require cloud
// credentials — which means the credential check can no longer be the one gate at
// the top of the function. Every unit is instead declared in full, and the two
// per-device secrets are the values a user hand-copies from another source, so
// each is checked here rather than failing later as an opaque adapter
// authentication error.

const DEVICE = {
  deviceSerial: '1234A5678901234B',
  name: 'Salon',
  ip: '192.168.6.11',
  password: 'cGFzc3dvcmQ=',
  // 10 bytes: the floor is 9. The token algorithm itself is local-api.test.ts's job.
  cryptoSerial: '0123456789abcdef0123',
};

/** The objective config from the field report: local-only, no credentials at all. */
const LOCAL_VALID = {
  name: 'test',
  platform: 'KumoV3',
  localOnly: true,
  localDevices: [DEVICE],
  localPollInterval: 15,
} as unknown as KumoConfig;

const BAD_LOCAL_CONFIGS: Array<[string, Partial<KumoConfig>, string]> = [
  ['localDevices missing entirely', { localDevices: undefined }, 'non-empty localDevices'],
  ['localDevices empty', { localDevices: [] }, 'non-empty localDevices'],
  ['localDevices hand-edited to a string', { localDevices: 'nope' as never }, 'non-empty localDevices'],
  ['a null entry', { localDevices: [null as never] }, 'requires a deviceSerial'],
  ['no deviceSerial', { localDevices: [{ ...DEVICE, deviceSerial: undefined as never }] }, 'requires a deviceSerial'],
  ['a blank deviceSerial', { localDevices: [{ ...DEVICE, deviceSerial: '  ' }] }, 'requires a deviceSerial'],
  ['the same unit twice', { localDevices: [DEVICE, DEVICE] }, 'more than once'],
  ['no ip', { localDevices: [{ ...DEVICE, ip: undefined as never }] }, 'requires an ip'],
  ['a blank ip', { localDevices: [{ ...DEVICE, ip: '' }] }, 'requires an ip'],
  ['no password', { localDevices: [{ ...DEVICE, password: undefined as never }] }, 'requires a password'],
  ['a blank password', { localDevices: [{ ...DEVICE, password: '   ' }] }, 'requires a password'],
  ['no cryptoSerial', { localDevices: [{ ...DEVICE, cryptoSerial: undefined as never }] }, 'cryptoSerial'],
  // 8 bytes, one short of the floor.
  ['a cryptoSerial one byte short', { localDevices: [{ ...DEVICE, cryptoSerial: '0123456789abcdef' }] }, 'cryptoSerial'],
  ['a cryptoSerial that is not hex', { localDevices: [{ ...DEVICE, cryptoSerial: 'not-a-hex-serial!!' }] }, 'cryptoSerial'],
  // Buffer.from(x, 'hex') stops at the first non-hex pair, so this one decodes to a
  // passing 9 bytes and used to slip through — then failed every local request.
  ['a cryptoSerial with trailing junk', { localDevices: [{ ...DEVICE, cryptoSerial: '0123456789abcdef0123zz' }] }, 'cryptoSerial'],
  ['an odd number of hex digits', { localDevices: [{ ...DEVICE, cryptoSerial: '0123456789abcdef012' }] }, 'cryptoSerial'],
  ['localPollInterval below the floor', { localPollInterval: 0 }, 'Local poll interval'],
  // localOnly promises no cloud contact of any version, so a v2 sign-in cannot be
  // part of it. The message has to name both ways out, since a user reaching for the
  // v2 source is trying to STOP hand-declaring secrets.
  [
    'a v2 sign-in asked for inside local-only mode',
    { localCredentialSource: 'v2' as never },
    'localOnly forbids any cloud contact',
  ],
];

for (const [label, overrides, expected] of BAD_LOCAL_CONFIGS) {
  test(`validatePlatformConfig rejects in local-only mode: ${label}`, () => {
    const reason = validatePlatformConfig({ ...LOCAL_VALID, ...overrides } as unknown as KumoConfig);
    assert.ok(reason, 'a reason is returned');
    assert.match(reason, new RegExp(expected, 'i'));
  });

  test(`constructor stays inert in local-only mode: ${label}`, () => {
    const { api, events } = makeApi();
    const config = { ...LOCAL_VALID, ...overrides } as unknown as PlatformConfig;

    let platform: KumoV3Platform | undefined;
    assert.doesNotThrow(() => {
      platform = new KumoV3Platform(makeLog() as never, config, api as never);
    }, 'a throw here SIGTERMs the whole Homebridge process');

    assert.ok(platform, 'construction completed');
    assert.deepStrictEqual(events, [], 'no lifecycle hooks: the platform never starts');
  });
}

test('a local-only config is accepted with no username or password at all', () => {
  assert.strictEqual(LOCAL_VALID.username, undefined, 'the objective config really has none');
  assert.strictEqual(LOCAL_VALID.password, undefined);
  assert.strictEqual(validatePlatformConfig(LOCAL_VALID), null);
});

test('a local-only config starts the platform', () => {
  const { api, events } = makeApi();
  const platform = new KumoV3Platform(makeLog() as never, LOCAL_VALID as unknown as PlatformConfig, api as never);
  assert.ok(platform);
  assert.deepStrictEqual(events, ['didFinishLaunching', 'shutdown']);
});

test('credentials are still required when localOnly is absent or false', () => {
  // The exemption must be tied to the mode, not leak into the cloud path.
  const noCreds = { name: 'test', platform: 'KumoV3', localDevices: [DEVICE] };
  assert.match(
    validatePlatformConfig(noCreds as unknown as KumoConfig) ?? '',
    /Username and password are required/,
    'declaring localDevices without localOnly does not exempt anything',
  );
  assert.match(
    validatePlatformConfig({ ...noCreds, localOnly: false } as unknown as KumoConfig) ?? '',
    /Username and password are required/,
  );
});

test('the shared checks still run in local-only mode', () => {
  // pollInterval sits outside the mode branch and must not be skipped by it.
  assert.match(
    validatePlatformConfig({ ...LOCAL_VALID, pollInterval: 1 } as unknown as KumoConfig) ?? '',
    /Poll interval/,
  );
});

// ---- the v2 bootstrap: region and credential source ----------------------

const CA_VALID = {
  name: 'test',
  platform: 'KumoV3',
  username: 'user@example.com',
  password: 'secret',
  cloudRegion: 'ca',
} as unknown as KumoConfig;

test('the Canadian config is accepted with nothing but a region', () => {
  // The whole point of the feature: no localDevices, no hand-copied secrets, and the
  // credentials ARE required here (unlike local-only) because the v2 sign-in needs them.
  assert.strictEqual(validatePlatformConfig(CA_VALID), null);
  assert.strictEqual(CA_VALID.localDevices, undefined);
  assert.match(
    validatePlatformConfig({ ...CA_VALID, username: undefined } as KumoConfig) ?? '',
    /Username and password are required/,
  );
});

test('a US account may take just the secrets from v2', () => {
  assert.strictEqual(
    validatePlatformConfig({ ...VALID, localCredentialSource: 'v2' } as unknown as KumoConfig),
    null,
    'the majority case since 2026-07-31: v3 control works, v3 just serves no secrets',
  );
});

test('the region is case and whitespace tolerant, but not spelling tolerant', () => {
  for (const region of ['CA', ' ca ', 'Ca', 'US', 'us']) {
    assert.strictEqual(
      validatePlatformConfig({ ...VALID, cloudRegion: region } as unknown as KumoConfig),
      null,
      `${region} is accepted`,
    );
  }
  assert.match(
    validatePlatformConfig({ ...VALID, cloudRegion: 'canada' } as unknown as KumoConfig) ?? '',
    /cloudRegion must be/,
  );
});

test('an IMPLIED value never contradicts, only an explicit one does', () => {
  // This is what keeps the matrix consistent: `ca` implies localCredentialSource v2
  // and local control, so neither default may be read as a conflicting choice.
  assert.strictEqual(validatePlatformConfig({ ...CA_VALID, localControl: true } as KumoConfig), null);
  assert.strictEqual(
    validatePlatformConfig({ ...CA_VALID, localCredentialSource: 'v2' } as unknown as KumoConfig),
    null,
    'restating the implication is not a contradiction',
  );
});

test('a Canadian config starts the platform', () => {
  const { api, events } = makeApi();
  const platform = new KumoV3Platform(makeLog() as never, CA_VALID as unknown as PlatformConfig, api as never);
  assert.ok(platform);
  assert.deepStrictEqual(events, ['didFinishLaunching', 'shutdown']);
});

test('an inert option is warned about, not rejected', () => {
  // configWarnings is the other half of the matrix: a setting that cannot misbehave
  // gets a line, because refusing to start over it would be worse than saying so.
  const warned: string[] = [];
  const log = { ...makeLog(), warn: (...args: unknown[]) => warned.push(args.join(' ')) };
  const { api, events } = makeApi();

  new KumoV3Platform(
    log as never,
    { ...LOCAL_VALID, cloudRegion: 'ca' } as unknown as PlatformConfig,
    api as never,
  );

  assert.deepStrictEqual(events, ['didFinishLaunching', 'shutdown'], 'accepted: the platform starts');
  assert.strictEqual(warned.filter((w) => /cloudRegion is ignored/.test(w)).length, 1);
});

test('localDevices without localOnly is warned about, and still does not exempt credentials', () => {
  const warned: string[] = [];
  const log = { ...makeLog(), warn: (...args: unknown[]) => warned.push(args.join(' ')) };
  const { api } = makeApi();

  new KumoV3Platform(log as never, { ...VALID, localDevices: [DEVICE] } as PlatformConfig, api as never);

  assert.strictEqual(warned.filter((w) => /only read in local-only mode/.test(w)).length, 1);
});

test('localOnly hand-edited to a truthy string still selects local-only mode', () => {
  // Pins the current behaviour rather than endorsing it: the check is truthiness, so
  // "yes" from a hand-edited config.json takes the local-only branch — and is then
  // rejected for having no localDevices rather than silently demanding credentials.
  const reason = validatePlatformConfig(
    { name: 'test', platform: 'KumoV3', localOnly: 'yes' } as unknown as KumoConfig,
  );
  assert.match(reason ?? '', /non-empty localDevices/);
});

test('the reason is logged as an error, once, and names the remedy', () => {
  const logged: string[] = [];
  const log = { ...makeLog(), error: (...args: unknown[]) => logged.push(args.join(' ')) };
  const { api } = makeApi();

  new KumoV3Platform(log as never, { ...VALID, password: undefined } as PlatformConfig, api as never);

  assert.strictEqual(logged.length, 1, 'exactly one error line, not a wall of them');
  assert.match(logged[0], /Username and password are required/);
  assert.match(logged[0], /stay idle/);
  assert.match(logged[0], /other plugins are unaffected/);
});
