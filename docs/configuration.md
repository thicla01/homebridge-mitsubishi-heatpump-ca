# Configuration

Every option, and the mirroring guide. For the HomeKit side see the
[README](../README.md); for the wire protocol see [protocol.md](protocol.md).

## Minimal

```json
{
  "platforms": [
    {
      "platform": "KumoV3",
      "name": "Kumo",
      "username": "your-email@example.com",
      "password": "your-password"
    }
  ]
}
```

## Recommended

Add `disablePolling`. Streaming carries every update, and polling only starts if
streaming drops.

```json
{
  "platform": "KumoV3",
  "name": "Kumo",
  "username": "your-email@example.com",
  "password": "your-password",
  "disablePolling": true
}
```

With streaming healthy, the only recurring cloud request is the token refresh —
access tokens live 20 minutes and are refreshed 5 minutes early, so **4 requests per
hour** and nothing else. If streaming disconnects, 10-second polling starts by itself
and stops again on reconnect.

## Options

| Option | Type | Required | Description |
|---|---|---|---|
| `platform` | string | Yes | Must be `KumoV3` |
| `name` | string | Yes | Platform name. Defaults to `Kumo`, and the Homebridge UI pre-fills it |
| `username` | string | Yes* | Your Mitsubishi Comfort / Kumo Cloud email address. *Not required, and ignored, when `localOnly` is on |
| `password` | string | Yes* | Your Mitsubishi Comfort / Kumo Cloud password. Same exception as `username` |
| `cloudRegion` | `"us"` \| `"ca"` | No | Which backend serves your account (default `us`). `ca` signs in to the Canadian v2 host and never contacts v3 at all. See [Canadian accounts](#canadian-accounts-cloudregion-ca) |
| `localCredentialSource` | `"v3"` \| `"v2"` | No | Where the two per-unit LAN secrets come from (default `v3`, or `v2` when `cloudRegion` is `ca`). See [Where the LAN secrets come from](#where-the-lan-secrets-come-from) |
| `pollInterval` | number | No | Cloud poll interval in seconds while streaming is healthy (default 30). Below 5 the platform stays idle — see [Validation](#validation) |
| `disablePolling` | boolean | No | Recommended. Skip polling entirely while streaming is healthy; polling re-enables itself if streaming fails (default false) |
| `degradedPollInterval` | number | No | Poll interval in seconds while streaming is unhealthy (default 10) |
| `streamingHealthCheckInterval` | number | No | How often to check the Socket.IO connection state, in seconds (default 30) |
| `streamingStaleThreshold` | number | No | **Deprecated and inert.** Nothing reads it. Streaming health is decided by the Socket.IO connection state. Accepted so an existing config stays valid |
| `excludeDevices` | string[] | No | Device serials to hide from HomeKit. Serials appear in the log during discovery |
| `debug` | boolean | No | Verbose logging (default false). See [Debug](#debug) |
| `showHumiditySensor` | boolean | No | Expose indoor humidity as a `HumiditySensor` (default **true**). Turn off if humidity dominates the tile in the Home app |
| `showDrySwitch` | boolean | No | Add a per-unit Dry switch (default false). Added only on units whose profile reports dry |
| `showFanOnlySwitch` | boolean | No | Add a per-unit Fan-only switch (default false). This is fan-*only* mode; fan speed while heating or cooling is already on the main tile |
| `exposeVaneSlat` | boolean | No | Expose vane angles as a `Slats` service (default false). Apple Home files `Slats` under window coverings — see the warning in the [README](../README.md#vane-and-swing) |
| `localControl` | boolean | No | Control units over the LAN (default false). Needs a working secret source: with the default `v3` it cannot work — see [Where the LAN secrets come from](#where-the-lan-secrets-come-from) |
| `localPollInterval` | number | No | Seconds between LAN status polls when `localControl` is on (default 15) |
| `localControlIps` | object | No | `{ "<deviceSerial>": "<ip>" }` to skip LAN discovery for specific units. **JSON editor only** — see [UI coverage](#ui-coverage) |
| `localOnly` | boolean | No | Run entirely on the LAN and never contact the cloud (default false). Requires `localDevices`; makes `username`/`password` unnecessary. See [Local-only mode](#local-only-mode) |
| `localDevices` | array | No | The units to control when `localOnly` is on, each with `deviceSerial`, `ip`, `password`, `cryptoSerial` and optional capability fields. `localPollInterval` applies here too |
| `mirror` | array | No | `{ source, target }` device-serial pairs. See [Device mirroring](#device-mirroring) |

### Validation

Credentials and `pollInterval` are checked at startup, in `validatePlatformConfig`
(`src/platform.ts`). A bad value is **rejected, not clamped**: `pollInterval` must be a
number and at least 5, the username must contain `@`, and the password must be a non-empty
string. `localPollInterval` has the same floor of 5.

With `localOnly` on, the credential checks are replaced rather than added to — that mode
never signs in — and `localDevices` is checked instead: it must be a non-empty array, and
every entry needs a `deviceSerial` (unique across the array), an `ip`, a non-empty
`password`, and a `cryptoSerial` of at least 18 hex characters. The `cryptoSerial` is
matched as hex rather than merely decoded, because a decode stops at the first bad
character: a truncated paste with 18 valid characters in front of the damage would
otherwise be accepted here and then fail every LAN request as an opaque authentication
error.

`cloudRegion` and `localCredentialSource` are checked too, and a misspelling is
**rejected rather than defaulted**: `"cloudRegion": "can"` silently meaning `us` would
point a Canadian account at the v3 endpoint that answers it HTTP 500 forever, with
nothing in the log to say why. Case and surrounding whitespace are forgiven (`"CA"`,
`" ca "`), and the value is normalised once, before anything reads it.

Contradictory combinations split two ways, on whether the contradiction has exactly one
possible resolution.

**Three are absorbed with a warning**, by `reconcileImpliedConfig` (`src/platform.ts`),
which runs *before* the validator, deletes the contradicting value, and lets the platform
start:

| Absorbed | Resolution |
|---|---|
| `cloudRegion: "ca"` + `localCredentialSource: "v3"` | v3 answers those accounts HTTP 500 and can never serve them, so the `"v3"` is dropped and v2 used |
| `cloudRegion: "ca"` + `localControl: false` | The LAN is the only transport in that region, so the `false` is dropped and LAN control left on |
| `localCredentialSource: "v2"` + `localControl: false` | The v2 source exists only to feed LAN control, so the `false` is dropped likewise |

The mechanism exists because the Homebridge UI **materialises every schema `default` into
`config.json` when the settings form is saved**, so an untouched field arrives looking
exactly like a deliberate choice. While these three were fatal, merely opening the
settings page of a working Canadian install and pressing Save wrote
`localCredentialSource: "v3"` into the config and idled the platform on the next restart
— observed on real hardware, 2026-08-19. No amount of care in the schema fully fixes
that, because the UI is free to write whatever it likes; the runtime has to absorb it.
The cost is that reconcile cannot tell a UI-manufactured value from one you typed — an
explicit `"v3"` under `cloudRegion: "ca"` is overridden with the same warning. Each
warning names the dropped value and how to silence it (delete the key in the config
editor).

**The rest stay fatal**, because more than one resolution is defensible and refusing to
start is the safe answer:

| Rejected | Why |
|---|---|
| `cloudRegion` other than `us`/`ca` | Nothing else names a backend |
| `localCredentialSource` other than `v3`/`v2` | Same |
| `localOnly: true` + `localCredentialSource: "v2"` | `localOnly` promises no cloud contact of any version. You either want no cloud (drop the v2 source) or want the secrets fetched (drop `localOnly`), and guessing wrong either exposes credentials or silently controls nothing |

`cloudRegion: "ca"` *implies* the v2 credential source and local control when the keys
are simply **absent** — so the intended Canadian config is `username`, `password` and
`cloudRegion`, and nothing else. That absence is load-bearing for
`localCredentialSource`: an absent key means "whatever the region implies", and only a
written value can collide with it. This is why `config.schema.json` no longer declares
a `default` for `localCredentialSource` — the behaviour is unchanged (v3 is still the
default, applied at runtime), but the UI has nothing to materialise into a spurious
explicit `"v3"`. The per-unit capability fields under `localDevices` lost their schema
defaults for the same reason; their runtime defaults are in the
[local-only table](#local-only-mode) below.

Two combinations are accepted with a **warning** without any value being touched,
because an inert option cannot misbehave: `cloudRegion` alongside `localOnly` (no cloud
of any version is contacted, so it does nothing), and a non-empty `localDevices` without
`localOnly` (only read in that mode).

When a fatal check fails, the platform logs a single error naming the problem and then
**stays idle** — it registers no accessories and starts no timers. Homebridge itself keeps
running and your other plugins are untouched. Fix the value in the Homebridge UI and
restart; nothing else needs cleaning up.

The minimum and maximum values on `degradedPollInterval` and
`streamingHealthCheckInterval` live in `config.schema.json` only. The Homebridge UI form
enforces them; nothing clamps at runtime, so a value written straight into `config.json`
is used as-is. `localPollInterval` is the exception: its floor of 5 is enforced at
runtime by `validatePlatformConfig` (only its maximum of 120 is schema-only), because
local-only configs are routinely hand-edited — the form cannot express `localDevices`'
secrets — and a negative value would reach `setInterval`, which Node clamps to 1 ms:
the local poller would then hammer the adapter without pause.

### UI coverage

**Every option renders in the Homebridge UI form**, and that is deliberate rather than
tidy: an option the form cannot render is an option it DROPS. The UI rewrites the platform
block from the schema when you save the settings page or reinstall the plugin through it,
and anything the schema does not describe as a field goes with the rewrite — silently.

A pinned address is only as good as the route to it: it must be reachable **from the
machine running Homebridge**, which is frequently not the machine you are configuring
from. A pinned unit is never swept for, so an address that is wrong or unroutable does
not fall back to discovery — it surfaces as `no answer from <unit>` at the next restart.
If the unit sits on another VLAN, confirm the route from the Homebridge host first
(`ping <ip>`, then `nc -vz <ip> 80`); inter-VLAN routing is a router matter that no
setting here can substitute for.

`localControlIps` learned this the hard way. It used to be a free-form
`{ "<serial>": "<ip>" }` map with a help block telling you to use the JSON editor, and on
2026-08-21 a plugin reinstall through the UI removed a working pin: the startup LAN sweep
came back, with nothing in the log to say why. It is now a list of serial/address pairs,
which the form can render. **The runtime still accepts the old map shape**, so an existing
config keeps working and the JSON editor stays usable — but a value entered through the
form is written as the array.

`cloudRegion` renders as a dropdown next to the credentials, and
`localCredentialSource` as one inside **Local Control**, hidden when `cloudRegion` is
already `ca` (where the value is implied and setting it could only create the
contradiction above).

`localOnly` and `localDevices` do render, under **Local-only Mode (no cloud)**. The unit
list appears once `localOnly` is ticked, and ticking it also hides the cloud credential
fields, which are unused in that mode. `username` and `password` are consequently no
longer in the schema's root `required` array — the form cannot express a conditional
requirement — so the credential rule is enforced only at startup by
`validatePlatformConfig`, which knows which mode is in play.

### Restart scope

`localControl`, `localOnly`, `cloudRegion`, `localCredentialSource` and `mirror` are read
from the **parent** Homebridge config rather than the child bridge's, so changing any of
them needs a full Homebridge restart.
Restarting just the child bridge will not pick them up.

### Debug

`debug: true` logs API requests and responses with timings, raw zone and device payloads,
streaming updates, and token refreshes. It can log sensitive values, so keep it off except
while troubleshooting. The plugin warns on startup when it is on.

**One exception is unconditional: nothing from a v2 sign-in is ever logged, at any level,
`debug` included.** That reply carries every unit's local `password` and `cryptoSerial` in
clear text, a session token, and the account holder's name, phone number, email address
and every site's postal address. The parser reads only the site tree and never even looks
at the elements holding the personal data, the type it returns structurally cannot hold a
secret, and a failed sign-in logs a status code and a host name rather than the response
body. `test/v2-log-redaction.test.ts` asserts this with `debug: true`, first proving the
sentinel values really are in the payload so the test cannot pass by finding nothing, and
it checks `accessory.context` as well — that is written to disk in
`accessories/cachedAccessories.<username>`.

## Where the LAN secrets come from

Controlling a unit over the LAN needs two secrets per unit: the adapter's `password`
(base64) and its `cryptoSerial` (hex). Around **2026-07-31 the v3 cloud stopped serving
both** — the password vanished from the `adapter_update` socket event and the cryptoSerial
from `GET /devices/{serial}/status` ([pykumo #78](https://github.com/dlarrick/pykumo/issues/78),
reproduced on unrelated accounts and on a second client stack, so it is a cloud-side
change). With the default `localCredentialSource: "v3"`, `localControl: true` therefore
achieves nothing and everything runs over the cloud.

`localCredentialSource: "v2"` fixes that by signing in **once at startup** to the older v2
login — `https://geo-c.kumocloud.com/login` for `cloudRegion: "us"` — and reading the two
secrets from the reply. This is the same fallback Home Assistant's `mitsubishi_comfort`
integration adopted in v0.5.2. It implies `localControl`.

```json
{
  "platform": "KumoV3",
  "username": "your-email@example.com",
  "password": "your-password",
  "localCredentialSource": "v2"
}
```

What that costs and does not cost:

- **One POST**, at startup and on a bounded retry schedule with a 15-minute floor (a
  sign-in reply is complete, so re-asking sooner cannot produce anything new). A refused
  sign-in (401/403) is reported once and **not** retried, because repeating it risks
  locking the account.
- **Nothing is written back.** The secrets live in memory for the life of the process;
  `config.json` is never rewritten and no secret is cached to disk. A restart signs in
  again — which also means local control returns by itself if the vendor ever restores
  the v3 fields.
- **Nothing is logged.** See [Debug](#debug).
- **Verification status:** the Canadian reply was mapped live on 2026-08-18. The US host
  is inherited from Home Assistant's implementation and is *not* re-verified here.

## Canadian accounts (`cloudRegion: "ca"`)

`POST /v3/login` answers **HTTP 500** for accounts served by Mitsubishi Electric Sales
Canada — as against the 403 a genuinely wrong password gets — so the v3 API cannot be used
for them at all. They live on `https://mesca-prod.kumocloud.com/login/v2`.

```json
{
  "platform": "KumoV3",
  "name": "Kumo",
  "username": "your-email@example.com",
  "password": "your-password",
  "cloudRegion": "ca"
}
```

That is the whole configuration. One v2 sign-in supplies the unit list, each unit's room
name, its **real capability profile** and the two LAN secrets; control then runs entirely
over the LAN. Nothing is declared by hand and no secret goes into `config.json`.

- **The v3 API is contacted on no path**: no login, no streaming, no zone polling, and no
  cloud fallback for a command the LAN refuses. The kill switch is the same one `localOnly`
  arms, and it lives in the transport rather than at the call sites.
- **Every unit must be reachable on your LAN.** Units whose address the reply carries are
  used directly; the rest are found by the usual token-matching sweep of the host's /24
  (5-30s once, at startup). Give each unit a **DHCP reservation**, or pin it with
  `localControlIps`, which takes precedence over the address the cloud reported. The sweep
  runs **once, at startup**: a unit that was powered off during it is named in a warning
  and picked up at the next Homebridge restart.
- **The real profile is the practical gain over `localOnly`.** v2 reports three setpoint
  floors, and they differ on a unit with the extended temperature range: 10 °C for heating
  against 16 °C for cooling on the mapped account. A hand-declared `minSetPoint` is one
  number for all three modes, so it publishes the heating floor as 16 °C (60.8 °F) — and
  HomeKit **rejects** a write below the published minimum rather than clamping it, so
  "hold 50 °F while away" becomes unaskable. Capability flags (dry, vent, vane, swing, fan
  speeds, whether dry accepts a setpoint) are discovered the same way.
- **The Dry and Fan tiles stay opt-in** here, unlike in `localOnly`. There the capability
  is something you wrote by hand for one unit; here it is discovered, and both are true on
  ordinary hardware — so `showDrySwitch` / `showFanOnlySwitch` decide, as on the cloud path.
- **What it gives up against a working v3 account:** streaming (status comes from the LAN
  poll, default 15s), the cloud's "not responding" detection, and paired-sensor battery
  readings. Indoor humidity still works — the LAN client reads it from the unit's sensor or
  MHK2 in the same poll. `pollInterval`, `disablePolling`, `degradedPollInterval` and
  `streamingHealthCheckInterval` are inert and warned about.
- **v2 is a bootstrap, not a status source.** There is no socket, no streaming and no MQTT
  anywhere in the v2 tree, so the LAN poller is the only status path in this mode.

## Local-only mode

`localOnly: true` controls every unit over the LAN and contacts the cloud on **no** path:
no login, no site or zone fetch, no streaming, and no per-unit cloud fallback for a command
the LAN refuses. It exists for the two cases where the cloud cannot bootstrap local
control — accounts served by the Canadian v2 backend, which the v3 login rejects outright,
and the 2026-07-31 removal of the per-device secrets from v3 — and it needs those secrets
supplied by hand.

**If your account is Canadian, use [`cloudRegion: "ca"`](#canadian-accounts-cloudregion-ca)
instead** — it fetches the same values by itself, including each unit's real profile, and
keeps no secret in `config.json`. Local-only mode is now for running with no cloud contact
whatsoever: an isolated VLAN, a deliberately offline install, or an account no endpoint
serves.

**[README → Local-only mode](../README.md#local-only-mode)** covers where to obtain them,
a full worked config, and what the mode gives up (indoor humidity, profile-sourced
setpoint limits, and "not responding" detection). The per-unit fields:

| Field | Required | Description |
|---|---|---|
| `deviceSerial` | Yes | The adapter's serial. Keys the accessory's HomeKit identity, so it must match what a cloud setup used if you are switching over |
| `ip` | Yes | The unit's LAN address. Give it a DHCP reservation |
| `password` | Yes | Adapter local password, base64 |
| `cryptoSerial` | Yes | Adapter cryptoSerial, hex, ≥ 18 characters |
| `name` | No | HomeKit name. Defaults to the serial |
| `hasModeDry` / `hasModeVent` | No | Declares the unit's dry / vent capability (default false). In local-only mode the declaration also adds the switch tile — it is the only way to reach either mode, since `HeaterCooler` has no state for them. `showDrySwitch` / `showFanOnlySwitch` set explicitly to `false` still suppress it, and the log says so once |
| `hasModeHeat` | No | Default true. False removes Heat and Auto from the mode picker |
| `usesSetPointInDryMode` | No | Default true. Routes the dry setpoint through `spCool` |
| `hasFanSpeedAuto`, `hasVaneDir`, `hasVaneSwing` | No | Default true. Over-declaring one costs an inert control: the adapter answers 200 to a write it does not support and ignores it |
| `numberOfFanSpeeds` | No | Advisory only — all five named speeds are offered regardless |
| `minSetPoint` / `maxSetPoint` | No | Setpoint bounds in °C, default 16 / 31. These replace the cloud profile's range, so they should match the unit's own installer limits |

`excludeDevices` still applies, and still means "hide from HomeKit". Excluding *every*
declared unit is treated as a configuration mistake rather than a transient failure: it is
logged once and not retried, and cached accessories are left registered so a typo cannot
cost you your room assignments.

## Device mirroring

Make one unit **follow** another. Useful when a unit has no wall control and you want it
to shadow one you actually operate.

Serials appear in the log during device discovery.

```json
{
  "platform": "KumoV3",
  "username": "user@example.com",
  "password": "password123",
  "mirror": [
    { "source": "KITCHENSERIAL", "target": "LIVINGROOMSERIAL" }
  ]
}
```

How it behaves:

- **One-way.** The target follows the source; the source is never affected by the target.
- **Full state on every source change** — mode (heat / cool / auto / dry / vent / off),
  the setpoint(s), on/off, and fan speed.
- **Any control path triggers it.** It follows the source's *actual* state, so changing
  the source from its wall thermostat, the Comfort app, or HomeKit all mirror across.
  HomeKit changes mirror in about a second; wall and app changes mirror when the plugin
  next reads the source.
- **Manual target changes stick** until the source changes again, at which point the
  target re-syncs. Because any source change re-applies the *full* state, nudging only the
  source's temperature will also turn a manually-off target back on.
- **Safe across different units.** Setpoints are clamped to the target's own supported
  range, and a mode the target cannot do is skipped.

One source can drive several targets — add one entry per target. Vane direction, room
temperature and humidity are **not** mirrored; those are readings, not settings.

Why this lives in the plugin rather than in a HomeKit automation or a generic mirror
plugin: see the header comment in `src/mirror.ts`.
