// The v2 bootstrap module: the tree walk, the two mappers, the endpoint choice, and
// the client's failure classification.
//
// Why a v2 path exists at all is in the header of src/kumo-v2.ts. What this file is
// mostly about is that NONE of it may throw. It runs inside discovery, so a parse
// error on a reply that will not change would put the whole platform into its
// retry loop forever — and the payloads that provoke it are not hypothetical: both
// pykumo sample accounts have an empty `reportedCondition` on every unit, the live
// Canadian tree has an empty `zoneTable` at the account level with the units one
// child deeper, and the root array is 5 elements on mesca against 4 on geo-c.
//
// The fixture is invented end to end (test/v2-fixture.ts) and deliberately carries
// the four awkward cases: no address, empty condition, a Kumo Station, and a unit
// with no secrets.

import test from 'node:test';
import assert from 'node:assert';

import { KumoAPI } from '../dist/kumo-api.js';
import {
  KumoV2Client, V2_APP_VERSION, mapV2Condition, mapV2Profile, parseV2Login, v2Endpoint, v2Mode,
} from '../dist/kumo-v2.js';
import { makeLog } from './helpers';
import {
  ADDRESS_B, SENTINELS, SERIAL_A, SERIAL_B, SERIAL_NO_SECRETS, SERIAL_STATION,
  TRUNCATED_CRYPTO_SERIAL, makeV2Reply,
} from './v2-fixture';

// ---- the tree walk -------------------------------------------------------

test('every unit under children[].zoneTable is found, keyed by serial', () => {
  const { devices, siteCount } = parseV2Login(makeV2Reply());

  assert.deepStrictEqual(
    devices.map((d) => d.deviceSerial),
    [SERIAL_A, SERIAL_B, SERIAL_NO_SECRETS],
    'the Kumo Station is dropped; every indoor unit is kept',
  );
  assert.strictEqual(siteCount, 1, 'only the node that actually carried units counts as a site');

  const salon = devices[0];
  assert.strictEqual(salon.label, 'Salon', 'the room name becomes the HomeKit name');
  assert.strictEqual(salon.unitType, 'ductless');
  assert.strictEqual(salon.mac, '8c:8b:5b:00:11:22');
  assert.strictEqual(salon.port, 80);
  assert.strictEqual(salon.ip, undefined, 'this unit has no address: the LAN sweep must find it');
  assert.strictEqual(devices[1].ip, ADDRESS_B, 'and this one does, so it skips the sweep');
});

test('the secrets come back in a map the local transport can use verbatim', () => {
  const { creds } = parseV2Login(makeV2Reply());

  assert.deepStrictEqual([...creds.keys()], [SERIAL_A, SERIAL_B]);
  assert.deepStrictEqual(creds.get(SERIAL_A), {
    password: SENTINELS.passwordA,
    cryptoSerial: SENTINELS.cryptoSerialA,
  });
});

test('the returned device records structurally cannot carry a secret', () => {
  // The type boundary, checked at runtime as well: a V2Device is what gets logged,
  // cached and stored, so a leak has to be impossible rather than merely avoided.
  const { devices } = parseV2Login(makeV2Reply());
  const serialized = JSON.stringify(devices);
  for (const value of [SENTINELS.passwordA, SENTINELS.passwordB, SENTINELS.cryptoSerialA]) {
    assert.ok(!serialized.includes(value), 'no secret in the device records');
  }
});

test('a unit with no usable secrets is reported by name, never by value', () => {
  const { devices, creds, problems } = parseV2Login(makeV2Reply());

  assert.ok(devices.some((d) => d.deviceSerial === SERIAL_NO_SECRETS), 'still listed');
  assert.strictEqual(creds.has(SERIAL_NO_SECRETS), false, 'but not controllable');

  const named = problems.filter((p) => p.includes(SERIAL_NO_SECRETS));
  assert.strictEqual(named.length, 1);
  assert.match(named[0], /password/, 'and says which value was wrong');
});

