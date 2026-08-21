# CLAUDE.md

Orientation for an AI assistant working on this repo. Deliberately short: anything
restated from the code here would drift out of date silently. Behaviour lives in `src/`
and is pinned by `test/`. Rationale for non-obvious decisions lives in comments next to
the code that implements them.

## Architecture in brief

One Homebridge dynamic platform (`src/platform.ts`) owns the cloud clients
(`src/kumo-api.ts` for v3; `src/kumo-v2.ts` for the one-shot legacy v2 login that
bootstraps the unit inventory, real capability profiles and per-unit LAN secrets), the
LAN client (`src/local-api.ts`), the mirror controller (`src/mirror.ts`) and one
accessory per unit (`src/accessory.ts`).

- Each unit is a **HeaterCooler** (on/off is `Active`, setpoints are the two threshold
  characteristics, there is no `TargetTemperature`) plus a linked **Fanv2** for speed and
  fan-auto, `SwingMode` on the HeaterCooler, and opt-in `Slats` / `HumiditySensor` / Dry /
  Fan-only services.
- Setpoint writes are quantized by `src/temperature.ts` before they reach either
  transport, on the grid of the unit the user is reading: Fahrenheit accessories snap to
  the Celsius of a whole °F, Celsius accessories to the 0.5 °C grid the Home app
  displays. The grid is selected per `accessory.context.displayUnits`
  (`accessory.ts:quantize`) — do not "unify" the two paths: the °F snap on a Celsius
  reader stored a requested 22.0 as 22.3 and displayed 22.5, observed live 2026-08-19.
- Under the default `cloudRegion: "us"`, updates arrive by Socket.IO first, cloud
  polling as fallback, LAN polling when local control is up, and commands go local-first
  with per-unit cloud fallback (`accessory.ts:sendDeviceCommand`). Under
  `cloudRegion: "ca"` none of the v3 machinery runs — the LAN poller is the only status
  source and the LAN the only command path (see the next section). Freshness rules are
  in `accessory.ts:processZoneUpdate`.
- Config shape and every option's meaning: `KumoConfig` in `src/settings.ts`.
- `localControl`, `localOnly`, `cloudRegion`, `localCredentialSource` and `mirror` are
  read from the **parent** Homebridge config, so changing any of them needs a full
  Homebridge restart, not a child-bridge restart.

## Read this before touching local control

