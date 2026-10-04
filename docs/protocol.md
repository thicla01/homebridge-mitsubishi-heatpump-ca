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
| `GET /devices/{serial}/status` | Read `cryptoSerial`, and only that — the neighbouring `cryptoKeySet` is left alone, see below. Connection state comes from the zones payload, not from here |
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

**Nor does the unit enforce an AUTO deadband.** The vendor app's own controls keep `spHeat`
and `spCool` at least **1.5 °C** apart, and they do it by pushing the *other* edge — one way
only. Raising `spHeat` from 22 to 22.5 against an `spCool` of 23.5 pushed `spCool` to 24;
lowering `spHeat` back to 22 left `spCool` at 24. The app does not remember where the other
edge was, so a nudge on one edge has to be undone on both. The unit enforces nothing. Measured 2026-09-27 on a GX15 over the LAN: a drag in the Home app sent `spCool`
22.5 against an `spHeat` of 22.0 — a 0.5° band, the narrowest the 0.5° grid allows — and the
adapter accepted it, then 23.0. The tile, which follows the LAN reading once the 4 s
post-write hold lapses, showed exactly those values. The Home app allows the narrow band as
well, so nothing between HomeKit and the compressor enforces the vendor's minimum.

The vendor app does not re-impose the minimum on what the unit reports — it displayed the
unit's 1° band as is — but it **lags** the unit: for several minutes, and across an app
restart, it went on showing an earlier `spCool` of 23.5 after the unit had moved on to 23.
The other direction is prompt: a band set in the vendor app reaches the unit through the
cloud and shows up on the tile at the next LAN poll, within one 15 s cycle — verified the same
day. So the lag is in what the app displays, not in what it sends. When the two disagree,
the LAN reading is the unit's actual state.

**Since 2.3.7 this plugin keeps the vendor's minimum in AUTO**, the vendor's way: an edge
moved into the band pushes the other one away, one way only (`temperature.ts:
enforceAutoBand`). Two departures from the app, both deliberate. When a scene or a Shortcut
moves both edges at once — which the app cannot do — heating is protected and cooling
yields. And outside AUTO nothing is pushed: the other edge is invisible in the
single-setpoint modes, so a push there would rewrite a setting the user cannot see (a dry
target of 23.9 against heating at 23 would have moved heating to 22.3). The price of that
second choice: a band left narrow or inverted from a single-setpoint mode is not corrected
on entering AUTO, only the first time an edge moves there.