test('a unit whose cryptoSerial came back damaged is refused, and named for it', () => {
  // The password branch of the shared rule (settings.ts: localSecretProblem) was the
  // only one any v2 test reached: the fixture's uncredentialed unit has BOTH values
  // empty and the rule tests the password first, so every verdict on this path read
  // 'password'. Replacing the localSecretProblem call in parseV2Login with a bare
  // "is the password non-empty" test therefore left the whole suite green — while
  // admitting a HALF-credentialed unit, which does not degrade: computeLocalToken
  // validates the 9-byte floor and throws OUTSIDE the local client's try/catch
  // (test/local-api.test.ts pins that), so every poll and every command for that unit
  // fails instead of falling back.
  const { devices, creds, problems } = parseV2Login(makeV2Reply({ badCryptoSerial: [SERIAL_A] }));

  assert.ok(devices.some((d) => d.deviceSerial === SERIAL_A),
    'still listed, so its cached accessory is retained');
  assert.strictEqual(creds.has(SERIAL_A), false, 'a good password does not rescue a bad cryptoSerial');
  assert.strictEqual(creds.has(SERIAL_B), true, 'and the rest of the account is untouched');

  const named = problems.filter((p) => p.includes(SERIAL_A));
  assert.strictEqual(named.length, 1);
  assert.match(named[0], /cryptoSerial/, 'the verdict says WHICH value was wrong');
  assert.ok(!named[0].includes(TRUNCATED_CRYPTO_SERIAL), 'named, never quoted');
});

test('the v2 path applies the whole shared secret rule, not just its first branch', () => {
  // Every shape the rule rejects, each reached through parseV2Login rather than by
  // calling localSecretProblem directly — the claim under test is that the v2 walk
  // defers to the shared rule, not that the rule itself works (config-validation
  // covers that for the hand-declared path).
  for (const [label, cryptoSerial] of [
    ['truncated', 'dec0de01'],
    ['not hex', 'not-a-hex-serial!!'],
    ['an odd number of hex digits', 'dec0de0123456789a'],
    ['trailing junk', 'dec0de0123456789abzz'],
    ['absent from the reply', undefined],
    ['not a string at all', 12345],
  ] as Array<[string, unknown]>) {
    const raw = [{}, {}, {
      zoneTable: {
        HALFCRED1: { serial: 'HALFCRED1', label: 'Bureau', password: 'cGFzcw==', cryptoSerial },
      },
    }];
    const { creds, problems } = parseV2Login(raw);
    assert.strictEqual(creds.has('HALFCRED1'), false, `refused: ${label}`);
    assert.match(problems.join(' '), /HALFCRED1: unusable local cryptoSerial/,
      `and reported as a cryptoSerial fault: ${label}`);
  }

  // The control, so the assertions above are about the rule and not about the walk
  // dropping every unit it is handed.
  const good = parseV2Login([{}, {}, {
    zoneTable: {
      HALFCRED1: { serial: 'HALFCRED1', password: 'cGFzcw==', cryptoSerial: 'dec0de0123456789ab' },
    },
  }]);
  assert.strictEqual(good.creds.has('HALFCRED1'), true);
  assert.deepStrictEqual(good.problems.filter((p) => /cryptoSerial/.test(p)), []);
});

test('the Kumo Station is skipped with a reason', () => {
  const { problems } = parseV2Login(makeV2Reply());
  const named = problems.filter((p) => p.includes(SERIAL_STATION));
  assert.strictEqual(named.length, 1);
  assert.match(named[0], /headless/i);
});

test('an account with no zoneTable anywhere yields nothing, and does not throw', () => {
  const raw = [{}, {}, { id: 'acct', label: 'kumo cloud', children: [{ id: 'site', label: 'X' }] }];
  const inventory = parseV2Login(raw);
  assert.deepStrictEqual(inventory.devices, []);
  assert.strictEqual(inventory.creds.size, 0);
  assert.strictEqual(inventory.siteCount, 0);
});

test('an empty zoneTable yields nothing, and does not throw', () => {
  const inventory = parseV2Login(makeV2Reply({ zones: false }));
  assert.deepStrictEqual(inventory.devices, []);
  assert.strictEqual(inventory.siteCount, 0, 'an empty table is not a site with units');
});