**Local control works, and for Canadian accounts it is the only control path.**
Authenticating to a unit's WiFi adapter needs two per-device secrets (`password`,
`cryptoSerial`). Around 2026-07-31 **the v3 API** stopped serving both — reproduced on
unrelated accounts and a second client stack (pykumo #78) — so this fork bootstraps them
from the **legacy v2 login** instead: `src/kumo-v2.ts` posts once to
`mesca-prod.kumocloud.com/login/v2` (`cloudRegion: "ca"`) or `geo-c.kumocloud.com/login`
(us), and the reply carries the whole inventory — units, room names, each unit's real
capability profile, and both LAN secrets. Under a v2 source, v3 not carrying the secrets
is EXPECTED rather than an outage (`kumo-api.ts` says so where it silences the old
credential warnings). Do not re-implement or "re-verify" the v2 thread: it is live,
mapped against the real backends, and pinned by `test/kumo-v2.test.ts` /
`test/v2-bootstrap.test.ts` / `test/local-only.test.ts`.

Two modes use the v2 source:

- `cloudRegion: "ca"` — v3 answers Canadian accounts HTTP 500, so a kill switch
  (`platform.ts` `v3Unavailable`, enforced structurally inside `KumoAPI` as
  `cloudDisabled`) keeps v3 entirely un-contacted: no login, no streaming, no polling,
  and no per-unit command fallback — a fallback there is not a slower path but a
  guaranteed failure preceded by a login attempt. One v2 sign-in, then the LAN does
  everything; there is no socket or streaming anywhere in the v2 tree, so the LAN poller
  is the only status source.
- `localCredentialSource: "v2"` on a US account — same harvest from geo-c, while v3
  keeps its upstream role (streaming, polling, per-unit cloud fallback). Implies
  `localControl`.

A refused v2 sign-in (401/403) is reported once and never retried — repeating a rejected
sign-in risks locking the account. The reply also carries the account holder's name,
phone and postal addresses; the parser refuses to read those parts, and secrets travel in
a separate `Map` that never touches logs or `accessory.context` (`V2Device` in
`kumo-v2.ts` is the boundary type). The Homebridge UI manufactures config contradictions
out of its schema defaults (ca + v3 source; ca or a v2 source + `localControl: false`);
`platform.ts:reconcileImpliedConfig` absorbs exactly those three with a logged warning
because each has a single right answer, while the ambiguous ones (enum typos,
`localOnly` + v2) stay fatal in the validator.

Under the default US v3 credential source, the gather is deliberately **bounded** — it
retries with backoff, gives up after about an hour with one clear warning, and drops the
local client so writes stop evaluating a path that cannot succeed. That is the intended
behaviour, not a timeout to "fix". Nothing is persisted, so if the fields return, local
control resumes at the next restart. (A v2-sourced retry starts at a 15-minute floor
instead: a v2 login is a whole authentication and its reply is complete, so re-asking
sooner cannot produce anything new.)

## Never throw from the platform constructor

Homebridge constructs platforms unguarded: `new constructor(...)` in `loadPlatforms()` has
no try/catch, though the plugin lookup on either side of it does. An error escaping there
rejects `Server.start()`, and the CLI's handler answers by SIGTERMing the process — so a
missing password in *this* plugin's config takes down every other plugin in the install,
before the bridge publishes, and the supervisor restarts into the same throw. Under a child
bridge it is `process.exit(1)` and a restart loop that stops after five attempts.

There is therefore no way for one platform to "refuse to start". The only options are idle
or fatal. `validatePlatformConfig` returns a reason string, the constructor logs it and
returns, and `test/config-validation.test.ts` pins that a rejected config subscribes to no
lifecycle events. The same rule applies to anything reachable from a Socket.IO handler or a
bare `setTimeout` — nothing above them catches.

## Tests

`npm test` runs `pretest` first, which builds **both** `src/` → `dist/` and `test/` →
`dist-test/`, then runs `node --test dist-test/*.test.js`. node:test, no framework.

Three things that are easy to get wrong:

- **Tests import from `dist/`, not `src/`.** Editing `src/` and running `node --test`
  directly tests the previous build. Always go through `npm test`.
- **Plain `tsc --noEmit` type-checks `src/` only.** The root tsconfig's `include` is
  `src/**/*`; the all-TypeScript test suite compiles only through `npm test`'s
  `build:test` step (`tsc -p tsconfig.test.json`). "Type-checking the repo" with bare
  tsc never sees a type error in `test/`.
- **Never hand-roll HAP constants.** `test/helpers.ts` reads enum members off
  `@homebridge/hap-nodejs` at runtime, and `test/helpers.test.ts` pins that it really
  does. This is not hypothetical: ten hand-rolled copies of the harness encoded
  `TargetHeaterCoolerState.AUTO = 3` — the old *Thermostat* value, where HeaterCooler
  defines `AUTO = 0` — and no test failed, because `src/` never uses a numeric literal for
  a HAP state, so the fake supplied both sides of every assertion.

## The vendor API

Every endpoint and Socket.IO event is tabulated once, in **`docs/protocol.md`**. Read it
there and update it there — a second copy in this file would drift.

Four behaviours that are not visible from the shapes:

- `operationMode` is **sent** as `'auto'` but **returned** as `'autoHeat'` / `'autoCool'`.
- The adapter does not validate writes. `vaneDir: "notARealVane"` returns HTTP 200 and is
  silently ignored, so every fan-speed and vane value is checked against a vocabulary in
  `settings.ts` before it is sent. Reads are matched case-insensitively, because some
  units return the capitalised `Low`.
- `device_status_v2` is **logging only**. Nothing in the plugin consumes it; the cache and
  callbacks it used to feed had no consumer.
- `GET /devices/{serial}/status` is read for `cryptoSerial` and nothing else. Connection
  state comes from the zones payload.

## Hard-won invariants

Each of these was a live-observed field failure before it was a rule. The tests pin them,
but a refactor can satisfy a test while hollowing out the reason — so the reason travels
with the rule:

- **`noteModeIntent` runs synchronously, before the command's first await**
  (`accessory.ts`). It arms the off-suppression window (`offRequestedAt`), and HomeKit
  dispatches a scene's characteristics concurrently — the sibling setpoint handlers in
  the same burst must observe the window before the off command yields. Moved after the
  await, a trailing bare setpoint reaches the LAN adapter mode-less (local commands
  carry no `power` field) and revives the unit being turned off.
- **Mode, threshold and Fanv2-ON entry guards use `offInFlight()`, NOT
  `shouldSuppressSetpoint()`.** The wider predicate is also true for a unit that is
  merely off, and a merely-off unit must stay controllable — picking a mode is how a
  user turns it back on, and an "AC on" scene's setpoints were cached-and-lost while
  only the mode reached the unit. Only an off in the same burst blocks; the merely-off
  case is decided after the 1500 ms hold, by which time the concurrent on has landed.
- **The auth-failure streak counts requests, not attempts**
  (`local-api.ts:noteRequestOutcome`). A single `device_authentication_error` can be
  transient — the token signs the body, so a truncated body under connection contention
  reads as a signature failure, observed live 2026-08-19 — so each rejected request is
  retried once after 250 ms and the warning fires only after 3 consecutive rejected
  requests. Counting attempts would reach that threshold in two polls and undo the
  point of the streak.
- **An off command is never skipped.** The redundant-mode dedup in
  `accessory.ts:setActive` applies to active modes only; any deduplication that could
  absorb an off silently leaves someone's heat pump running.
- **Scene-race tests must model transport latency AND the per-device mutex.** A fake
  whose `sendCommand` resolves instantly cannot reproduce the scene bugs: the off's
  optimistic `power = 0` lands before the setpoints' hold expires, so the cache
  suppresses them and the race never runs. See the "THE TIMING IS LOAD-BEARING"
  harness in `test/off-guard-mode.test.ts`.

## Where the longer rationale lives

| Doc | Covers |
|---|---|
| `docs/protocol.md` | REST, Socket.IO, the v2 login, payload shapes, local LAN, HomeKit services, and what does **not** exist |
| `docs/configuration.md` | Every config option, validation, UI coverage |
| `SECURITY.md` | Threat model and the guards the fork added — `redirect: 'error'` on cloud fetches, `isLocalHost` address validation, the 64KB cap on LAN replies, log redaction — plus the residual risks left unfixed on purpose. Read it before treating one of those guards as removable dead weight |

Three docs, and that is deliberate. Design rationale for code that exists lives in a comment
next to that code, not in a doc — a design doc written before the code goes stale the
moment the code moves, and nothing fails when it does. `docs/` is for what has no code
site: the vendor API we do not control, and the user-facing manual.

**Do not add a Matter accessory graph.** Homebridge 2.2.1 has no `fanControl`
feature-preservation branch and no rocking/airflow handlers, so vane and swing are
structurally unreachable over Matter — and vane control is the reason this plugin exists.
A full blocker-by-blocker analysis with re-verification commands was written on 2026-07-27
and then deleted, because it was pinned to Homebridge internals that will churn long
before Matter is viable. Recover it if the question comes up again:
`git show dbf6651:docs/matter.md`. Re-verify before trusting a line of it.

## Working rules

- Run `npm test` before and after any change; this plugin is deployed on real hardware and
  a regression turns off someone's heat. CI runs the same on Node 20.0 / 22 / 24
  (`.github/workflows/test.yml`).
- Add the regression test with the fix, in the same style as its neighbours.
- This fork is **not published to npm** — the package is renamed
  `homebridge-mitsubishi-heatpump-ca` and installs from source or an `npm pack` tarball;
  the release path is in `CONTRIBUTING.md`. The inherited
  `.github/workflows/publish.yml` still checks the pre-rename npm name
  (`npm view "homebridge-mitsubishi-heatpump@..."`), so its already-published guard can
  never fire — do not cut a release through it.
