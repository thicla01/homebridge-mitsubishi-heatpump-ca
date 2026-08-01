# Homebridge Mitsubishi Heat Pump

> **Fork notice.** This is a hard fork of
> [homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
> at v1.8.2. It exposes each unit as a HomeKit **HeaterCooler** (not a Thermostat),
> adds **fan speed** and **vane** control, and uses a **Fahrenheit-anchored**
> setpoint grid. The config `platform` key is still `KumoV3`, so an existing
> config.json keeps working — but see [Migrating from
> homebridge-mitsubishi-comfort](#migrating-from-homebridge-mitsubishi-comfort)
> before upgrading: the service-type change breaks existing automations.


A Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API.

## ⚠️ Disclaimer

This plugin is not affiliated with, endorsed by, or associated with Mitsubishi Electric in any way. It is an independent, unofficial plugin developed by the community for personal use.

**Use at your own risk.** The author assumes no liability for any damage, data loss, or issues that may arise from using this plugin. By using this plugin, you acknowledge that you do so entirely at your own discretion and risk.

## Features

- **HeaterCooler tile per unit** — on/off, Heat / Cool / Auto, and the setpoint for the active mode, all on the main tile. Auto shows a two-handle heat/cool band
- **Fan speed on the tile** — five real speeds plus fan-auto, on a linked Fan service
- **Vane control** — swing on/off on the main tile; discrete tilt angles through an opt-in `Slats` service
- **Fahrenheit-anchored setpoints** — every setpoint is stored as the exact Celsius of a whole °F, so the Home app and the Mitsubishi Comfort app show the same number
- **Device mirroring (opt-in)** — make one unit follow another; the target copies the source's mode, setpoints, on/off and fan whenever the source changes ([details](#device-mirroring))
- **Wireless sensor support** — units with a paired sensor report its finer temperature and humidity, plus a battery level with a low-battery warning
- **Real-time streaming updates** via Socket.IO, with adaptive polling that activates only when streaming fails (~95% fewer API calls when streaming is healthy)
- **Local LAN control (opt-in)** — currently blocked by a vendor change; see [Local LAN Control](#local-lan-control)
- Filter-change indicator, indoor humidity sensor (both optional), automatic token refresh
- Multi-site and multi-zone support, device exclusion/hiding
- Comprehensive logging for streaming/polling/local state transitions

## Installation

### Prerequisites

- Node.js 20.19 or newer (20.19+, 22.12+, or 24+). The plugin's HTTP client is
  ESM-only, and `require()` of it fails on older releases
- Homebridge (v1.6.0 or higher, including v2.x)

### Install from NPM

```bash
npm install -g homebridge-mitsubishi-heatpump
```

### Install from Source

```bash
git clone https://github.com/ukaratay/homebridge-mitsubishi-heatpump.git
cd homebridge-mitsubishi-heatpump
npm install
npm run build
npm link
```

## Migrating from homebridge-mitsubishi-comfort

This fork keeps the config `platform` key `KumoV3` and derives accessory UUIDs from
the device serial, so **your existing `config.json` works unchanged and your
accessories keep their identity** — room assignment, custom names, Favorites, and
the child-bridge pairing all survive.

### What survives

| Thing | Survives? |
|---|---|
| `config.json` platform block | ✅ unchanged, `platform` is still `KumoV3` |
| Child-bridge pairing | ✅ pairing lives at the bridge, `_bridge.username` untouched |
| Room assignment, names, Favorites | ✅ accessory UUID is derived from `deviceSerial` |
| `mirror` config | ✅ keyed on device serial |
| **Automations, scenes, Shortcuts** | ❌ **these break — see below** |

### What breaks: automations and scenes

The primary service changed from `Thermostat` to `HeaterCooler`. HomeKit binds
automations to a *service and characteristic instance*, not to the accessory, so
**every automation, scene, trigger, or Shortcut that referenced the old thermostat
stops working and must be rebuilt** against the new tile. The accessory itself is
still there under the same name in the same room; only the controls beneath it are
new. There is no way to migrate these automatically.

### Upgrade steps

1. **Stop Homebridge.** `sudo hb-service stop`
2. **Uninstall the old plugin from the command line**, not the Homebridge UI:
   ```bash
   sudo hb-service remove homebridge-mitsubishi-comfort
   ```
   > ⚠️ **Do not uninstall via the Homebridge UI.** Its uninstall dialog defaults to
   > "remove config", which deletes the whole platform block *including*
   > `_bridge.username`. Losing that changes the child bridge's identity and forces
   > you to re-pair all your units in the Home app.
3. **Install this plugin.**
   ```bash
   sudo hb-service add homebridge-mitsubishi-heatpump
   ```
   > ⚠️ **Never have both installed at once.** Two plugins registering the `KumoV3`
   > platform makes Homebridge throw an ambiguous-platform error, which it swallows
   > into a misleading "Could not find the associated plugin" and drops your
   > accessories.
4. **Start Homebridge.** `sudo hb-service start`
5. Rebuild your automations and scenes against the new HeaterCooler tiles.

### New in this fork

- **Fan speed and fan-auto** on a linked `Fanv2` service, all five speeds. Your units
  report `numberOfFanSpeeds: 3` but accept all five — verified on real hardware — so
  the profile count is treated as advisory.
- **Vane control** via `SwingMode` on the main tile. The write path for this did not
  exist upstream at all. Discrete tilt positions are available through an optional
  `Slats` service (`exposeVaneSlat`), **off by default** — see the warning below.
- **Fahrenheit-anchored setpoints.** Setpoints snap to the exact Celsius of a whole
  °F, so the Home app and the Mitsubishi Comfort app agree by construction.
- **Dry and Fan-only switches are now opt-in** (`showDrySwitch` / `showFanOnlySwitch`),
  off by default, since fan control now lives on the accessory itself.
- **Wireless sensor readings** — a paired sensor's finer temperature and humidity, and
  its battery level as a HomeKit `Battery` service.
- **Display units are settable** (`TemperatureDisplayUnits`), which upstream hardwired
  to Celsius. The Home app ignores it, but Eve and other controllers honour it.

### ⚠️ A note on `exposeVaneSlat`

Apple Home categorises a HAP `Slats` service as a **window covering**. Turned on, each
unit's vane appears in the same Home app grouping as your real blinds and shades — it
lands in their rooms' window-covering summary, and a room-level "close the blinds"
control can reach your louvres. This was observed on a house with Matter blinds paired
directly to HomeKit.

It is therefore **off by default**. Swing on/off is always available on the HeaterCooler
tile itself via `SwingMode` regardless; the option only adds fixed tilt angles. Enable it
only if you want those and have no window coverings in HomeKit to collide with.

## Configuration

Add the following to your Homebridge `config.json`:

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

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `platform` | string | Yes | Must be `KumoV3` |
| `name` | string | No | Platform name (default: "Kumo") |
| `username` | string | Yes | Your Kumo Cloud email address |
| `password` | string | Yes | Your Kumo Cloud password |
| `pollInterval` | number | No | Polling interval when streaming is healthy in seconds (default: 30, minimum: 5) |
| `disablePolling` | boolean | No | **Recommended:** Disable polling when streaming is healthy (auto-enables if streaming fails, default: false) |
| `degradedPollInterval` | number | No | Fast polling interval when streaming is unhealthy in seconds (default: 10, minimum: 5, maximum: 60) |
| `streamingHealthCheckInterval` | number | No | How often to check if streaming is healthy in seconds (default: 30, minimum: 10, maximum: 300) |
| `streamingStaleThreshold` | number | No | **Deprecated and inert.** Nothing reads it; streaming health is decided by the Socket.IO connection state. Accepted so an existing config stays valid |
| `excludeDevices` | string[] | No | Array of device serial numbers to hide from HomeKit |
| `debug` | boolean | No | Enable debug logging (default: false) |
| `showHumiditySensor` | boolean | No | Expose indoor humidity as a HumiditySensor service (default: **true**). Turn off if humidity dominates the accessory tile in the Home app |
| `showDrySwitch` | boolean | No | Add a per-unit Dry (dehumidify) switch (default: false). Only on units whose profile reports dry support |
| `showFanOnlySwitch` | boolean | No | Add a per-unit Fan-only switch (default: false). This is fan-*only* mode; fan speed while heating or cooling is on the main tile and needs no switch |
| `exposeVaneSlat` | boolean | No | Expose vane angles as a `Slats` service (default: false). Apple Home files Slats under window coverings — see the warning in "New in this fork" above |
| `localControl` | boolean | No | **Opt-in (default: false).** Control units directly over the LAN. Currently non-functional through no fault of the plugin — see [Local LAN Control](#local-lan-control) |
| `localPollInterval` | number | No | Seconds between local status polls when `localControl` is on (default: 15, minimum: 5, maximum: 120) |
| `localControlIps` | object | No | Optional `{ "<deviceSerial>": "<ip>" }` map to skip LAN discovery for specific units |
| `mirror` | array | No | **Opt-in (default: absent).** `{ source, target }` device-serial pairs; the target follows the source. See [Device Mirroring](#device-mirroring) |

### Recommended Configuration for Optimal Efficiency

For best performance and minimal network traffic, enable streaming-only mode:

```json
{
  "platforms": [
    {
      "platform": "KumoV3",
      "name": "Kumo",
      "username": "your-email@example.com",
      "password": "your-password",
      "disablePolling": true
    }
  ]
}
```

This configuration:
- Uses streaming for all device updates when healthy (0 polling queries)
- Automatically activates 10-second polling if streaming disconnects
- Reduces API calls by ~95% (from ~257/hour to ~12/hour)
- Only makes token refresh queries every 15 minutes during normal operation

### Debug Mode

When `debug: true` is enabled, the plugin will log detailed information including:

- API requests and responses with timing information
- Raw JSON data from zone/device API responses showing all available fields
- Real-time streaming updates with complete device state
- Authentication and token refresh events
- WebSocket connection status

**Note:** Debug mode may log sensitive information and should only be enabled for troubleshooting. The plugin will display a warning when debug mode is active.

### Known Limitations

- **Outdoor Temperature**: The Kumo Cloud API does not expose outdoor temperature data from the outdoor units. While outdoor units have temperature sensors (used for defrost cycles), this data is only available through direct CN105 serial connections, not through the cloud API.

- **Temperature Display Differences (°F)**: HomeKit stores temperatures in Celsius and converts to °F for display, and the Home app *rounds* that conversion while the Mitsubishi Comfort app *truncates* it. The same stored value can therefore read 72°F in one and 71°F in the other.

  **Setpoints:** solved. The units accept 0.1°C granularity (verified against real hardware), so every setpoint you write is snapped to the Celsius that displays as the whole °F you asked for under **both** renderers — the ceiling of the exact conversion, not the nearest 0.1. The two apps agree by construction. This applies to new changes only; a setpoint you have not touched keeps whatever value it was last set to.

  **Current temperature:** the indoor units report their measured room temperature only in **0.5°C steps** (a hardware limit), so the displayed current temperature can still differ by ~1°F between apps. A unit with a paired wireless sensor reports a much finer value and does not have this problem.

## Local LAN Control

**`localControl` cannot work at present, and not because of anything in this plugin.** Authenticating to a unit's WiFi adapter needs two per-device secrets that only the vendor cloud hands out: the adapter `password` (from the `adapter_update` socket event) and `cryptoSerial` (from `GET /devices/{serial}/status`). Around **2026-07-31 Mitsubishi's cloud stopped serving both**, on unrelated accounts and on a second client stack ([pykumo issue #78](https://github.com/dlarrick/pykumo/issues/78), reproduced by its maintainer), so no client can compute a local token.

You do not need to do anything. The plugin retries for about an hour, logs one warning, and runs everything over the cloud. Nothing is written to your config, so if Mitsubishi restores the fields, local control comes back on its own at the next Homebridge restart. Leaving `localControl: true` costs nothing; set it to `false` to silence the warning.

## Device Mirroring

Make one unit **follow** another. Useful when a unit has no wall control (only the app) and you want it to shadow a unit you actually operate — for example, the living room mirrors the kitchen.

Add a `mirror` array of `{ source, target }` device-serial pairs (serials appear in the log during device discovery):

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
- **On every source change, it copies the source's full state** — mode (heat/cool/auto/dry/vent/off), the setpoint(s), on/off, and fan speed.
- **Any control path triggers it.** Because it follows the source's *actual* state, changing the source from its **wall thermostat**, the **Kumo app**, or **HomeKit** all mirror across. HomeKit changes mirror in about a second; wall/app changes mirror when the plugin next reads the source (within one local poll, ~15s with `localControl` on, or a streaming tick otherwise).
- **Manual target changes stick.** If you adjust the target directly, it stays put until the source changes again — at which point the target re-syncs to the source. (Since any source change re-applies the *full* state, changing only the source's temperature will also turn a manually-off target back on to match.)
- **Safe across different units.** Setpoints are clamped to the target's own supported range, and a mode the target can't do is skipped.

Notes:

- One source can drive several targets — add one entry per target.
- Vane/louver direction, room temperature, and humidity are **not** mirrored (those are sensor readings, not settings).
- Like `localControl`, `mirror` is read from the **parent** Homebridge config, so changing it requires a **full Homebridge restart**.

## HomeKit Modes & Switches

Each unit is a **HeaterCooler**, whose target mode is only Heat / Cool / Auto — on/off is a separate `Active` characteristic, and there is no state for dehumidify or fan-only. So:

- **On/off is independent of mode.** Turning a unit off does not change which mode it returns to.
- **Setpoints are the two thresholds.** The Home app shows the heating threshold in Heat, the cooling threshold in Cool, and both as a two-handle band in Auto. Modes the unit's profile says it cannot do are removed from the picker.
- **What the unit is doing** is reported honestly: heating, cooling, or **idle** when the compressor is in standby or the unit is in fan-only.
- **Fan speed and fan-auto** are on a linked **Fan** service — five speeds at 0 / 25 / 50 / 75 / 100 on the slider, plus Auto on units whose profile has it.
- **Vane:** swing on/off lives on the main tile. Discrete tilt angles need `exposeVaneSlat` (off by default — see the warning above). Apple Home does not render an Oscillate toggle for a collapsed accessory's fan service, which is why swing is on the climate service and not the fan.
- **Dry (dehumidify)** is an opt-in **"Dry" switch** per unit (`showDrySwitch`, added only on units that support dry). Dry reports as Cool on the tile, and on units that support a dry setpoint the cooling threshold controls it.
- **Fan-only** is an opt-in **"Fan-only" switch** per unit (`showFanOnlySwitch`, added only on units that support vent). This is fan-*only* mode; changing fan speed while heating or cooling needs no switch. Dry and Fan-only are mutually exclusive.
- **Indoor humidity** is a HumiditySensor service, on by default (`showHumiditySensor`). Turn it off if the Home app's collapsed tile shows humidity where you wanted temperature.
- **Filter indicator.** A filter-change indication appears when the unit reports its filter needs cleaning.

> **Note:** HomeKit caches an accessory's services. If a newly-supported switch or the Auto range doesn't appear after an update, reboot your Home hub (Apple TV/HomePod) or the iOS device to refresh its cache.

## Development

### Build

```bash
npm run build
```

### Watch for Changes

```bash
npm run watch
```

This will compile TypeScript, link the plugin, and restart on changes.

## How It Works

1. **Authentication**: The plugin logs in to the Kumo Cloud v3 API using your credentials
2. **Token Management**: Access tokens are automatically refreshed every 15 minutes
3. **Discovery**: All sites and zones are discovered and registered as HomeKit HeaterCooler accessories
4. **Real-time Streaming**: Establishes Socket.IO connection for instant device updates
5. **Intelligent Fallback**:
   - **Normal Mode** (streaming healthy): Updates via streaming only, minimal API calls
   - **Degraded Mode** (streaming failed): Automatic fallback to fast polling (10s intervals)
   - **Health Monitoring**: Continuous checking of streaming connection status
   - **Automatic Recovery**: Returns to streaming-only mode when connection restored
6. **Control**: Changes made in HomeKit are sent to the unit via the Kumo Cloud API, or directly over the LAN when `localControl` is enabled and the unit is reachable (see [Local LAN Control](#local-lan-control) for why that is currently unavailable)

### Update Strategy

The plugin uses a smart streaming-first approach with automatic fallback:

- **When streaming is healthy**: All device updates arrive via Socket.IO in real-time. If `disablePolling: true` is set, no polling occurs (optimal mode).
- **When streaming disconnects**: Plugin automatically switches to degraded mode with fast polling (default: 10s intervals) to ensure devices remain responsive.
- **When streaming reconnects**: Plugin automatically returns to normal mode, halting polling if `disablePolling: true`.
- **Race condition prevention**: Timestamp-based filtering ensures newer updates always take precedence, regardless of source.

## Supported Characteristics

**HeaterCooler** (primary service, one per unit):

- `Active` (on/off)
- `CurrentHeaterCoolerState` (inactive / idle / heating / cooling)
- `TargetHeaterCoolerState` (heat / cool / auto, narrowed to what the unit supports)
- `CurrentTemperature`
- `HeatingThresholdTemperature` and `CoolingThresholdTemperature` — these *are* the setpoint controls in every mode. There is deliberately no `TargetTemperature`
- `SwingMode` (vane swing, when the unit has one)
- `TemperatureDisplayUnits`

**Fan** (`Fanv2`, linked): `Active`, `CurrentFanState`, `RotationSpeed` (five speeds), `TargetFanState` (fan-auto, when the unit has it).

**Optional, per unit:** `HumiditySensor` (on by default), `Battery` (units with a paired wireless sensor, with low-battery warning), `FilterMaintenance` (when reported), `Slats` (opt-in), Dry and Fan-only `Switch` services (opt-in, capability-gated).

## API Endpoints Used

### REST API
- `POST /v3/login`, `POST /v3/refresh` - Authentication and token refresh
- `GET /v3/sites` - Get all sites
- `GET /v3/sites/{siteId}/zones` - Get zones for a site (the polling endpoint)
- `GET /v3/devices/{deviceSerial}/status` - Connection status and `cryptoSerial`
- `POST /v3/devices/send-command` - Send commands to device

### Socket.IO Streaming
- `wss://socket-prod.kumocloud.com` - Real-time device updates via Socket.IO
- Emits `subscribe` per device serial, plus an account-level `subscribe`
- Receives `device_update` (full device state), `profile_update` (capabilities),
  `device_status_v2` (connected / disconnected), `sensor_update` (wireless sensor
  temperature, humidity, battery) and `adapter_update` (adapter firmware and RSSI;
  formerly also the local-control password — see [Local LAN Control](#local-lan-control))

### Local LAN (when `localControl` is enabled)
- `PUT http://<unit-ip>/api?m=<token>` - direct status reads and commands to each indoor unit's WiFi adapter (no cloud)

## Security

### Best Practices

- **Credentials**: Your Kumo Cloud credentials are stored in the Homebridge config file. Ensure this file has appropriate permissions (readable only by the Homebridge user).
- **Debug Mode**: Only enable debug mode when troubleshooting. Debug logs may contain sensitive information like API endpoints and error details.
- **Network**: This plugin communicates with Kumo Cloud servers over HTTPS. Ensure your Homebridge instance runs in a secure network environment.
- **Updates**: Keep the plugin updated to receive security patches.

### What Data is Transmitted

- Authentication credentials (username/password) are sent to Kumo Cloud API during login
- Device commands and status updates are exchanged with Kumo Cloud servers
- No data is transmitted to third parties
- Cloud communication uses HTTPS encryption
- With `localControl` enabled, commands and status are also exchanged **directly with the units on your LAN** over plain HTTP (the units' local API is not encrypted; this stays within your network)

## Troubleshooting

### Plugin not discovering devices

- Verify your username and password are correct
- Check Homebridge logs for authentication errors
- Ensure your Kumo Cloud account has active devices

### Devices not responding to commands

- Check your internet connection
- Verify devices are online in the Kumo Cloud app
- Check Homebridge logs for API errors

### Temperature not updating

- Status is polled every 30 seconds by default
- Ensure the device is connected (check in Kumo Cloud app)
- Look for polling errors in Homebridge logs

## License

Apache License 2.0 — see [LICENSE](LICENSE).

This is a fork of [burtherman/homebridge-mitsubishi-comfort](https://github.com/burtherman/homebridge-mitsubishi-comfort)
(forked at v1.8.2). The upstream repository shipped no license file and declared
MIT in `package.json` while reproducing Apache-2.0 boilerplate in its README;
Apache-2.0 is the only choice valid under either reading. Attribution, the
statement of changes required by Apache-2.0 section 4(b), and third-party
notices (including the pykumo port that upstream did not attribute) are in
[NOTICE](NOTICE).

## Credits

Based on the Kumo Cloud v3 API and inspired by [homebridge-kumo](https://github.com/fjs21/homebridge-kumo).
