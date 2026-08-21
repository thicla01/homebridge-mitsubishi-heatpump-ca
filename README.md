# Homebridge Mitsubishi Heat Pump

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

HomeKit control for Mitsubishi ductless heat pumps (MLZ / MSZ) through the Mitsubishi
Comfort v3 cloud API, with optional direct LAN control.

Each unit is a **HeaterCooler** with its fan on a linked Fan service: power, mode,
setpoints, fan speed and vane swing all on one tile.

Not affiliated with, endorsed by, or associated with Mitsubishi Electric. **Use at your
own risk** — this drives real heating and cooling equipment, and the author assumes no
liability for damage or loss arising from it.

> **This is a fork.** It adds support for Canadian accounts, which the v3 cloud API
> cannot serve — they are served by `mesca-prod.kumocloud.com` over the older v2
> protocol instead. With `cloudRegion: "ca"` the plugin signs in there once at startup
> for the unit inventory, the real capability profile and the per-unit LAN secrets,
> then controls everything over your LAN and never contacts v3 at all.
>
> Upstream is [ukaratay/homebridge-mitsubishi-heatpump](https://github.com/ukaratay/homebridge-mitsubishi-heatpump),
> forked at v2.2.1. Files have been modified; see `NOTICE` for the statement of changes
> required by Apache-2.0 section 4(b), and `CHANGELOG.md` for the full list.

## Features

- **One tile per unit.** On/off, Heat / Cool / Auto, and the setpoint for the active
  mode. Auto shows a two-handle band.
- **Fan speed on the tile** — five real speeds plus fan-auto, on a linked Fan service.
- **Vane control** — swing on the main tile, discrete tilt angles through an opt-in
  `Slats` service.
- **Fahrenheit-anchored setpoints.** Every setpoint is stored as the exact Celsius of a
  whole °F, so the Home app and the Comfort app show the same number.
- **Wireless sensor support.** Units with a paired sensor report its finer temperature
  and humidity, plus battery level with a low-battery warning.
- **Real-time streaming** over Socket.IO, with adaptive polling that starts only when
  streaming fails.
- **Device mirroring** (opt-in) — make one unit follow another.
- **Local LAN control** (opt-in) — the v3 cloud no longer serves the two per-unit secrets
  it needs, so the plugin can fetch them from the older **v2 cloud** instead, which also
  serves the **Canadian accounts** v3 rejects outright. A **local-only mode** works from
  credentials you supply, with no cloud contact at all. See below.

## Installation

Requires **Node.js 20 or newer** and **Homebridge 1.6.0+, including 2.x**.

```bash
npm install -g homebridge-mitsubishi-heatpump
```

From source:

```bash
git clone https://github.com/ukaratay/homebridge-mitsubishi-heatpump.git
cd homebridge-mitsubishi-heatpump
npm install && npm run build && npm link
```

Then add your credentials — see **[Configuration](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/docs/configuration.md)** for the
minimal config and every option.

## Migrating from homebridge-mitsubishi-comfort

This is a hard fork of
[homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
at v1.8.2. It keeps the config `platform` key `KumoV3` and still derives accessory UUIDs
from the device serial, so **your existing `config.json` works unchanged and your
accessories keep their identity**.

| Thing | Survives? |
|---|---|
| `config.json` platform block | ✅ `platform` is still `KumoV3` |
| Child-bridge pairing | ✅ pairing lives at the bridge, `_bridge.username` untouched |
| Room assignment, names, Favorites | ✅ accessory UUID derives from `deviceSerial` |
| `mirror` config | ✅ keyed on device serial |
| **Automations, scenes, Shortcuts** | ❌ **these break** |

### What breaks

The primary service changed from `Thermostat` to `HeaterCooler`. HomeKit binds automations
to a *service and characteristic instance*, not to the accessory, so **every automation,
scene, trigger or Shortcut that referenced the old thermostat stops working and must be
rebuilt**. The accessory is still there under the same name in the same room; only the
controls beneath it are new. There is no way to migrate these automatically.

### Upgrade steps

1. **Stop Homebridge.** `sudo hb-service stop`
2. **Uninstall the old plugin from the command line**, not the Homebridge UI:
   ```bash
   sudo hb-service remove homebridge-mitsubishi-comfort
   ```
   > ⚠️ **Not via the Homebridge UI.** Its uninstall dialog defaults to "remove config",
   > which deletes the whole platform block *including* `_bridge.username`. Losing that
   > changes the child bridge's identity and forces you to re-pair every unit.
3. **Install this plugin.** `sudo hb-service add homebridge-mitsubishi-heatpump`
   > ⚠️ **Never have both installed at once.** Two plugins registering the `KumoV3`
   > platform makes Homebridge throw an ambiguous-platform error, which it swallows into a
   > misleading "Could not find the associated plugin" and drops your accessories.
4. **Start Homebridge.** `sudo hb-service start`
5. Rebuild your automations and scenes against the new tiles.

## Modes and switches

`HeaterCooler`'s target mode is only Heat / Cool / Auto — on/off is a separate `Active`
characteristic, and there is no state for dehumidify or fan-only. So:

- **On/off is independent of mode.** Turning a unit off does not change which mode it
  returns to.
- **Setpoints are the two thresholds.** The Home app shows the heating threshold in Heat,
  the cooling threshold in Cool, and both as a band in Auto. Modes the unit's profile says
  it cannot do are removed from the picker.
- **What the unit is doing is reported honestly:** heating, cooling, or **idle** when the
  compressor is in standby or the unit is in fan-only.
- **Fan speed and fan-auto** are on a linked Fan service — five speeds at 0 / 25 / 50 /
  75 / 100 on the slider, plus Auto on units whose profile has it.
- **Dry** and **Fan-only** are opt-in switches (`showDrySwitch`, `showFanOnlySwitch`),
  added only on units that support them, and mutually exclusive. Dry reports as Cool,
  where its setpoint genuinely lives. Changing fan speed while heating or cooling needs no
  switch.
- **Indoor humidity** is a HumiditySensor, on by default. Turn it off if the Home app's
  collapsed tile shows humidity where you wanted temperature.
- **Filter indicator** appears when the unit reports its filter needs cleaning.

> **Note:** HomeKit caches an accessory's services. If a newly-supported switch or the
> Auto range doesn't appear after an update, reboot your Home hub or iOS device.

### Vane and swing

Swing on/off lives on the main tile via `SwingMode`. Apple Home does not render an
Oscillate toggle for a collapsed accessory's fan service, which is why swing is on the
climate service and not the fan.

Discrete tilt angles need `exposeVaneSlat`, which is **off by default**. Apple Home
categorises a HAP `Slats` service as a **window covering**: turned on, each unit's vane
joins the same Home app grouping as your real blinds and shades, and a room-level "close
the blinds" can reach your louvres. Observed on a house with Matter blinds paired directly
to HomeKit. Enable it only if you want fixed angles and have no window coverings in
HomeKit to collide with.

## Local LAN control

**With the default settings `localControl` cannot work, and not because of anything in
this plugin.**

Authenticating to a unit's WiFi adapter needs two per-device secrets that only the vendor
cloud hands out: the adapter `password` (from the `adapter_update` socket event) and
`cryptoSerial` (from `GET /devices/{serial}/status`). Around **2026-07-31 the Comfort v3
API stopped serving both**, on unrelated accounts and on a second client stack
([pykumo #78](https://github.com/dlarrick/pykumo/issues/78), reproduced by its
maintainer). This plugin talks to v3, so with `localCredentialSource: "v3"` it has no way
to compute a local token, retries for about an hour, logs one warning, and runs everything
over the cloud.

### Getting the secrets from the v2 cloud

The **older v2 login** still serves both fields, which is the fallback Home Assistant's
`mitsubishi_comfort` integration adopted in v0.5.2. Set:

```json
{ "localCredentialSource": "v2" }
```

The plugin signs in once at startup to `https://geo-c.kumocloud.com/login`, reads the two
secrets per unit, and uses them for LAN control (which this implies — you do not also need
`localControl`). Nothing is written back to `config.json`, no secret is cached to disk, and
none of it is ever logged, `debug` included. A rejected sign-in is reported once and not
retried, so a wrong password cannot be re-posted in a loop.

### Canadian accounts

`POST /v3/login` answers **HTTP 500** for accounts served by Mitsubishi Electric Sales
Canada, so the v3 API cannot be used for them at all. One line handles it:

```json
{ "cloudRegion": "ca" }
```

That signs in to `https://mesca-prod.kumocloud.com/login/v2` instead, which supplies the
unit list, each unit's room name, its **real capability profile** and the two LAN secrets —
and the v3 API is then contacted on no path at all. Control runs entirely over your LAN, so
every unit needs to be reachable there (give each a DHCP reservation, or pin it with
`localControlIps`). Nothing is declared by hand.

The real profile is the practical difference from the local-only mode below: it reports
per-mode setpoint floors, so a unit that can hold **10 °C** for heating is published as
such rather than flattened to its 16 °C cooling floor — and HomeKit rejects a write below
the published minimum rather than clamping it, so that band is otherwise unaskable.

**[docs/configuration.md → Canadian accounts](docs/configuration.md#canadian-accounts-cloudregion-ca)**
has the full account, including what the mode gives up (streaming, "not responding"
detection, sensor battery).

### Local-only mode

`localOnly` runs **entirely on your LAN**: no sign-in of any version, no site or zone
fetch, no streaming, and — unlike `localControl` — no per-unit cloud fallback. Every unit
is declared in config, secrets included.

**Try `cloudRegion` / `localCredentialSource` above first.** They fetch the same secrets
for you, add the real device profile, and keep nothing sensitive in `config.json`. This
mode is for running with no cloud contact whatsoever — an isolated VLAN, a deliberately
offline install, or an account no endpoint serves — and for anyone who already holds the
two secrets.

The situations it was built for:

- **Your account cannot use the v3 API.** Canadian accounts are served by a different
  backend, `https://mesca-prod.kumocloud.com/login/v2`, speaking the older v2 protocol.
  This plugin only talks to `app-prod.kumocloud.com/v3`, where those accounts answer
  **HTTP 500** on login — as opposed to the 403 a genuinely wrong password gets — so
  discovery never starts and no amount of retrying helps.
- **The cloud no longer serves the secrets.** The change described above
  ([pykumo #78](https://github.com/dlarrick/pykumo/issues/78)) removed both fields from
  v3 for everyone, so even a working v3 account cannot bootstrap local control any more.

#### Getting the two secrets

Each unit needs its adapter `password` (base64) and `cryptoSerial` (hex, 9 bytes or
more). They are per-unit and they do not change. You need a source that still hands them
out:

- **The plugin itself**, which is now the easy answer: `cloudRegion: "ca"` or
  `localCredentialSource: "v2"` sign in to the v2 endpoint and read the secrets for you,
  so you do not have to hold them at all. Reach for the manual route below only if you want
  no cloud contact whatsoever.
- **The v2 endpoint by hand**, if you prefer — `POST https://mesca-prod.kumocloud.com/login/v2`.
  This is how the values in the config below were obtained, and local control was then
  confirmed working against the unit (a signed status read returned `roomTemp` and the
  current mode). Any v2 client will do; [pykumo](https://github.com/dlarrick/pykumo) is
  the reference implementation.
- **An older capture.** If you ran a version of this plugin (or pykumo, or Home Assistant)
  with local control working before 2026-07-31, the values you had then are still valid.

> ⚠️ Both values sit in **clear text** in `config.json`, and together they grant full
> control of that unit to anything on your LAN. Treat that file accordingly. Note the
> credentials belong to your own hardware — nothing here is sent anywhere.

#### Configuration

```json
{
  "platform": "KumoV3",
  "name": "Kumo",
  "localOnly": true,
  "localPollInterval": 15,
  "showDrySwitch": true,
  "showFanOnlySwitch": true,
  "localDevices": [
    {
      "deviceSerial": "1234A5678901234B",
      "name": "Living room",
      "ip": "192.168.6.11",
      "password": "<base64 adapter password>",
      "cryptoSerial": "<hex cryptoSerial>",
      "hasModeDry": true,
      "hasModeVent": true
    }
  ]
}
```

`username` and `password` are not required and are ignored. Give each unit a **DHCP
reservation** on your router: there is no cloud to fall back on, so a moved lease simply
ends control of that unit until you correct the address. On startup the plugin reads each
unit once and tells you how many answered — `Local-only control active for 1/1 device(s)`
— and names any that did not. After that the poller keeps watch: a unit that fails three
polls in a row (~45 s at the default interval) is named in one warning, latched until it
answers again, and a unit that rejects the credentials outright
(`device_authentication_error` — the password and cryptoSerial must both belong to the unit
at *that* address) says so once by name.

`hasModeDry` and `hasModeVent` declare what the *unit* can do, and in local-only mode that
declaration is enough: each one adds its switch tile, because `HeaterCooler` has no
dehumidify or fan-only state and the tile is the only way to reach those modes. The
`showDrySwitch` / `showFanOnlySwitch` display options still decide on the **cloud** path,
where the capability is discovered for every unit that has one rather than declared per
unit — and setting either explicitly to `false` still wins here too, in which case the log
says once that the mode cannot be selected.

#### What you give up

Without the cloud there is no `profile_update` and no account-level socket, so:

| | |
|---|---|
| **Indoor humidity** | Gone. It came from a separate cloud sensor query, not from the unit's local status. The `HumiditySensor` service is not added. A paired wireless sensor's readings are cloud-delivered too, so its finer temperature and battery level go with it |
| **Setpoint limits and capabilities** | Not discovered. The per-unit fields above stand in for them, defaulting to 16–31 °C and no dry/vent. Declaring a range wider than the unit's own installer limits fails **silently** — the adapter answers HTTP 200 and ignores the value, where the cloud would have returned a 400 |
| **"Not responding" in the Home app** | Not available. An unreachable unit shows its last known state instead of greying out; the poller's latched warning is what tells you, and a write that cannot be reverted is reported to HomeKit as a failure |
| **Streaming** | Gone; status comes from LAN polling every `localPollInterval` seconds (default 15). In practice this is *faster* than the cloud, which lags 7–10 s |
| **Cloud fallback** | Deliberately gone. A command the LAN refuses fails and the tile reverts, rather than quietly dialling an API that cannot authenticate. If nothing has ever been read from the unit there is no state to revert to, so the write is reported to HomeKit as a failure instead of appearing to succeed |

Mirroring, fan speed, vane, swing and the Fahrenheit-anchored setpoints all work normally.
Toggling `localOnly` needs a **full Homebridge restart** — a child bridge takes its config
from the parent process.

## Temperature display

HomeKit stores temperatures in Celsius and converts for display. The Home app **rounds**
that conversion while the Comfort app **truncates** it, so the same stored value can read
72°F in one and 71°F in the other.

**Setpoints: solved.** The units accept 0.1°C granularity, so every setpoint you write is
snapped to the Celsius that displays as the whole °F you asked for under *both* renderers
— the ceiling of the exact conversion, not the nearest 0.1. The two apps agree by
construction. This applies to new changes only; a setpoint you have not touched keeps
whatever value it was last set to.

**Current temperature: partly.** Indoor units report measured room temperature in 0.5°C
steps, a hardware limit, so the displayed value can still differ by ~1°F between apps. A
unit with a paired wireless sensor reports a much finer value and does not have this
problem.

Outdoor temperature is not available — the cloud API does not expose it, and the outdoor
unit's sensor is reachable only over a direct CN105 serial connection.

## Documentation

| | |
|---|---|
| [Configuration](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/docs/configuration.md) | Every option, validation rules, device mirroring |
| [Protocol](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/docs/protocol.md) | REST, Socket.IO, local LAN, HomeKit services |
| [Changelog](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/CHANGELOG.md) | |

**Matter:** not supported. Homebridge does not yet expose the FanControl features or
handlers a Matter build would need for vane and swing, and losing those is the whole
reason this plugin exists. HAP only until that changes.

## License

Apache License 2.0 — see [LICENSE](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/LICENSE).

Forked from
[burtherman/homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
at v1.8.2. The upstream repository shipped no license file and declared MIT in
`package.json` while reproducing Apache-2.0 boilerplate in its README; Apache-2.0 is the
only choice valid under either reading. Attribution, the statement of changes required by
Apache-2.0 section 4(b), and third-party notices — including the pykumo port that upstream
did not attribute — are in [NOTICE](https://github.com/ukaratay/homebridge-mitsubishi-heatpump/blob/main/NOTICE).

Inspired by [homebridge-kumo](https://github.com/fjs21/homebridge-kumo).