test('a malformed root is survivable in every shape', () => {
  // geo-c answers with 4 elements where mesca answers 5, root[3] is a bare string
  // on one of them, and a failed call can leave anything at all here.
  for (const raw of [
    undefined, null, 0, '', 'nope', {}, [], [{}], [{}, {}],
    [{}, {}, null], [{}, {}, 'not a tree'], [{}, {}, []],
    [{}, {}, { zoneTable: 'nope', children: 'nope' }],
    [{}, {}, { zoneTable: { A: 'nope' }, children: ['nope', null, 7] }],
  ]) {
    const inventory = parseV2Login(raw);
    assert.deepStrictEqual(inventory.devices, [], `survived ${JSON.stringify(raw)}`);
  }
});

test('units nested deeper than one child level are still found', () => {
  // pykumo walks exactly two levels; mitsubishi-comfort recurses. A multi-site
  // account (the live capture lists 17 site addresses) is the case that needs it.
  const unit = { serial: 'DEEP0001', label: 'Grenier', password: 'cGFzcw==', cryptoSerial: 'dec0de0123456789ab' };
  const raw = [{}, {}, {
    children: [{ children: [{ children: [{ zoneTable: { DEEP0001: unit } }] }] }],
  }];
  const { devices, creds } = parseV2Login(raw);
  assert.deepStrictEqual(devices.map((d) => d.deviceSerial), ['DEEP0001']);
  assert.strictEqual(creds.size, 1);
});

test('the same unit appearing under two sites is registered once', () => {
  const unit = { serial: SERIAL_A, label: 'Salon', password: 'cGFzcw==', cryptoSerial: 'dec0de0123456789ab' };
  const raw = [{}, {}, {
    children: [{ zoneTable: { [SERIAL_A]: unit } }, { zoneTable: { [SERIAL_A]: unit } }],
  }];
  assert.strictEqual(parseV2Login(raw).devices.length, 1);
});

test('a zone with no serial field falls back to its table key', () => {
  const raw = [{}, {}, {
    zoneTable: { KEYONLY01: { label: 'Cave', password: 'cGFzcw==', cryptoSerial: 'dec0de0123456789ab' } },
  }];
  assert.deepStrictEqual(parseV2Login(raw).devices.map((d) => d.deviceSerial), ['KEYONLY01']);
});

// ---- reportedProfile -> DeviceProfile ------------------------------------

test('the real profile keeps the heating floor separate from the cooling floor', () => {
  // The headline fix. v2 reports three floors and the plugin has three slots, so a
  // unit with the extended temperature range keeps its 10 °C heat floor instead of
  // being flattened to the cool floor of 16 — which is what a single hand-declared
  // minSetPoint has to do, and it costs the whole 50-61 °F band that freeze
  // protection and vacation setback live in.
  const profile = mapV2Profile(zoneOf(SERIAL_A))!;

  assert.deepStrictEqual(profile.minimumSetPoints, { cool: 16, heat: 10, auto: 16 });
  assert.deepStrictEqual(profile.maximumSetPoints, { cool: 31, heat: 31, auto: 31 });
  assert.notStrictEqual(profile.minimumSetPoints.heat, profile.minimumSetPoints.cool,
    'the two floors are genuinely different on this hardware');
});

test('every capability flag is mapped from its snake_case counterpart', () => {
  const profile = mapV2Profile(zoneOf(SERIAL_A))!;
  assert.strictEqual(profile.numberOfFanSpeeds, 5);
  assert.strictEqual(profile.hasFanSpeedAuto, true);
  assert.strictEqual(profile.hasModeDry, true);
  assert.strictEqual(profile.hasModeHeat, true);
  assert.strictEqual(profile.hasModeVent, true);
  assert.strictEqual(profile.hasVaneDir, true);
  assert.strictEqual(profile.hasVaneSwing, true);
  assert.strictEqual(profile.usesSetPointInDryMode, true);
});

test('a cooling-only unit is reported as one, with its own bounds', () => {
  const profile = mapV2Profile(zoneOf(SERIAL_B))!;
  assert.strictEqual(profile.hasModeHeat, false, 'no HEAT and no AUTO in the picker');
  assert.strictEqual(profile.hasModeDry, false);
  assert.strictEqual(profile.hasModeVent, false);
  assert.strictEqual(profile.hasVaneDir, false);
  assert.strictEqual(profile.usesSetPointInDryMode, false);
  assert.deepStrictEqual(profile.minimumSetPoints, { cool: 15, heat: 9, auto: 15 });
  assert.deepStrictEqual(profile.maximumSetPoints, { cool: 30, heat: 30, auto: 30 });
});

