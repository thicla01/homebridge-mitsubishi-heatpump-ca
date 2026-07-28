# Matter support: deferred

**Date:** 2026-07-27
**Verified against:** Homebridge `v2.2.1` (npm dist-tag `latest`, newest GitHub release tag), `homebridge-mitsubishi-heatpump` 2.0.0

## Decision

This fork ships HAP only. No Matter accessory graph until Homebridge exposes FanControl features and handlers for rocking/airflow, and Apple Home renders a bridged air conditioner with a speed control.

## What we want

The HAP accessory already delivers, per unit:

- Heat / Cool / Auto with a heat-cool band (`TargetHeatingCoolingState`, heating + cooling threshold temperatures).
- Fan-only and Dry as separate `Service.Switch` subtypes (`'fan-only'`, `'dry'` in `src/accessory.ts`), because HAP has no such thermostat modes.
- Six named fan speeds (`auto`, `superQuiet`, `quiet`, `low`, `powerful`, `superPowerful`) and seven vane positions incl. `swing` (`src/settings.ts`), all confirmed writable on the author's MLZ-KX06NL-U1, MLZ-KX12NL-U1 and MSZ-GX06NL-U1 units.

A Matter build has to reach parity, not a subset. Losing vane and swing is the whole reason this fork exists.

## Why it is blocked today

### 1. There is no HAP to Matter bridge inside Homebridge

Enabling Matter does not re-publish existing HomeKit accessories. The plugin must build and maintain a second, parallel accessory graph.

> "Simply enabling Matter in the Homebridge UI will not automatically make existing accessories available via Matter."
> "For a plugin to expose Matter accessories, the plugin developer must specifically add Matter support to their plugin."

Registration goes through `api.matter.registerPlatformAccessories(pluginId, platformName, accessories)`, documented on `MatterAPI` in `src/api.ts`. `api.matter` is `MatterAPI | undefined`, so every call site needs optional chaining or an `api.isMatterEnabled()` guard.

Cost: a second state-sync path over the same Kumo cloud/local mirror, with its own cache, its own update fan-out, and its own bug surface.

- https://github.com/homebridge-plugins/homebridge-matter/wiki/Enabling-Matter
- https://github.com/homebridge/homebridge/blob/v2.2.1/src/api.ts

### 2. The device-type list is not a whitelist (so declaration is not the constraint)

`MatterAccessory.deviceType` is typed `EndpointType` (`src/matter/types.ts:179`) — any matter.js endpoint type is accepted. `api.matter.deviceTypes` is a plain `as const` map introduced as "Friendly device type names for the Plugin API" (`src/matter/types.ts:571`). Nothing validates a declared device type against it: `MatterAPIImpl` only rejects a missing `deviceType` (`src/matter/MatterAPIImpl.ts:116`) and otherwise compares numeric device-type ids to decide external publishing.

So the real constraints are behavior substitution (finding 3) and what Apple's renderer does with the result (findings 6, 7), not what we are allowed to declare.

Caveat: `MatterAPI` exposes `deviceTypes`, `clusters`, `clusterNames` and `types`, but **not** matter.js `devices`. Hand-building an endpoint type therefore means taking a direct `@matter/main` dependency and keeping its version in step with whatever Homebridge bundles. Workable, not free.

- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/types.ts
- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/MatterAPIImpl.ts

### 3. Vane and swing are structurally unreachable

Three independent gaps, all in Homebridge v2.2.1:

1. `HomebridgeFanControlServer` reacts to exactly two attributes: `this.events.fanMode$Changed` and `this.events.percentSetting$Changed` (`src/matter/behaviors/FanControlBehavior.ts:28,31`). Nothing watches `rockSetting`, `windSetting` or `airflowDirection`.
2. `FanControlHandlers` declares only `fanModeChange` and `percentSettingChange` (`src/matter/clusterHandlerMap.ts:109-118`). There is no handler name a plugin could register for swing or vane.
3. `AccessoryManager.buildCustomBehaviors()` (`src/matter/server/AccessoryManager.ts:399`) applies `.with(...features)` to preserve cluster features for `colorControl`, `thermostat`, `levelControl`, `serviceArea` and `windowCovering`. There is no `fanControl` branch — the string `fanControl` does not appear in that file at all. The behavior is pulled featureless from `CORE_CLUSTER_BEHAVIOR_MAP` (`src/matter/server/BehaviorMap.ts:54`) and substituted onto the endpoint via `deviceType.with(...customBehaviors)` (line 166), which replaces whatever FanControl feature set the declared device type carried. matter.js's `FanControlServer extends FanControlBehavior` with no `.with(...)`, so the substituted server has MultiSpeed, Rocking, Wind and AirflowDirection all off.

Corollaries worth knowing before someone re-tries this:

