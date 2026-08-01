# CLAUDE.md

Orientation for an AI assistant working on this repo. Deliberately short: anything
restated from the code here would drift out of date silently. Behaviour lives in
`src/` and is pinned by `test/` (`npm test`, node:test, no framework). Rationale for
non-obvious decisions lives in comments next to the code that implements them.

## Architecture in brief

One Homebridge dynamic platform (`src/platform.ts`) owns the cloud client
(`src/kumo-api.ts`), the optional LAN client (`src/local-api.ts`), the mirror
controller (`src/mirror.ts`) and one accessory per unit (`src/accessory.ts`).

- Each unit is a **HeaterCooler** (on/off is `Active`, setpoints are the two
  threshold characteristics, there is no `TargetTemperature`) plus a linked
  **Fanv2** for speed and fan-auto, `SwingMode` on the HeaterCooler, and
  opt-in `Slats` / `HumiditySensor` / Dry / Fan-only services.
- Setpoint writes are snapped to the Celsius of a whole °F by
  `src/temperature.ts` before they reach either transport.
- Updates arrive by Socket.IO first, cloud polling as fallback, LAN polling when
  local control is up; freshness rules are in `accessory.ts:processZoneUpdate`.
- Commands go local-first with per-unit cloud fallback
  (`accessory.ts:sendDeviceCommand`).
- Config shape and every option's meaning: `KumoConfig` in `src/settings.ts`.

## Kumo Cloud v3 REST

Base `https://app-prod.kumocloud.com/v3`. Headers: `Authorization: Bearer <token>`
and `X-App-Version` (`APP_VERSION` in `settings.ts`). Endpoints this plugin calls:

| Endpoint | Use |
|---|---|
| `POST /login`, `POST /refresh` | Auth. Access tokens live 20 min |
| `GET /sites` | Discover sites |
| `GET /sites/{siteId}/zones` | Primary poll. Zone + nested `adapter` state |
| `GET /devices/{serial}/status` | Connection status, `cryptoSerial`, `autoModeDisable` |
| `POST /devices/send-command` | `{ deviceSerial, commands }` |

## Socket.IO (`wss://socket-prod.kumocloud.com`)

Emits: `subscribe(serial)`, `subscribe('', userId)` (account-level, required for
`adapter_update`), `force_adapter_request(serial, 'iuStatus'|'profile'|'adapterStatus')`,
`device_status_v2(serial|'')`.

| Event | Carries |
|---|---|
| `device_update` | Full unit state incl. `fanSpeed`, `airDirection`, `displayConfig` |
| `profile_update` | Capabilities, fan-speed count, setpoint limits |
| `device_status_v2` | Connected / disconnected |
| `adapter_update` | Adapter firmware and RSSI (strip before logging) |
| `sensor_update` | Wireless-sensor temperature, humidity, battery |
| `acoil_update` | Outdoor unit, minimal |

`operationMode` is sent as `'auto'` but returned as `'autoHeat'` / `'autoCool'`.

## Working rules

- Run `npm test` before and after any change; this plugin is deployed on real
  hardware and a regression turns off someone's heat. CI runs the same on
  Node 20.19 / 22 / 24 (`.github/workflows/test.yml`).
- Add the regression test with the fix, in the same style as its neighbours.
- Publishing is `.github/workflows/publish.yml`; its OIDC constraints are
  documented in comments in that file.