test('overrideSettings only takes a mode away on an EXPLICIT false', () => {
  // The AND with overrideSettings mirrors pykumo's userHasModeDry/userHasModeHeat,
  // but the field is `{}` in both sample accounts: treating a missing key as false
  // would strip dry AND heat — and with heat, AUTO — from every unit in them.
  const base = zoneOf(SERIAL_A);
  assert.strictEqual(mapV2Profile({ ...base, overrideSettings: {} })!.hasModeDry, true);
  assert.strictEqual(mapV2Profile({ ...base, overrideSettings: undefined })!.hasModeHeat, true);
  assert.strictEqual(mapV2Profile({ ...base, overrideSettings: { dryMode: false } })!.hasModeDry, false);
  assert.strictEqual(mapV2Profile({ ...base, overrideSettings: { heatMode: false } })!.hasModeHeat, false);
});

test('a unit that has not reported a profile yields undefined, not defaults', () => {
  // So the caller can fall back PER UNIT: a v2 tree can hold a unit with
  // `success: 0` next to four that have reported.
  assert.strictEqual(mapV2Profile({ serial: SERIAL_A }), undefined);
  assert.strictEqual(mapV2Profile({ serial: SERIAL_A, reportedProfile: 'nope' }), undefined);
});

test('an incomplete profile falls back per field, not wholesale', () => {
  const profile = mapV2Profile({ reportedProfile: { minimum_heat_temp: 8 } })!;
  assert.strictEqual(profile.minimumSetPoints.heat, 8, 'what was reported is used');
  assert.strictEqual(profile.minimumSetPoints.cool, 16, 'what was not falls back');
  assert.strictEqual(profile.hasModeDry, false, 'a mode tile needs an explicit true');
});

// ---- reportedCondition -> DeviceStatus -----------------------------------

test('a populated condition maps onto DeviceStatus', () => {
  const status = mapV2Condition(zoneOf(SERIAL_A))!;

  assert.strictEqual(status.deviceSerial, SERIAL_A);
  assert.strictEqual(status.power, 1);
  assert.strictEqual(status.operationMode, 'dry', 'from more.operation_mode_text: "Dehumidify"');
  assert.strictEqual(status.roomTemp, 21.5);
  assert.strictEqual(status.spCool, 22);
  assert.strictEqual(status.spHeat, 20.5);
  assert.strictEqual(status.spAuto, null);
  assert.strictEqual(status.rssi, -37, 'from the condition, not the zone (whose rssi is {})');
  assert.strictEqual(status.fanSpeed, 'auto');
  assert.strictEqual(status.airDirection, 'auto');
  assert.strictEqual(status.filterDirty, false);
  assert.strictEqual(status.defrost, false);
  assert.strictEqual(status.standby, false);
  assert.strictEqual(status.humidity, 41, 'the only v2 humidity leaf is the MHK2 block');
  assert.strictEqual(status.connected, true, 'derived from seconds_since_contact');
});

test('an EMPTY condition maps to null rather than to a unit that looks off', () => {
  // Every unit in both pykumo sample accounts looks like this. A mapper that filled
  // in zeros would show every unit off and push a NaN at CurrentTemperature.
  assert.strictEqual(mapV2Condition(zoneOf(SERIAL_B)), null);
  assert.strictEqual(mapV2Condition({ serial: 'X' }), null, 'no condition at all');
  assert.strictEqual(mapV2Condition({ reportedCondition: { power: 1, operation_mode: 3 } }), null,
    'no room temperature is not a state');
});

test('power 0 is off without decoding the mode at all', () => {
  const status = mapV2Condition({
    reportedCondition: { room_temp: 20, power: 0, operation_mode: 16, more: {} },
  })!;
  assert.strictEqual(status.operationMode, 'off');
  assert.strictEqual(status.power, 0);
});