- **Percent-based fan speed is not blocked.** `percentSetting` is mandatory in the FanControl cluster and the Homebridge server does react to it, so a 0-100% slider mapped onto our six named speeds is reachable today. What is blocked is discrete MultiSpeed steps, Rocking (swing) and AirflowDirection (vane).
- **AirflowDirection is not merely stripped, it is absent.** `FanControlState` (`src/matter/clusterTypes.ts:168-180`) has `rockSupport`/`rockSetting`/`windSupport`/`windSetting` but no `airflowDirection` field at all.
- **Declaring without a handler does not help.** Omit the `fanControl` handler and no substitution happens, so device-type features survive — but then no write ever reaches the plugin. Read-only vane state, no control.
- **Parts are worse.** `createAccessoryParts()` pushes `CORE_CLUSTER_BEHAVIOR_MAP` entries onto child endpoints with no feature application whatsoever, so a composed "AC + fan part" design inherits the same gap.

- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/behaviors/FanControlBehavior.ts
- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/server/AccessoryManager.ts
- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/clusterHandlerMap.ts
- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/clusterTypes.ts

### 4. The curated `RoomAirConditioner` omits AutoMode

```ts
RoomAirConditioner: devices.RoomAirConditionerDevice.with(
  devices.RoomAirConditionerRequirements.ThermostatServer.with('Heating', 'Cooling'),
),
```

`src/matter/types.ts:646`. The curated `Thermostat` in the same map gets `.with('Heating', 'Cooling', 'AutoMode', 'Occupancy')`; the air conditioner does not. AutoMode is exactly the heat/cool band this plugin is built around, and `deviceTypes.spec.ts` pins the RAC feature set to Heating + Cooling only.

This one is a cost rather than a hard block: per finding 2 we may declare our own `RoomAirConditionerDevice.with(ThermostatServer.with('Heating', 'Cooling', 'AutoMode'))`, and `buildCustomBehaviors()` *does* have a thermostat feature-preservation branch, so those features survive the substitution. The price is the direct `@matter/main` dependency.

- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/types.ts
- https://github.com/homebridge/homebridge/blob/v2.2.1/src/matter/deviceTypes.spec.ts

### 5. Thermostat features are hardcoded before Homebridge 2.3.0

The homebridge-matter HVAC guide:

> "Requires Homebridge v2.3.0 or later. Before that the device type was fixed to Heating, Cooling, AutoMode and Occupancy regardless of what the accessory declared, so a heating-only thermostat could not be represented without rewriting the cluster by hand."

That matches the v2.2.1 source exactly: `Thermostat: devices.ThermostatDevice.with(ThermostatRequirements.ThermostatServer.with('Heating', 'Cooling', 'AutoMode', 'Occupancy'))`. From 2.3.0 the feature set is derived from the setpoints the accessory declares.

`latest` on npm is **2.2.1**, which is also the newest GitHub release tag and the version the author runs. Note the same guide documents only `Thermostat` and `Fan`; it never covers `RoomAirConditioner`, and its Fan section shows only `fanMode`, `fanModeSequence`, `percentSetting`, `percentCurrent` with `fanModeChange` / `percentSettingChange` handlers. No swing, no airflow direction.

- https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-9-HVAC
- https://registry.npmjs.org/homebridge/latest

### 6. Apple Home has no Dry or Fan-only HVAC mode

Apple Home's thermostat model is Off / Heat / Cool / Auto, in HAP and over Matter alike. Matter's Thermostat cluster defines FanOnly and Dry `SystemMode` values, but Home does not render them.

> "Apple Home and Google Home typically only show Heat, Cool, Auto, and Off."
> "Dry and Fan Only modes are exposed via Matter but controller support varies."

Caveat on how this hits us: our Dry and Fan-only are already *switches*, not modes (`Service.Switch` with subtypes `'fan-only'` and `'dry'`), precisely because HAP lacks the modes. The same workaround exists over Matter — an `OnOffSwitch` / `OnOffOutlet` endpoint or a `MatterAccessoryPart`. So these controls are portable; what stays unavailable is Dry/Fan-only as first-class modes on the AC tile. This is a papercut, not the blocker.

No Apple primary source states the Dry/Fan-only omission outright; the citation below is third-party but matches observed Home behavior.

- https://riddix.github.io/home-assistant-matter-hub/devices/climate

### 7. One public data point that Apple Home drops the fan slider behind a bridge

Apple Developer Forums thread 805968, "Home App air conditioner connection issues" (Nov 2025). The original poster reports:

> "1. After scanning the QR code to bind the air conditioner, a fan speed slider is displayed.
> 2. If the air conditioner is first added to MatterBridge (a gateway with Zigbee functionality), and then scanned to bind it to the Home app, the fan speed slider is not displayed."

Apple DTS (Kevin Elliott) replied:

> "A superficial scan of the logs shows enough difference that I think the MatterBridge is simply publishing a configuration that Home isn't recognizing."

and asked the poster to validate both Matter configurations against the spec and file bugs against HomeKit or the bridge accordingly.