The subtle part is concurrency, and it is why this was not a one-liner. A scene sets both
edges in one concurrent burst, so an edge measured against the other's *cached* value is
measured against a stale one: moving 21/22.5 to 23/26, the heating writer would push
cooling to 24.5 from the old 22.5, and if that landed last the scene would end at 23/24.5 —
the upstream AUTO band collapse (PR #23) by another road. The decision is therefore taken
after the 1.5 s write hold, against the other edge's *pending* value, which every writer
registers before its first await (`accessory.ts:keepAutoBand`). What a sub-1.5° band does
to the unit's own control loop remains unmeasured.

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

### The whole local surface, enumerated

A read is an empty leaf the adapter fills in, so a **parent asked empty enumerates its
children**. That works one level down and not at the root: `{"c":{}}` answers
`{"": "__invalid_api_request"}`, while `{"c":{"adapter":{}}}` and
`{"c":{"indoorUnit":{}}}` return everything beneath them. Measured on a GX15 (firmware
`03.07.03`, hardware `00.00.03`) on 2026-10-03 with `tools/kumo-probe.mjs`. The plugin
reads three of these nodes; the rest is recorded so nobody has to guess again.

`adapter`:

| Child | Contents |
|---|---|
| `status` | Mutable settings: `localNetwork.stationMode.{RSSI,SSID}`, `name` (the zone name, stored in the module), `runState` (`"reboot"` is what a write would set), `uptime` (seconds), `roomTempOffset`, `ledDisabled`, `receiverRelay`, `autoModePrevention`, `userHasModeDry` / `userHasModeHeat`, `userMinCoolSetPoint` / `userMaxHeatSetPoint`, `serverHostname` — `geo-rev2-b.kumocloud.com` on this unit, a host that appears nowhere else here — and `password` |
| `info` | Immutable identity: `macAddress`, `serialNumber`, `firmwareVersion`, `hardwareVersion`, `isTestMode` |
| `led` | Two LEDs, each `{onPeriod, offPeriod, count, delay, repeat}`, all `__ungettable` |
| `localNetwork` | Refuses as a node (`__invalid_api_request`) even though `status.localNetwork` reads fine |

`indoorUnit`:

| Child | Contents |
|---|---|
| `status` | What the poller reads |
| `profile` | The capability profile — see below |
| `initialSettings` | 31 numbered slots, all `0` on this unit, whose `profile.hasInitialSettings` is `false`. Almost certainly the installer function codes |
| `schedule` | `events` 1-28, each `{active, inUse, day, time, settings:{mode, spCool, spHeat, vaneDir, fanSpeed}}` — the unit has its own scheduler |
| `errorHistory` | `errors` 1-10, each `{error2char, error4char, timestamp}` |
| `prohibits` | `global` / `local` / `effective`, each `{power, mode, setpoint}` — lockouts. Those three are exactly the local operations Mitsubishi's remote-controller literature says a **central controller can prohibit on the local remote** (PAC-YT52CRA, PAR-31MAA, PAR-U02MEDA; a CENTRAL icon shows while they are). Whether the Wi-Fi adapter counts as a local remote, and so is itself refused, or acts as the central side, is **not known**. **Read by the plugin** since 2.3.8: at the first good poll and every 30 minutes, warning when `effective` changes and qualifying the log of any command that touches a locked control. Never enforced — see `src/prohibits.ts` |
| `settings` | `rawITPFrame {frame, len, id}`: a raw-frame passthrough to the indoor unit |
| `info` | `{}` |
| `acoil` | `__action_failed` |

**Three refusal markers, with different meanings.** `__invalid_api_request` — not a thing
you may ask for, used for a whole node and for the `password` field. `__ungettable` — the
field exists and cannot be read (every LED timing). `__action_failed` — the read was valid
and did not work (`acoil`). They are values inside `r`, not `_api_error` codes, so a client
that only checks for `_api_error` takes them for data.

**`cryptoSerial` appears nowhere.** Not in either enumeration, at any depth. The adapter
does not expose it, so the LAN secrets cannot be recovered from the device through this
API — which is now a statement about the whole surface rather than about five nodes.

**The `password` in `adapter.status` is most likely the LAN API password**, held
write-only. The evidence is structural rather than measured. The cloud's v2 record for a
unit (pykumo's `examples/server-config-nozones-sanitized.json`, values redacted there)
keeps that unit's LAN `password` among the same neighbours this node has — `roomTempOffset`,
`ledDisabled`, the user caps (as `minCoolSetpoint` / `maxHeatSetpoint`), an auto-mode flag
(`autoModeEnabled`), the mode switches (`overrideSettings`), `rssi` — while the **wifi**
credentials are a separate, site-level object, `network {name, password}`. On the adapter,
the wifi side plausibly lives under `localNetwork`, the node that refuses as a whole.

That same cloud record also holds `cryptoSerial` and `cryptoKeySet`, and neither appears
anywhere on the adapter's surface. So the answer to "why a password but no cryptoSerial"
is that the adapter's settings include the password the app provisions, and the crypto
identity was never one of them — it is held cloud-side. This reverses the reading recorded
here when the field was first seen (that it was probably the wifi password). Still an
inference from shapes: do not cite it as proof.

**Two things worth not touching.** `settings.rawITPFrame` is a passthrough to the indoor
unit's own serial protocol — the deepest write surface on the device, and nothing here
goes near it. `initialSettings` is where the installer function codes live, including the
setpoint limits that [What does not exist](#what-does-not-exist) concluded no API could
change: that conclusion was reached against the **cloud**, and these slots are on the
adapter. Writing them unmeasured is how a unit ends up with limits nobody intended.

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

**Both ends hold the same value, and which way it got there is unknown.** The adapter
must know both secrets — it recomputes the token to verify every request — and the cloud
plainly knows them too, since it serves them. Nothing observed so far distinguishes "the
module generates them and uploads them" from "the cloud generates them and pushes them
during provisioning"; every measurement below fits either. Two weak hints lean toward a
scheme defined vendor-side rather than produced by the device: `W_PARAM` is a single
32-byte constant shared by **every** unit (hardcoded here and in pykumo, and it works for
everyone), and `cryptoKeySet` reads as a named key *family* rather than a per-device
value — see below.

Worth stating because it is tempting to reason from: if the secrets originated in the
module, one might hope to read them back out of it over BLE or CN105. Nobody has. The
practical position is the same under either model — the cloud is the only counter, which
is what `exportLocalSecrets` exists for.

They belong to the **Wi-Fi adapter**, not to the indoor unit. On a model with an
integrated module that is still a separate board (CN110 here, distinct from the CN105
interface port); replacing it starts from nothing.

"Stable" is now measured rather than assumed, which matters to anyone keeping a copy
(`exportLocalSecrets`). On [pykumo #78](https://github.com/dlarrick/pykumo/issues/78) a v2
reply fetched 2026-09-12 matched a capture taken the day before the 2026-07-31 cutoff
**byte for byte** across four units, then authenticated live; and a credential restored
from a backup still authenticated weeks after. The secrets were **withheld from the API,
not rotated**.

A plausible reason the v3 API could withhold them at no cost to its own app: the Comfort
app does not use the per-device password at all. An analysis of the decompiled app
([KTibow/comfort-decompilation](https://github.com/KTibow/comfort-decompilation), April
2025) describes it authenticating through the cloud with a key built into the app,
combined with the `cryptoSerial`, a "crypto slot" and a one-time challenge — where the
Kumo Cloud app used the device-specific password over the LAN, as this plugin does. v3 is
the Comfort app's backend, so the password was vestigial there. That analysis is the
source for the mechanism; nothing in this plugin uses, or should use, the built-in key,
which is the same in every copy of the app.

What is NOT known is what a full re-pairing does. Nobody has measured it, and it is the
only moment at which the two ends could come to hold the same value (the `⌐3` Bluetooth
provisioning session), so it is the one plausible trigger. Two cheap hardware-derivation
hypotheses were tested against a real unit on 2026-09-19 and **both failed**: the
cryptoSerial is neither the adapter's serial number in ASCII (its hex digits spread across
`0`-`e`, where ASCII of an alphanumeric serial would cluster on `3`/`4`/`5`) nor the
module's MAC. It is an assigned value. Treat a re-pairing as invalidating any stored copy.

### `cryptoKeySet`

`GET /devices/{serial}/status` returns a `cryptoKeySet` immediately after the
`cryptoSerial`, and the v2 zone entry carries one too (both observed; the field is part of
the shape `test/v2-fixture.ts` was built from, though every VALUE in that file is
invented). Nothing here reads it.

Its meaning is undocumented anywhere. A GitHub-wide search returns only false positives,
and pykumo's own `Cloud_api_v3.md` — the one place the field appears in writing — prints it
literally as `"F"` while redacting the `cryptoSerial` beside it, so its author evidently
treats it as non-secret. Two observations seventeen months and two backends apart both show
`"F"`.

Worth recording rather than acting on: a named key *set* is the vocabulary of a value
**selected from a family**, not derived from hardware, which agrees with the two failed
derivation tests above. If the letter is the same for everyone it is a scheme identifier
rather than a per-device marker — and therefore *not* a canary that would reveal a
regenerated secret, which is the thing that would actually be useful.

A possible counterpart, unconfirmed: the Comfort app analysis cited above names a "crypto
slot" that goes into its authentication alongside the `cryptoSerial`. A slot selected from
a set is what `cryptoKeySet` sounds like. Same caution as the rest of this section — a
name, not a measurement.

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
| `{"c":{"mhk2":{"status":{}}}}` | An MHK2 wall thermostat; `indoorHumid` is the only field read, though the node also carries `outdoorTemp` and `outdoorHumid` |
| `{"c":{"indoorUnit":{"profile":{}}}}` | The unit's own capability profile — see below |

They are queried only while the unit reports a `tempSource`/`activeThermistor` of
`sensorN`; a unit that yields neither is latched and not asked again until its
temperature source changes (`getSensorReadings`, `src/local-api.ts`). The sensor leaf
also carries `rssi`, `txPower` and **`battery`** — which the README has long called the
one sensor reading local control gives up. Unverified either way: the account this was
measured on has no paired sensor, so every field came back null.

### The capability profile, from the adapter

`{"c":{"indoorUnit":{"profile":{}}}}` answers the unit's own profile, and it is the same
one the v2 cloud serves — field for field, measured on a GX15 on 2026-10-03 with
`tools/kumo-probe.mjs`:

```json
{ "hasModeDry": true, "hasModeHeat": true, "hasModeVent": true, "hasVaneDir": true,
  "hasVaneSwing": true, "hasFanSpeedAuto": true, "numberOfFanSpeeds": 5,
  "usesSetPointInDryMode": true, "hasDefrost": true, "hasStandby": true,
  "extendedTemps": true, "hasHotAdjust": true, "hasInitialSettings": false,
  "hasModeTest": false,
  "minimumSetPoints": { "cool": 16, "heat": 10, "auto": 16 },
  "maximumSetPoints": { "cool": 31, "heat": 31, "auto": 31 } }
```

Note the three distinct floors. A hand-declared `localDevices` entry carries ONE
`minSetPoint` for every mode, so it publishes the cooling floor as the heating floor —
and HomeKit rejects a write below a published minimum rather than clamping it, which is
what makes "hold 10 °C while away" unaskable (docs/configuration.md). The adapter knows
all three. `platform.ts:refineProfilesFromAdapter` therefore reads this node for any unit
whose profile is the config-assembled stand-in, and leaves a v2-discovered profile alone —
they agree, and a second startup request is not free on an adapter that holds about one
connection.

Two fields are **not** adopted from it: `hasModeDry` and `hasModeVent`. In `localOnly`
those two do double duty — they describe the hardware AND opt into the Dry / Fan-only
tiles, because `wantsModeSwitch` defaults to true in that mode, so the profile flag is the
only gate. Both are true on ordinary hardware, so adopting them would hand two switches to
every local-only install on upgrade. `extendedTemps`, `hasHotAdjust`, `hasInitialSettings`
and `hasModeTest` are read but unmodelled.

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
`address` (the LAN IP), `password`, `cryptoSerial`, `cryptoKeySet` (unread — see
[`cryptoKeySet`](#cryptokeyset)), `unitType` (`headless` is a Kumo Station, not a
thermostat), plus three blocks:

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