test('an undecodable mode yields no status at all', () => {
  // Guessing is worse than nothing here: mapToCurrentHeaterCoolerState renders an
  // unknown mode as INACTIVE — a running unit shown as off — and
  // mapToTargetHeaterCoolerState collapses it to COOL.
  assert.strictEqual(
    mapV2Condition({ reportedCondition: { room_temp: 20, power: 1, operation_mode: 99, more: {} } }),
    null,
  );
  assert.strictEqual(
    mapV2Condition({ reportedCondition: { room_temp: 20, power: 1, more: {} } }),
    null,
    'no code and no text',
  );
});

test('the mode text wins over the numeric code, and tolerates vendor spacing', () => {
  assert.strictEqual(v2Mode(2, 'Dehumidify'), 'dry');
  assert.strictEqual(v2Mode(99, 'Heating'), 'heat', 'text beats an unknown code');
  assert.strictEqual(v2Mode(3, undefined), 'cool', 'the code is the fallback');
  assert.strictEqual(v2Mode(8, 'Auto Cool'), 'autoCool');
  assert.strictEqual(v2Mode(7, 'Fan Only'), 'vent');
  assert.strictEqual(v2Mode(undefined, 'Nonsense'), undefined);
});

test('power_on stands in for a missing numeric power', () => {
  const status = mapV2Condition({
    reportedCondition: { room_temp: 20, operation_mode: 3, more: { power_on: true } },
  })!;
  assert.strictEqual(status.power, 1);
  assert.strictEqual(status.operationMode, 'cool');
});

test('a fan speed or vane label is matched through separators and case', () => {
  const status = mapV2Condition({
    reportedCondition: {
      room_temp: 20, power: 1, operation_mode: 3, fan_speed: 4, air_direction: 2,
      more: { fan_speed_text: 'Super Quiet', air_direction_text: 'Mid-Horizontal' },
    },
  })!;
  // normalizeFanSpeed lower-cases but keeps spaces and hyphens, which is why this
  // path has its own key function rather than reusing it.
  assert.strictEqual(status.fanSpeed, 'superQuiet');
  assert.strictEqual(status.airDirection, 'midhorizontal');
});

test('an unlabelled fan speed or vane is left UNSET rather than guessed', () => {
  // The dangerous case: a misguessed index produces a perfectly valid string
  // ('quiet' where the unit is on 'low'), so every guard accepts it and the user
  // sees a wrong slider with no message anywhere. Only code 0 = Auto is proven.
  const status = mapV2Condition({
    reportedCondition: { room_temp: 20, power: 1, operation_mode: 3, fan_speed: 4, air_direction: 3, more: {} },
  })!;
  assert.strictEqual(status.fanSpeed, undefined);
  assert.strictEqual(status.airDirection, undefined);
});

test('a long-silent adapter is not reported as connected', () => {
  const status = mapV2Condition({
    reportedCondition: { room_temp: 20, power: 1, operation_mode: 3, seconds_since_contact: 4000, more: {} },
  })!;
  assert.strictEqual(status.connected, false);
});

// ---- endpoint selection --------------------------------------------------

test('the region picks BOTH the host and the path', () => {
  // The trap: mesca answers /login/v2 and geo-c answers /login, so a bare hostname
  // option would be wrong for one of them.
  assert.deepStrictEqual(v2Endpoint('ca'), {
    host: 'mesca-prod.kumocloud.com',
    path: '/login/v2',
    url: 'https://mesca-prod.kumocloud.com/login/v2',
  });
  assert.deepStrictEqual(v2Endpoint('us'), {
    host: 'geo-c.kumocloud.com',
    path: '/login',
    url: 'https://geo-c.kumocloud.com/login',
  });
  assert.strictEqual(new KumoV2Client(makeLog() as never, 'ca').endpoint.url,
    'https://mesca-prod.kumocloud.com/login/v2');
  assert.strictEqual(new KumoV2Client(makeLog() as never, 'us').endpoint.url,
    'https://geo-c.kumocloud.com/login');
});

// ---- the client ----------------------------------------------------------

interface Capture {
  url: string;
  init: RequestInit;
}

/** What the stubbed fetch should answer. `text` wins over `body` when both are set. */
interface Answer {
  status?: number;
  body?: unknown;
  text?: string;
}

