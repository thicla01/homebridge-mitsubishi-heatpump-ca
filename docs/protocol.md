# Protocol

What this plugin puts on the wire, and what it exposes to HomeKit. Reverse-engineered
from the Mitsubishi Comfort app and cross-checked against
[pykumo](https://github.com/dlarrick/pykumo); none of it is documented by the vendor and
any of it can change without notice.

Negative results live here too — see [What does not exist](#what-does-not-exist) — so the
same dead ends do not get explored twice.

## REST

Everything in this section and in [Socket.IO](#socketio) is the **v3** cloud, and under
`cloudRegion: "ca"` or `localOnly` none of it is contacted at all — no login, no polling,
no streaming, no per-command fallback; a `cloudDisabled` kill switch guards every call
path (`src/kumo-api.ts`). A `ca` install's only cloud contact is the one v2 login POST
([REST, v2](#rest-v2)); a `localOnly` install contacts no cloud whatsoever. Both then
live entirely on the [local LAN](#local-lan).

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

That is the complete set. Two more exist but are not called: `GET /devices/{serial}`, and
`GET /config` (notification rate limits and archiving settings — nothing this plugin needs).

`GET /devices/{serial}/profile` returns the same capability and setpoint-limit data that
arrives over the socket as `profile_update`, and is read-only: PUT, PATCH and POST all
404.

### Login rate limiting

Login is rate limited, and **the rate-limit response is not always a 429**. A burst of
login attempts also gets `{"error": "usernameOrPasswordIncorrect"}` for credentials that
are entirely valid, and keeps doing so for 15–30 minutes. If a password appears to have
stopped working right after a run of restarts, this is the first thing to rule out.

The plugin spaces login attempts by 10 seconds and adds 0–60 s of jitter to token
refresh for this reason.

### What does not exist

Verified 2025-12-25, while looking for a way to lower a unit's minimum heating setpoint
below the installer-set 17 °C. All of these 404:

`/installer/login` · `/admin/login` · `/technician/login` ·
`/devices/{serial}/settings` · `/devices/{serial}/config` ·
`/devices/{serial}/installer` · `/devices/{serial}/functioncodes` ·
`/sites/{siteId}/settings` · `/functioncodes` · `/limits` · `/ranges`

Login also ignores `role`, `userType`, `accountType` and `installerPin`. There is no
installer-level authentication on the v3 API.

**Conclusion, recorded so nobody repeats the search:** setpoint limits are installer
settings held in the unit (MHK2 Function Code 181, or an installer's service tool). The
cloud reports them read-only and enforces them — a write outside the range returns 400
with `{"error":{"<serial>":{"commands":["invalidSpHeatRange"]}}}`. No API can change
them.

## Socket.IO

`https://socket-prod.kumocloud.com` (`SOCKET_BASE_URL`), upgraded to `wss://` by
socket.io. Streaming is the primary update path; cloud polling is the fallback. That
sentence describes a US v3 install: under `cloudRegion: "ca"` and `localOnly` the socket
is never opened (see the caveat at [REST](#rest)).

**Emitted:**

| Emit | Purpose |
|---|---|
| `subscribe(serial)` | One per device |
| `subscribe('', userId)` | Account-level. Required for `adapter_update` to arrive at all |
| `force_adapter_request(serial, 'iuStatus' \| 'profile' \| 'adapterStatus')` | On first connect, pull current state rather than waiting for a push |
| `device_status_v2('')` and `device_status_v2(serial)` | Request connection status |

`device_status_v2` is sent on the initial connection only, not on routine reconnects.
`force_adapter_request` mostly is too, with one exception: while gathering local
credentials the platform re-emits `force_adapter_request(serial, 'adapterStatus')` for
each unit still missing its password, on a ~2 s loop until it arrives or the wait times
out (`gatherLocalCreds`, `src/platform.ts`; `requestAdapterStatus`, `src/kumo-api.ts`).

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

### Payloads

Field documentation cross-referenced against
[dlarrick/hass-kumo](https://github.com/dlarrick/hass-kumo),
[EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws) and pykumo's `Cloud_api_v3.md`.
The plugin reads a subset; the rest is recorded because the vendor documents none of it.

`device_update` — primary state event, sent on change and on subscription:

```json
{
  "deviceSerial": "string",
  "roomTemp": 21.5,
  "spHeat": 20, "spCool": 24, "spAuto": null,
  "power": 1,
  "operationMode": "heat",
  "previousOperationMode": "heat",
  "fanSpeed": "auto",
  "airDirection": "auto",
  "humidity": 45,
  "rssi": -55,
  "connected": true,
  "modelNumber": "SVZ-KP30NA",
  "displayConfig": { "filter": false, "defrost": false, "hotAdjust": false, "standby": false },
  "activeThermistor": "string",
  "tempSource": "string",
  "scheduleOwner": "adapter",
  "scheduleHoldEndTime": 0,
  "isSimulator": false, "ledDisabled": false, "isHeadless": false,
  "lastStatusChangeAt": "ISO 8601", "createdAt": "ISO 8601", "updatedAt": "ISO 8601"
}
```

`displayConfig` is the cloud's spelling of what the local API exposes under
`indoorUnit.status`:

| Cloud | Local (pykumo) | Meaning |
|---|---|---|
| `displayConfig.filter` | `filterDirty` | Filter needs cleaning |
| `displayConfig.defrost` | `defrost` | Defrost cycle active |
| `displayConfig.standby` | `standby` | Compressor idle |
| `displayConfig.hotAdjust` | — | Hot adjust active |

`tempSource` is worth knowing: it names which thermistor regulates the unit. `sensor0`
means a paired wireless sensor is the real thermostat, not the head unit.

`profile_update` — capabilities and limits. Beyond the fields the plugin consumes it also
carries `hasHotAdjust`, `hasInitialSettings`, `hasModeTest` and `extendedTemps`.
`minimumSetPoints` / `maximumSetPoints` are `{ cool, heat, auto }` in Celsius.

`adapter_update` — `{ deviceSerial, firmwareVersion, routerRssi, minSetpoint, maxSetpoint,
roomTempDisplayOffset }`, and formerly `password`. **Strip before logging.**

`device_status_v2` — `{ deviceSerial, status, lastTimeConnected, lastDisconnectedReason }`;
`status` is `"connected"` or `"disconnected"`.

`acoil_update` — `{ deviceSerial, date }`. That is all of it.

## Local LAN

`PUT http://<unit-ip>/api?m=<token>`. Reads and writes are both PUTs — a status read sends
empty leaf objects and the adapter fills them in.

The token is a port of pykumo's `_token()`: two SHA-256s — `sha256(password ‖ body)`
first, then SHA-256 over an 88-byte buffer laid out as `W_PARAM` (a fixed 32-byte
constant) at `[0:32)`, that inner hash at `[32:64)`, the constant `0x0840` at `[64:66)`,
`S_PARAM = 0` at `[66]` with `[67:79)` zero, and the cryptoSerial in shuffled order —
byte `[8]` at `[79]`, bytes `[4:8)` at `[80:84)`, bytes `[0:4)` at `[84:88)`
(`computeLocalToken`, `src/local-api.ts:232-252`). Note the token signs the request
**body** — that detail matters below.

Both halves of the key come from the cloud — `password` from `adapter_update`,
`cryptoSerial` from `GET /devices/{serial}/status` — and **the v3 cloud stopped serving both
around 2026-07-31**. See [README → Local LAN control](../README.md#local-lan-control).

Both are per-unit and stable, so they can come from elsewhere: the **v2 cloud** below
serves them still (`localCredentialSource: "v2"`, or implied by `cloudRegion: "ca"`), and
`localOnly` reads them from `localDevices` in the config and skips every cloud entirely.

### Wire format

The body shape is `{"c":{"indoorUnit":{"status":{...}}}}` for reads and writes alike;
the reply echoes the populated tree under `"r"`. The field vocabulary is not the
cloud's (`buildLocalCommandBody` / `mapLocalStatus`, `src/local-api.ts`):

| Cloud (v3) | Local | Notes |
|---|---|---|
| `operationMode` | `mode` | Same strings: `off` / `heat` / `cool` / `auto` / `vent` / `dry` |
| `airDirection` | `vaneDir` | Same vocabulary |
| `power` | — | **No local `power` field.** `mode: "off"` is off; any active mode is on |
| `fanSpeed` | `fanSpeed` | Same vocabulary |
| `displayConfig.filter` / `.defrost` / `.standby` | `filterDirty` / `defrost` / `standby` | Straight from the status |
| `humidity` | — | Not in `indoorUnit.status` at all — see the sensor leaves below |

Two more leaves are read, because humidity and a paired sensor's finer temperature
live outside `indoorUnit.status`:

| Body | Returns |
|---|---|
| `{"c":{"sensors":{"<i>":{}}}}` | Paired wireless sensor slot `i` (0–3): `uuid`, `temperature` (~6 decimals, against the unit's 0.5 °C-quantized `roomTemp`), `humidity`. Slots are consecutive — the first slot with no `uuid` ends the list |
| `{"c":{"mhk2":{"status":{}}}}` | An MHK2 wall thermostat; `indoorHumid` is the only field read |

They are queried only while the unit reports a `tempSource`/`activeThermistor` of
`sensorN`; a unit that yields neither is latched and not asked again until its
temperature source changes (`getSensorReadings`, `src/local-api.ts`).

### `_api_error`

The adapter answers HTTP 200 to everything it parses, its own errors included, so the
body is the only signal there is. A reply without `"r"` carries `_api_error`
(vocabulary from pykumo; `classifyApiError`, `src/local-api.ts`):

| Code | Meaning |
|---|---|
| `device_authentication_error` | The token did not verify. **Not proof of a wrong credential** — see below |
| `serializer_error`, `__no_memory` | "Not right now." Transient; says nothing about identity or credentials |

Observed live 2026-08-19, twice in one day: an adapter with provably correct
credentials (the token is a pure function of them and the body) rejected exactly one
poll out of ~30 and then kept working. The token signs the request **body**, so an
adapter that reads a truncated body computes a different digest and can only report it
as a signature failure — an authentication error. The likely trigger is contention:
the adapter holds roughly one connection, and the Kumo phone app is a second client
that owes us no turn-taking. A single `device_authentication_error` is therefore not
evidence of a wrong password.

### Client behaviour

- **Per-device mutex, keep-alive off.** Requests are serialized per unit — the adapter
  tolerates ~one concurrent local connection (pykumo locks for this reason; the HA
  library dropped the lock, which is not repeated here). Keep-alive stays off because a
  parked socket occupies a slot in the adapter's tiny connection table; both reference
  implementations tear the connection down after every exchange.
- **Retry once.** A transport failure is retried once on a fresh socket — the adapter
  closes idle connections and the next write on one fails. An auth rejection is also
  retried once, after a 250 ms pause (long enough for a competing client to finish its
  exchange). Retrying is safe because every command is an idempotent absolute-value
  write, never a delta.
- **Warning after 3 consecutive rejected requests.** Counted per request, not per
  attempt — a retried request that fails twice is one piece of evidence. Any success
  resets the streak and re-arms the warning. A genuinely wrong credential still
  surfaces within a minute at the default 15 s poll; an isolated blip stays at debug.
- **64 KB reply cap**, aborted mid-stream. A real adapter answers ~1–2 KB; an
  unauthenticated LAN peer answering an unbounded body would otherwise grow the buffer
  without limit.

### Discovery

The cloud provides neither the unit's IP nor its MAC, so each unit is identified by
which adapter authenticates its token: the plugin enumerates the host's /24 and sends
every candidate IP a signed status read per unit — which puts a signed PUT on every
LAN host. `r.indoorUnit` in the reply is a match; `device_authentication_error` is a
Kumo adapter that is a different unit, so the sweep tries the account's other serials
at that IP; busy or unreachable proves nothing and leaves the IP eligible to be probed
again. The sweep runs **once, at
startup** — a unit powered off or on another subnet is missed until the next restart —
and a serial pinned in `localControlIps` skips it entirely (`discoverDeviceIps` /
`probeIpForSerial`, `src/local-api.ts`).

## REST, v2

A second, older backend, used ONLY as a bootstrap for LAN control: one POST at startup,
nothing else, nothing written back. Two reasons to reach for it — the v3 credential
removal above, and accounts v3 refuses outright.

| Region | Endpoint |
|---|---|
| Canada (`cloudRegion: "ca"`) | `POST https://mesca-prod.kumocloud.com/login/v2` |
| United States (`localCredentialSource: "v2"`) | `POST https://geo-c.kumocloud.com/login` |

**The host and the path both vary** — mesca answers `/login/v2`, geo-c answers `/login` —
which is why the option is a named region rather than a hostname. The body is
`{ username, password, appVersion: "2.2.0" }` and there is **no `X-App-Version` header**
(v2 carries the version in the body). Canadian accounts answer `POST /v3/login` with
**HTTP 500**, where a non-existent account gets 403, so the 500 is specific to an account
the v3 backend knows and does not serve. `mesca-prod` resolves to an ELB named
`mesca-kumo-green-west-arm-app` (mesca = Mitsubishi Electric Sales Canada).

The reply is an **array**; `root[2]` is the payload, plus one boolean from `root[1]`
(`parseV2Login`, `src/kumo-v2.ts`):

| Element | Contents | Read? |
|---|---|---|
| `root[0]` | `{ token, username, device, emailIsVerified }` — a 32-char session token, not a JWT | No |
| `root[1]` | Display preferences (`celsius`, `filterReminder`) | Only `celsius`, to seed HomeKit's `TemperatureDisplayUnits` (otherwise Fahrenheit for want of any source). Read defensively — a host that omits the element leaves it undefined — and nothing else in the element is retained |
| `root[2]` | The site tree. Each node may carry `zoneTable` (keyed by device serial) and `children` | **Yes** |
| `root[3]` | Absent on mesca; the string `"no device token"` on geo-c | No |
| `root[4]` | `userDetails` (name, phone, email) and `siteDetails` (postal addresses) | No |

`root[2].zoneTable` is `{}` in the live capture and the units sit in
`root[2].children[0].zoneTable`, so the walk recurses `children` at every level rather than
indexing a fixed depth. Per unit: `serial`, `label`, `mac`, `port` (80), sometimes
`address` (the LAN IP), `password`, `cryptoSerial`, `unitType` (`headless` is a Kumo
Station, not a thermostat), plus three blocks:

- `reportedProfile` — the capability profile, snake_case: `fan_speed_stages`,
  `has_auto_fan_speed`, `has_dry_function`, `display_setting_temp_of_dry`,
  `has_heat_function`, `has_ventilation_function`, `has_air_direction`,
  `has_swing_direction`, and **six** setpoint bounds (`minimum_heat_temp`,
  `minimum_cool_or_dry_temp`, `minimum_auto_temp` and their maxima). v2 shares one pair
  between cool and dry, which suits a client that routes the dry setpoint through
  `spCool`. The three floors genuinely differ on a unit with `has_extended_temp_range`:
  10 / 16 / 16 on the mapped account, 9 / 15 / 15 on another.
- `reportedCondition` — a cloud-lagged state snapshot (`room_temp`, `power`,
  `operation_mode`, `sp_heat`, `sp_cool`, `fan_speed`, `air_direction`,
  `status_display.filter`, `seconds_since_contact`) with a `more` block giving the
  human-readable label for each numeric field. It is often **completely empty**
  (`{_created, more: {}}`). Modes are numeric: `2` = dry is proven by
  `more.operation_mode_text: "Dehumidify"`; `8` = auto came from the live mapping
  session; `1`/`3`/`7` (heat/cool/vent) are corroborated by the Mitsubishi CN105 mode
  byte that 2 and 8 fit, but were not observed, and nothing else is guessed.
- `overrideSettings` — `{ heatMode, dryMode }`, apparently the cloud's counterpart of the
  local `userHasModeHeat`/`userHasModeDry`. `{}` in the pykumo samples, so only an
  explicit `false` is honoured.

Zone level also carries `minCoolSetpoint`/`maxHeatSetpoint` (installer limits, 0.5 °C
adrift from the profile's bounds in the samples, so not interchangeable with them) and
`autoModeEnabled`. Neither is used.

**What v2 does NOT have:** no socket, no streaming, no MQTT — nothing in the whole tree.
It is a bootstrap and cannot be a status source; the LAN poller is the only status path in
`cloudRegion: "ca"`. There is also no second v2 endpoint in use here: the login reply
carries everything, so nothing else is ever called.

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
