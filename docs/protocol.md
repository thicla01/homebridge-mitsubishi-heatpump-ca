# Protocol

What this plugin puts on the wire, and what it exposes to HomeKit. Reverse-engineered
from the Mitsubishi Comfort app and cross-checked against
[pykumo](https://github.com/dlarrick/pykumo); none of it is documented by the vendor and
any of it can change without notice.

Earlier endpoint spelunking, including endpoints that turned out not to exist, is in
[api-exploration.md](api-exploration.md).

## REST

Base `https://app-prod.kumocloud.com/v3` (`API_BASE_URL`, `src/settings.ts:7`). Requests
carry `Authorization: Bearer <token>` and `X-App-Version` (`APP_VERSION`, currently
`3.2.4`). Access tokens live 20 minutes and are refreshed 5 minutes early.

| Endpoint | Use |
|---|---|
| `POST /login` | Authenticate |
| `POST /refresh` | Renew the access token |
| `GET /sites` | Discover sites |
| `GET /sites/{siteId}/zones` | Primary poll. Zone state plus the nested `adapter` object |
| `GET /devices/{serial}/status` | Read `cryptoSerial`, and only that. Connection state comes from the zones payload, not from here |
| `POST /devices/send-command` | `{ deviceSerial, commands }` |

That is the complete set. `GET /devices/{serial}` and `/config` exist but are not called.

## Socket.IO

`https://socket-prod.kumocloud.com` (`SOCKET_BASE_URL`), upgraded to `wss://` by
socket.io. Streaming is the primary update path; cloud polling is the fallback.

**Emitted:**

| Emit | Purpose |
|---|---|
| `subscribe(serial)` | One per device |
| `subscribe('', userId)` | Account-level. Required for `adapter_update` to arrive at all |
| `force_adapter_request(serial, 'iuStatus' \| 'profile' \| 'adapterStatus')` | On first connect, pull current state rather than waiting for a push |
| `device_status_v2('')` and `device_status_v2(serial)` | Request connection status |

`force_adapter_request` and `device_status_v2` are sent on the initial connection only,
not on routine reconnects.

**Received:**

| Event | Carries |
|---|---|
| `device_update` | Full unit state, including `fanSpeed`, `airDirection`, `displayConfig` |
| `profile_update` | Capabilities, fan-speed count, setpoint limits |
| `sensor_update` | A paired wireless sensor's temperature, humidity and battery |
| `adapter_update` | Adapter firmware and RSSI. Formerly also the local-control password |
| `device_status_v2` | Connected / disconnected. **Logging only** — nothing in the plugin consumes it |
| `acoil_update` | Outdoor unit. Minimal, debug-logged |

`operationMode` is **sent** as `'auto'` but **returned** as `'autoHeat'` or `'autoCool'`.

The adapter does not validate writes: `vaneDir: "notARealVane"` returns HTTP 200 and is
silently ignored, so every fan-speed and vane value is checked against a known vocabulary
before it is sent (`src/settings.ts`).

## Local LAN

`PUT http://<unit-ip>/api?m=<token>`. Reads and writes are both PUTs — a status read sends
empty leaf objects and the adapter fills them in.

The token is a port of pykumo's `_token()`: two SHA-256 passes over an 88-byte buffer
assembled from a fixed 32-byte constant, `sha256(password ‖ body)`, and the first 4 bytes
of `cryptoSerial` (`src/local-api.ts:101-124`).

Both halves of the key come from the cloud — `password` from `adapter_update`,
`cryptoSerial` from `GET /devices/{serial}/status` — and **the cloud stopped serving both
around 2026-07-31**. See [README → Local LAN control](../README.md#local-lan-control).

## HomeKit services

One accessory per indoor unit.

**HeaterCooler** (primary):

| Characteristic | Notes |
|---|---|
| `Active` | On/off. Independent of mode |
| `CurrentHeaterCoolerState` | Inactive / idle / heating / cooling. Idle is real — fan-only and compressor standby report it |
| `TargetHeaterCoolerState` | Heat / cool / auto, narrowed to what the unit's profile supports |
| `CurrentTemperature` | From the paired wireless sensor when there is one, otherwise the unit's own thermistor |
| `HeatingThresholdTemperature`, `CoolingThresholdTemperature` | These **are** the setpoint controls in every mode. There is deliberately no `TargetTemperature` |
| `SwingMode` | Vane swing, on units that have one |
| `TemperatureDisplayUnits` | Settable. The Home app ignores it; Eve and others honour it |

**Fanv2** (linked, subtype `airflow`): `Active`, `CurrentFanState`, `RotationSpeed`
(`minValue` 0, `maxValue` 100, `minStep` 25 — five detents, nothing dead), and
`TargetFanState` on units whose profile reports an auto fan.

**Optional, per unit:**

| Service | When |
|---|---|
| `HumiditySensor` | `showHumiditySensor`, on by default |
| `Battery` | Units with a paired wireless sensor. `BatteryLevel`, `StatusLowBattery` below 20%, `ChargingState = NOT_CHARGEABLE` |
| `FilterMaintenance` | Created lazily, the first time the unit reports a dirty filter |
| `Slats` | `exposeVaneSlat`, off by default. Five discrete angles, −90° to 90° in 45° steps |
| `Switch` ×2 | `showDrySwitch` / `showFanOnlySwitch`, both off by default and both capability-gated |

A `Thermostat` service left in the accessory cache by a pre-2.0 version is removed on
first start, with a log line saying so.