/** Run `fn` with global fetch answering `reply`, recording every request. */
async function withFetch(
  reply: (url: string) => Answer | Promise<Answer>,
  fn: (calls: Capture[]) => Promise<void>,
): Promise<void> {
  const calls: Capture[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit) => {
    calls.push({ url: String(input), init });
    const answer = await reply(String(input));
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (answer.text !== undefined) {
          return JSON.parse(answer.text);
        }
        return answer.body;
      },
      text: async () => answer.text ?? JSON.stringify(answer.body),
    };
  }) as never;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('the login posts the v2 body to the region host, with no X-App-Version', () => {
  return withFetch(() => ({ body: makeV2Reply() }), async (calls) => {
    const client = new KumoV2Client(makeLog() as never, 'ca');
    const outcome = await client.login('user@example.com', 'secret');

    assert.strictEqual(calls.length, 1, 'exactly one request: this is a bootstrap, not a poller');
    assert.strictEqual(calls[0].url, 'https://mesca-prod.kumocloud.com/login/v2');
    assert.strictEqual(calls[0].init.method, 'POST');

    const headers = calls[0].init.headers as Record<string, string>;
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.ok(!('X-App-Version' in headers), 'that is a v3 header; v2 versions in the body');

    const body = JSON.parse(String(calls[0].init.body));
    assert.deepStrictEqual(body, {
      username: 'user@example.com', password: 'secret', appVersion: V2_APP_VERSION,
    });
    assert.strictEqual(V2_APP_VERSION, '2.2.0');
    assert.ok(!calls[0].url.includes('user@example.com'), 'credentials never go in the query');

    assert.strictEqual(outcome.fatal, false);
    assert.strictEqual(outcome.inventory?.devices.length, 3);
  });
});

test('a rejected sign-in is FATAL, and a server fault is not', () => {
  // The distinction that keeps a wrong password from being re-posted every minute
  // until the account locks, while a 500 or a flaky network still gets retried.
  return withFetch((url) => ({ status: url.includes('mesca') ? 401 : 500 }), async () => {
    const ca = await new KumoV2Client(makeLog() as never, 'ca').login('u@e.com', 'bad');
    assert.strictEqual(ca.fatal, true);
    assert.match(ca.reason ?? '', /401/);
    assert.match(ca.reason ?? '', /mesca-prod\.kumocloud\.com/);
    assert.strictEqual(ca.inventory, undefined);

    const us = await new KumoV2Client(makeLog() as never, 'us').login('u@e.com', 'secret');
    assert.strictEqual(us.fatal, false);
    assert.match(us.reason ?? '', /500/);
  });
});

test('a 200 that is not JSON, and a dead host, are both survivable', async () => {
  await withFetch(() => ({ text: 'not json at all' }), async () => {
    const outcome = await new KumoV2Client(makeLog() as never, 'ca').login('u@e.com', 'p');
    assert.strictEqual(outcome.fatal, false);
    assert.match(outcome.reason ?? '', /not JSON/i);
  });
  await withFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')), async () => {
    const outcome = await new KumoV2Client(makeLog() as never, 'ca').login('u@e.com', 'p');
    assert.strictEqual(outcome.fatal, false);
    assert.match(outcome.reason ?? '', /did not answer/);
  });
});

test('no credentials means no request at all', () => {
  return withFetch(() => ({ body: [] }), async (calls) => {
    const outcome = await new KumoV2Client(makeLog() as never, 'ca').login(undefined, undefined);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(outcome.fatal, true, 'nothing to retry against');
  });
});

test('an account the host serves with no units is reported, not treated as a parse failure', () => {
  return withFetch(() => ({ body: makeV2Reply({ zones: false }) }), async () => {
    const outcome = await new KumoV2Client(makeLog() as never, 'ca').login('u@e.com', 'p');
    assert.strictEqual(outcome.fatal, false);
    assert.match(outcome.reason ?? '', /no units/);
    assert.strictEqual(outcome.inventory?.devices.length, 0);
  });
});

// ---- v2 works while v3 is forbidden -------------------------------------