Read this precisely: the direct-vs-bridged difference is the poster's observation, **not** an Apple statement of a HomeKit limitation, and Apple's own read points at the bridge's published configuration rather than at Home. It is still the only public evidence on the exact shape we would ship — an AC behind a Matter bridge — and it says the fan control went missing. Not enough certainty to build on.

- https://developer.apple.com/forums/thread/805968

## What would unblock it

| # | Unblocker | Signal to watch |
|---|---|---|
| 1 | Homebridge >= 2.3.0 published | `npm view homebridge version` reports >= 2.3.0 |
| 2 | A `fanControl` feature-preservation branch in `buildCustomBehaviors()`, plus `rockSetting` / `airflowDirection` reactions in `HomebridgeFanControlServer` and matching entries in `FanControlHandlers` / `FanControlState` | grep the four files listed below |
| 3 | Apple Home rendering a bridged `RoomAirConditioner` with a working speed control (and ideally a swing toggle) | resolution of forum thread 805968, or a first-party Matter AC test |

Items 1 and 2 are Homebridge-side and observable from source. Item 3 needs an empirical test with real hardware; there is no spec guarantee to lean on.

## Implementation sketch (for when it unblocks)

1. Feature-flag it: `matter: boolean` in `config.schema.json`, default off. Register the HAP accessory unconditionally; add the Matter graph only when `api.isMatterEnabled()` and the flag is set.
2. Device type: `deviceTypes.RoomAirConditioner` if AutoMode is present by then, else a hand-built `RoomAirConditionerDevice.with(RoomAirConditionerRequirements.ThermostatServer.with('Heating', 'Cooling', 'AutoMode'))` and a pinned `@matter/main` dependency.
3. Clusters: `onOff` for power, `thermostat` for mode plus `occupiedHeatingSetpoint` / `occupiedCoolingSetpoint` (hundredths of a degree Celsius), `temperatureMeasurement` and `relativeHumidityMeasurement` from the existing zone poll, `fanControl` for speed.
4. Fan speed: map `percentSetting` onto `FAN_SPEEDS`. Index 0 is `auto`, so a linear slider needs the same off-by-one care already documented at `src/settings.ts:197`. Only add MultiSpeed once Homebridge preserves the feature.
5. Vane: `airflowDirection` for fixed positions, `rockSetting` for `swing`. Both stay unimplemented until finding 3 clears. Do not ship a partial vane control; a silent no-op is worse than an absent control, since the adapter returns HTTP 200 for invalid writes.
6. Dry and Fan-only: separate `OnOffSwitch` endpoints or `MatterAccessoryPart` entries, mirroring the existing HAP switches.
7. Writes reuse `local-api.ts` / `kumo-api.ts` unchanged. Validate every vane and fan value client-side with `isVaneDirection` / `isFanSpeed` before the write — the adapter accepts garbage silently.
8. State sync: drive the Matter graph off the same `mirror.ts` update the HAP accessory consumes, so both views cannot diverge.

## How to re-verify each blocker

```sh
# 1. Homebridge version on latest
npm view homebridge version

# Pull the Matter source at whatever that version is (substitute the tag)
V=v2.2.1
for f in behaviors/FanControlBehavior.ts server/AccessoryManager.ts server/BehaviorMap.ts \
         clusterHandlerMap.ts clusterTypes.ts types.ts MatterAPIImpl.ts; do
  gh api "repos/homebridge/homebridge/contents/src/matter/$f?ref=$V" --jq .content \
    | base64 -d > "$(echo "$f" | tr / _)"
done

# 3a. Does the fan behavior watch anything beyond fanMode/percentSetting?
grep -n 'reactTo' behaviors_FanControlBehavior.ts

# 3b. Is there a fanControl feature-preservation branch yet? (zero hits in v2.2.1)
grep -n 'fanControl' server_AccessoryManager.ts

# 3c. Are rock/airflow handlers and state fields defined?
grep -n 'FanControlHandlers' -A 20 clusterHandlerMap.ts
grep -n 'FanControlState' -A 15 clusterTypes.ts
grep -n 'airflowDirection' clusterTypes.ts

# 4/5. Does the curated RoomAirConditioner carry AutoMode?
grep -n 'RoomAirConditioner:' -A 2 types.ts

# 2. Is deviceType still unconstrained, and is matter.js `devices` exposed on api.matter?
grep -n 'deviceType: EndpointType' types.ts
gh api "repos/homebridge/homebridge/contents/src/api.ts?ref=$V" --jq .content | base64 -d > api.ts
awk '/^export interface MatterAPI \{/,/^\}/' api.ts | grep -n 'readonly '
```

Docs to re-read: the homebridge-matter wiki [Enabling Matter](https://github.com/homebridge-plugins/homebridge-matter/wiki/Enabling-Matter) and [Section 9 HVAC](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-9-HVAC) pages, and Apple Developer Forums thread [805968](https://developer.apple.com/forums/thread/805968) for any follow-up from DTS.
