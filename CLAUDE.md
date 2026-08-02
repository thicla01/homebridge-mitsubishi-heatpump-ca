# CLAUDE.md

Orientation for an AI assistant working on this repo. Deliberately short: anything
restated from the code here would drift out of date silently. Behaviour lives in `src/`
and is pinned by `test/`. Rationale for non-obvious decisions lives in comments next to
the code that implements them.

## Architecture in brief

One Homebridge dynamic platform (`src/platform.ts`) owns the cloud client
(`src/kumo-api.ts`), the optional LAN client (`src/local-api.ts`), the mirror controller
(`src/mirror.ts`) and one accessory per unit (`src/accessory.ts`).

- Each unit is a **HeaterCooler** (on/off is `Active`, setpoints are the two threshold
  characteristics, there is no `TargetTemperature`) plus a linked **Fanv2** for speed and
  fan-auto, `SwingMode` on the HeaterCooler, and opt-in `Slats` / `HumiditySensor` / Dry /
  Fan-only services.
- Setpoint writes are snapped to the Celsius of a whole °F by `src/temperature.ts` before
  they reach either transport.
- Updates arrive by Socket.IO first, cloud polling as fallback, LAN polling when local
  control is up; freshness rules are in `accessory.ts:processZoneUpdate`.
- Commands go local-first with per-unit cloud fallback (`accessory.ts:sendDeviceCommand`).
- Config shape and every option's meaning: `KumoConfig` in `src/settings.ts`.
- `localControl` and `mirror` are read from the **parent** Homebridge config, so changing
  either needs a full Homebridge restart, not a child-bridge restart.

## Read this before touching local control

**Local control cannot work right now, and it is not a bug in this repo.** Authenticating
to a unit's WiFi adapter needs two per-device secrets the vendor cloud used to hand out.
Around 2026-07-31 the cloud stopped serving both: `password` vanished from `adapter_update`
and `cryptoSerial` from `GET /devices/{serial}/status`. Reproduced on unrelated accounts
and on a second client stack (pykumo #78, by its maintainer).

The credential gather is deliberately **bounded** — it retries with backoff, gives up after
about an hour with one clear warning, and drops the local client so writes stop evaluating
a path that cannot succeed. That is the intended behaviour, not a timeout to "fix". Nothing
is persisted, so if the fields return, local control resumes at the next restart.

## Tests

`npm test` runs `pretest` first, which builds **both** `src/` → `dist/` and `test/` →
`dist-test/`, then runs `node --test dist-test/*.test.js`. node:test, no framework.

Two things that are easy to get wrong:

- **Tests import from `dist/`, not `src/`.** Editing `src/` and running `node --test`
  directly tests the previous build. Always go through `npm test`.
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

## Where the longer rationale lives

| Doc | Covers |
|---|---|
| `docs/protocol.md` | REST, Socket.IO, payload shapes, local LAN, HomeKit services, and what does **not** exist |
| `docs/matter.md` | Why Matter is deferred, and shell commands to re-verify each blocker |
| `docs/configuration.md` | Every config option, validation, UI coverage |

Three docs, and that is deliberate. Design rationale for code that exists lives in a
comment next to that code, not in a doc — a design doc written before the code goes stale
the moment the code moves, and nothing fails when it does. `docs/` is for what has no code
site: a vendor API we do not control, a decision *not* to build something, and the
user-facing manual.

## Working rules

- Run `npm test` before and after any change; this plugin is deployed on real hardware and
  a regression turns off someone's heat. CI runs the same on Node 20.19 / 22 / 24
  (`.github/workflows/test.yml`).
- Add the regression test with the fix, in the same style as its neighbours.
- Publishing is `.github/workflows/publish.yml`; its OIDC constraints are documented in
  comments in that file.
