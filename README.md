# Homebridge Mitsubishi Heat Pump — Canada

HomeKit control for Mitsubishi ductless heat pumps (MLZ / MSZ) on **Canadian accounts**.

Mitsubishi is in the middle of moving customers from the *kumo cloud* app to the
*Comfort* app, and the two speak different cloud APIs — kumo cloud is v2, Comfort is v3.
The rollout is regional, and **Canada has not migrated yet**: Canadian accounts are still
on the v2 cloud, so the v3 API that this plugin's upstream targets cannot serve them at
all. This fork signs in once to the Canadian v2 cloud for the unit inventory and the
per-unit LAN secrets, then controls everything over your own network.

US accounts keep working exactly as upstream: the v3 cloud, with optional LAN control.

Each unit is a **HeaterCooler** with its fan on a linked Fan service: power, mode,
setpoints, fan speed and vane swing all on one tile.

Not affiliated with, endorsed by, or associated with Mitsubishi Electric. **Use at your
own risk** — this drives real heating and cooling equipment, and the author assumes no
liability for damage or loss arising from it.

> **This is a fork.** With `cloudRegion: "ca"` the plugin signs in once at startup to
> `mesca-prod.kumocloud.com` — where Canadian accounts live until the migration reaches
> them — for the unit inventory, the real capability profile and the per-unit LAN
> secrets, then controls everything over your LAN and never contacts v3 at all.
> See [Canadian accounts](#canadian-accounts) for the full picture.
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
- **Display-grid setpoints.** A Fahrenheit account stores every setpoint as the exact
  Celsius of a whole °F, so the Home app and the Comfort app show the same number; a
  Celsius account snaps to the 0.5 °C grid the Home app displays, so 22.0 stays 22.0.
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

**Install from npm.** In the Homebridge UI, search for
`homebridge-mitsubishi-heatpump-ca` and install it. From a shell:

```bash
sudo hb-service add homebridge-mitsubishi-heatpump-ca
```

**From source**, for development or to run a change that is not released yet —
`dist/` is not committed, so this path needs a build:

```bash
git clone https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca.git
cd homebridge-mitsubishi-heatpump-ca
npm install && npm run build && npm link
```

**From a tarball**, when the Homebridge host cannot reach the npm registry:

```bash
npm pack
```

Copy the resulting `.tgz` to the host and install it from the Homebridge storage
directory. On the official Raspberry Pi image the bundled Node is not on `PATH`, so the
install has to name it explicitly:

```bash
sudo env PATH=/opt/homebridge/bin:/usr/bin:/bin /opt/homebridge/bin/npm install ./homebridge-mitsubishi-heatpump-ca-<version>.tgz
```

Changing plugin **code** needs only a child-bridge restart; changing plugin **config**
needs a full Homebridge restart, because a child bridge receives its configuration from
the parent process.

Then add your credentials — see **[Configuration](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/docs/configuration.md)** for the
minimal config and every option.

## Migrating from homebridge-mitsubishi-comfort

This repository forks
[ukaratay/homebridge-mitsubishi-heatpump](https://github.com/ukaratay/homebridge-mitsubishi-heatpump),
which is itself a hard fork of
[homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
at v1.8.2. Migrating from either one is the same: it keeps the config `platform` key
`KumoV3` and still derives accessory UUIDs
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
3. **Install this plugin**, as described under [Installation](#installation). Name
   `homebridge-mitsubishi-heatpump-ca` exactly — naming the upstream
   `homebridge-mitsubishi-heatpump` would install a plugin that cannot serve
   Canadian accounts.
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

### What appears in the Home app

A fully-enabled unit is more than one tile, so here is the end state:

- **The climate tile** — power, Heat / Cool / Auto and the setpoint for the active mode
  (a two-handle band in Auto). Apple Home collapses the accessory's services into this
  tile by default, so the linked Fan service's five-speed slider renders inside it, and
  the Oscillate toggle is there too — carried by the climate service, because Apple Home
  does not render an Oscillate toggle for a collapsed accessory's fan service.
- **Dry and Fan-only switches** (opt-in) — each adds its own switch tile, only on units
  whose profile supports the mode.
- **The Vane slats tile** (opt-in via `exposeVaneSlat`) — Apple files a `Slats` service
  under **window coverings** (see the collision warning below), and the Home app renders
  its angles **read-only**: the discrete tilt is settable only from third-party HomeKit
  apps. Swing needs no such tile — it is on the climate tile.
- **Humidity** — with `showHumiditySensor` (on by default), a unit that reports humidity
  shows it on the collapsed tile, where it can displace the temperature you wanted at a
  glance.

**Scenes capture all of these at once.** A scene snapshots the accessory's full state —
power, mode, setpoints, fan speed, swing, the switches — and re-pushes everything
concurrently each time it runs, not just the control you were thinking of when you saved
it. The plugin is built to survive that burst (an "AC off" scene cannot revive the unit
through a trailing setpoint or the fan tile), but it is worth knowing when a scene seems
to change more than you asked.

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

The plugin signs in once at startup to `https://geo-c.kumocloud.com/login` — a US host
inherited from that integration and not re-verified here, unlike the Canadian one below —
reads the two secrets per unit, and uses them for LAN control (which this implies — you do
not also need `localControl`). Nothing is written back to `config.json`, no secret is cached to disk, and
none of it is ever logged, `debug` included. A rejected sign-in is reported once and not
retried, so a wrong password cannot be re-posted in a loop.

### Canadian accounts

**Why this fork exists.** Mitsubishi is replacing the *kumo cloud* app with the *Comfort*
app, and the two speak different APIs — kumo cloud is v2, Comfort is v3. The rollout is
regional, and **Canada has not been migrated**: the shipping Canadian app is still
[kumo cloud® Canada](https://apps.apple.com/ca/app/kumo-cloud-canada/id6738711428)
(Android `com.mesca.kumocloud`), served by Mitsubishi Electric Sales Canada at
`mesca-prod.kumocloud.com` over v2.

That is why every other tool in this ecosystem fails for a Canadian account, and why
their names all say *comfort*: [`mitsubishi-comfort`](https://github.com/nikolairahimi/mitsubishi-comfort)
(the library behind Home Assistant's integration),
[`homebridge-mitsubishi-comfort`](https://github.com/burtherman/homebridge-mitsubishi-comfort),
and upstream itself all target v3. `POST /v3/login` answers **HTTP 500 `internalError`**
for a Canadian account — not because anything is broken, but because the account does not
exist in that system. This was already reported in
[pykumo#62](https://github.com/dlarrick/pykumo/issues/62) in **March 2026**, months before
the separate July 2026 change that stopped v3 serving LAN credentials to US accounts. The
two are unrelated: Canada was never affected by that one, having never been on v3.

The v2 fallback added to `mitsubishi-comfort` 0.5.2 (August 2026) does not help either —
it hardcodes `https://geo-c.kumocloud.com/login`, the US v2 host, which also answers 500
for a Canadian account. Host *and* path differ north of the border.

One line handles it here:

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

> **How long will this be needed?** Until Canada is migrated to the Comfort app, most
> likely. When that happens `mesca-prod` presumably follows `geo-c` into retirement and
> Canadian accounts move to v3 like everyone else — at which point `cloudRegion: "ca"`
> should become a much smaller thing, or stop being needed at all. Until then, nothing
> upstream is expected to serve this market: the tooling is built around v3, and Canada
> is a small market still on the old system. If you are Canadian and want local control
> today, this fork is the path.

**[docs/configuration.md → Canadian accounts](docs/configuration.md#canadian-accounts-cloudregion-ca)**
has the full account, including what the mode gives up (streaming, "not responding"
detection, sensor battery).

#### What a healthy startup looks like

A working `cloudRegion: "ca"` install logs this sequence:

```
V2: signed in to mesca-prod.kumocloud.com; 5 unit(s) in 1 site(s), 5 with local secrets
Local control: sweeping 253 addresses on 192.168.1.10's subnet...
[LOCAL] Discovered 1234A5678901234B at 192.168.1.42
✓ Local control active for 5/5 device(s) — LAN only, the v3 cloud never contacted
Local status polling every 15s
```

The sweep runs only for units whose address neither the v2 reply nor `localControlIps`
supplied. Two failure shapes are worth recognising:

- **`the unit rejected our credentials on 3 requests in a row
  (device_authentication_error)`** — the password and cryptoSerial must both belong to
  the unit at that address; check the address first if you have more than one unit. The
  warning deliberately waits for **three consecutive rejected requests**: a single
  rejection can be connection contention rather than a wrong credential — the token
  signs the request body, so a truncated read surfaces as an authentication failure,
  observed live on provably good credentials — so each rejected request is first retried
  once after a 250 ms pause, and any success resets the count and re-arms the warning.
- **`Local control: no answer from <name> at <ip>`** — the unit is unreachable at that
  address, and there is no cloud fallback in this mode. Give each unit a **DHCP
  reservation** (or pin it with `localControlIps`); a moved lease ends control of that
  unit until the address is corrected.

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
answers again. A unit that rejects the credentials
(`device_authentication_error` — the password and cryptoSerial must both belong to the unit
at *that* address) is named only after **three consecutive rejected requests**, each first
retried once after a 250 ms pause — a single rejection can be connection contention rather
than a wrong credential, because the token signs the request body and a truncated read
surfaces as an authentication failure. Any success resets the count and re-arms the
warning.

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
| **Sensor battery** | The one sensor reading genuinely gone: battery level arrives only via the cloud `sensor_update` event, and the low-battery warning goes with it. Humidity and a paired wireless sensor's finer temperature do **not** — humidity is absent from the unit's own local status, so the local poll reads the paired sensor (or an MHK2 wall thermostat, which reports humidity only) over the LAN in the same cycle, and the `HumiditySensor` service appears as usual. A unit with no sensor and no MHK2 reports no humidity at all |
| **Setpoint limits and capabilities** | Not discovered. The per-unit fields above stand in for them, defaulting to 16–31 °C and no dry/vent. Declaring a range wider than the unit's own installer limits fails **silently** — the adapter answers HTTP 200 and ignores the value, where the cloud would have returned a 400 |
| **"Not responding" in the Home app** | Not available. An unreachable unit shows its last known state instead of greying out; the poller's latched warning is what tells you, and a write that cannot be reverted is reported to HomeKit as a failure |
| **Streaming** | Gone; status comes from LAN polling every `localPollInterval` seconds (default 15). In practice this is *faster* than the cloud, which lags 7–10 s |
| **Cloud fallback** | Deliberately gone. A command the LAN refuses fails and the tile reverts, rather than quietly dialling an API that cannot authenticate. If nothing has ever been read from the unit there is no state to revert to, so the write is reported to HomeKit as a failure instead of appearing to succeed |

Mirroring, fan speed, vane, swing and the display-grid setpoint snapping all work normally.
Toggling `localOnly` needs a **full Homebridge restart** — a child bridge takes its config
from the parent process.

## Temperature display

HomeKit stores temperatures in Celsius and converts for display. The Home app **rounds**
that conversion while the Comfort app **truncates** it, so the same stored value can read
72°F in one and 71°F in the other.

**Setpoints: solved, on the grid you actually read.** The units accept 0.1°C
granularity, and every setpoint you write is snapped to the grid of the accessory's
display units. A Fahrenheit accessory stores the Celsius that displays as the whole °F
you asked for under *both* renderers — the ceiling of the exact conversion, not the
nearest 0.1 — so the two apps agree by construction. A Celsius accessory snaps to the
0.5 °C grid the Home app renders instead, because for a Celsius reader the °F anchor is
pure cost: 22.0 °C is 71.6 °F, whose nearest whole degree stores as 22.3, which the
Home app's 0.5 grid then shows as 22.5 — half a degree above what was asked for
(observed live). On the 0.5 grid, what is stored, what is displayed and what was asked
for are the same number. This applies to new changes only; a setpoint you have not
touched keeps whatever value it was last set to.

**Current temperature: partly.** Indoor units report measured room temperature in 0.5°C
steps, a hardware limit, so the displayed value can still differ by ~1°F between apps. A
unit with a paired wireless sensor reports a much finer value and does not have this
problem.

Outdoor temperature is not surfaced. No path this plugin reads carries it — it is not in
the unit's local status, and in `ca` mode the v3 cloud is never contacted anyway — and
the outdoor unit's own sensor is reachable only over a direct CN105 serial connection.

## Documentation

| | |
|---|---|
| [Configuration](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/docs/configuration.md) | Every option, validation rules, device mirroring |
| [Protocol](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/docs/protocol.md) | REST, Socket.IO, local LAN, HomeKit services |
| [Security](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/SECURITY.md) | Threat model, what is defended, how to report a vulnerability |
| [Changelog](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/CHANGELOG.md) | |

**Matter:** not supported. Homebridge does not yet expose the FanControl features or
handlers a Matter build would need for vane and swing, and losing those is the whole
reason this plugin exists. HAP only until that changes.

## License

Apache License 2.0 — see [LICENSE](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/LICENSE).

This repository forks
[ukaratay/homebridge-mitsubishi-heatpump](https://github.com/ukaratay/homebridge-mitsubishi-heatpump)
at v2.2.1; that repository is itself a hard fork of
[burtherman/homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
at v1.8.2. The original burtherman repository shipped no license file and declared MIT in
`package.json` while reproducing Apache-2.0 boilerplate in its README; Apache-2.0 is the
only choice valid under either reading, and both forks continue under it. Attribution, the
statement of changes required by Apache-2.0 section 4(b), and third-party notices —
including the pykumo port that the original did not attribute — are in [NOTICE](https://github.com/thicla01/homebridge-mitsubishi-heatpump-ca/blob/main/NOTICE).

Inspired by [homebridge-kumo](https://github.com/fjs21/homebridge-kumo).
