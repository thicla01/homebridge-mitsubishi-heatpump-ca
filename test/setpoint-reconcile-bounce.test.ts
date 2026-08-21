// Regression test: a superseded setpoint reconcile must not publish.
//
// After each accepted setpoint write the plugin re-reads the unit 2s later and
// publishes whatever the device actually kept (scheduleSetpointReconcile), because
// the adapter silently clamps or rounds. But the reconcile was not versioned, so
// two ordinary steps scheduled two of them.
//
// Observed live 2026-08-20, stepping the Home app 22 -> 22.5 -> 23 with ~2s between
// taps: the FIRST reconcile read the adapter before it had applied the second
// write, found 22.5, and published it over the 23 already on the tile. The second
// reconcile then put 23 back. The value the user had just set visibly bounced, and
// the log carried two contradictory lines blaming the device for holding a value
// nobody was asking it to keep any more:
//
//   device holds spCool=22.5°C, we asked for 23°C   — publishing the device's value
//   device holds spCool=23°C,   we asked for 22.5°C — publishing the device's value
//
// The write path already had the generation counter for exactly this (setpointWriteGen,
// via holdSetpointWrite); the reconcile just was not consulting it.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import type { Commands, DeviceStatus, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

/**
 * A fake adapter with the property that causes the bug: it does not report a new
 * setpoint the instant it accepts one. Live on 2026-08-20 it was still answering
 * the previous value more than a second after accepting the next command, which is
 * what a reconcile scheduled 2s behind its own write ends up reading.
 */
const APPLY_MS = 1200;

function makeLocalAdapter(initial: number) {
  const statusCalls: number[] = [];
  let reported = initial;
  return {
    statusCalls,
    hasLocal: () => true,
    sendCommand(_serial: string, commands: Commands) {
      const next = commands.spCool;
      if (typeof next === 'number') {
        // Accepted now, visible later.
        setTimeout(() => { reported = next; }, APPLY_MS).unref();
      }
      return Promise.resolve(true);
    },
    getStatus() {
      statusCalls.push(reported);
      return Promise.resolve({ spCool: reported } as Partial<DeviceStatus>);
    },
  };
}

function makeHarness(local: ReturnType<typeof makeLocalAdapter>) {
  const setpointLines: string[] = [];
  const platform = {
    Service,
    Characteristic,
    log: {
      ...makeLog(),
      info: (...args: unknown[]) => {
        const line = args.join(' ');
        if (line.includes('[SETPOINT]')) {
          setpointLines.push(line);
        }
      },
    },
    api: { updatePlatformAccessories() {} },
    kumoConfig: { showDrySwitch: true, showFanOnlySwitch: true, exposeVaneSlat: true },
    localClient: local,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(_s: string, _c: Commands) {
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory('Salon');
  // The live account is Celsius, which is what puts the setpoints on the 0.5 grid
  // the user actually stepped through (22 -> 22.5 -> 23). Without this the
  // Fahrenheit-anchored quantizer turns 23 into 22.8 and the fixture stops
  // describing the reported bug.
  (accessory.context as Record<string, unknown>).displayUnits = 'C';
  const handler = new KumoThermostatAccessory(
    platform as never,
    accessory as never,
    kumoAPI as never,
    30,
  );
  return { handler, accessory, setpointLines };
}

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 22, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

/** Long enough for a scheduled reconcile (2s) to have fired. */
const afterReconcile = () => new Promise((r) => setTimeout(r, 2600));

function coolingHandle(accessory: ReturnType<typeof makeHarness>['accessory']) {
  const svc = accessory.getService(Service.HeaterCooler);
  return svc?.chars.get(Characteristic.CoolingThresholdTemperature)?.value;
}

test('the reconcile of a superseded write never reads the device, let alone publishes', async () => {
  const local = makeLocalAdapter(22);
  const { handler, accessory, setpointLines } = makeHarness(local);
  handler.updateFromZone(zone({ spCool: 22 }));

  // 22 -> 22.5 -> 23, the sequence that bounced live. Each setter is awaited, so
  // the second write begins while the first reconcile is still pending.
  await handler.setCoolingThresholdTemperature(22.5);
  await handler.setCoolingThresholdTemperature(23);
  await afterReconcile();

  assert.strictEqual(local.statusCalls.length, 1,
    'only the latest write reconciles; the superseded one bails before reading');
  assert.strictEqual(coolingHandle(accessory), 23,
    'the tile holds what the user set, with no detour through 22.5');
  assert.deepStrictEqual(setpointLines, [],
    'and nothing is reported as a disagreement, because there is none. '
    + 'Got: ' + JSON.stringify(setpointLines));
});

test('a single write still reconciles, and the device is still the authority', async () => {
  // The control: versioning must not disable the mechanism. This adapter refuses
  // the request and keeps its own value, which is exactly what the reconcile exists
  // to surface.
  const local = makeLocalAdapter(24);
  const stubborn = { ...local, sendCommand: () => Promise.resolve(true) };
  const { handler, accessory, setpointLines } = makeHarness(stubborn);
  handler.updateFromZone(zone({ spCool: 22 }));

  await handler.setCoolingThresholdTemperature(23);
  await afterReconcile();

  assert.strictEqual(stubborn.statusCalls.length, 1, 'the reconcile ran');
  assert.strictEqual(coolingHandle(accessory), 24,
    'the device is the authority on what it kept');
  assert.strictEqual(setpointLines.length, 1,
    'and the disagreement is reported once');
});