test('the v2 sign-in works while the v3 kill switch is armed', () => {
  // The whole point of putting v2 in its own module: `cloudDisabled` is a KumoAPI
  // field checked at five v3-only sites, so "the v3 API is forbidden" holds
  // structurally rather than by every call site remembering the mode — and the v2
  // client, holding no reference to that class, is simply outside its reach.
  return withFetch((url) => {
    assert.ok(!url.includes('app-prod'), 'nothing may reach the v3 API');
    return { body: makeV2Reply() };
  }, async (calls) => {
    const api = new KumoAPI('user@example.com', 'secret', makeLog() as never, false, false, true);
    try {
      assert.strictEqual(await api.login(), false, 'v3 login refuses');
      assert.strictEqual(await api.startStreaming([SERIAL_A]), false);
      assert.deepStrictEqual(await api.getSites(), []);
      assert.deepStrictEqual(await api.getZones('site-1'), []);
      // strictEqual on the length, not deepStrictEqual on the array: node's
      // deepStrictEqual is typed `asserts actual is T`, which would narrow `calls`
      // to never[] for the rest of the block and break the assertions below it.
      assert.strictEqual(calls.length, 0, 'not one v3 request left the process');

      const outcome = await new KumoV2Client(makeLog() as never, 'ca').login('user@example.com', 'secret');
      assert.strictEqual(outcome.inventory?.creds.size, 2, 'and the v2 bootstrap still works');
      assert.deepStrictEqual(
        calls.map((c) => c.url),
        ['https://mesca-prod.kumocloud.com/login/v2'],
        'exactly one request, to the v2 host',
      );
    } finally {
      api.destroy();
    }
  });
});

test('getZones refuses even on an instance that already holds a token', () => {
  // getZones is the one method in kumo-api.ts that builds its own fetch instead of
  // going through makeAuthenticatedRequest, so it was safe only TRANSITIVELY: no
  // token, no login, empty array. A bootstrap that seeds state onto the instance
  // would break that inheritance silently.
  return withFetch(() => ({ body: [] }), async (calls) => {
    const api = new KumoAPI('user@example.com', 'secret', makeLog() as never, false, false, true);
    try {
      (api as unknown as { accessToken: string }).accessToken = 'seeded-token';
      (api as unknown as { tokenExpiresAt: number }).tokenExpiresAt = Date.now() + 3600000;

      assert.deepStrictEqual(await api.getZones('site-1'), []);
      assert.deepStrictEqual(calls, [], 'the guard is on the method, not on the token');
    } finally {
      api.destroy();
    }
  });
});

// ---- helper --------------------------------------------------------------

/** The raw zoneTable entry for a serial, straight out of the fixture. */
function zoneOf(serial: string): Record<string, unknown> {
  const raw = makeV2Reply() as Array<Record<string, unknown>>;
  const tree = raw[2];
  const site = (tree.children as Array<Record<string, unknown>>)[0];
  const table = site.zoneTable as Record<string, Record<string, unknown>>;
  return table[serial];
}

test('the account temperature-unit preference is read from root[1]', () => {
  // TemperatureDisplayUnits has no other source, so without this it reads
  // Fahrenheit on a Celsius account. The live Canadian tree carries
  // `celsius: true` here; root[1] is the ONLY element besides root[2] this
  // parser touches, and it takes just this one boolean from it.
  assert.strictEqual(parseV2Login(makeV2Reply()).celsius, true);
});

test('a host that omits or garbles root[1] leaves the preference unset', () => {
  // The root array shape differs between hosts (5 elements on mesca, fewer on
  // geo-c), so the read is defensive: an absent preference is not an error, and
  // must not be mistaken for Fahrenheit.
  assert.strictEqual(parseV2Login([{ token: 'x' }]).celsius, undefined,
    'a short reply has no root[1] at all');

  const notAnObject = makeV2Reply();
  notAnObject[1] = 'preferences';
  assert.strictEqual(parseV2Login(notAnObject).celsius, undefined);

  const notABoolean = makeV2Reply();
  (notABoolean[1] as Record<string, unknown>).celsius = 'true';
  assert.strictEqual(parseV2Login(notABoolean).celsius, undefined,
    'a string "true" is not a boolean — no guessing');
});

test('an explicit Fahrenheit account is carried through, not just Celsius', () => {
  const reply = makeV2Reply();
  (reply[1] as Record<string, unknown>).celsius = false;
  assert.strictEqual(parseV2Login(reply).celsius, false);
});
