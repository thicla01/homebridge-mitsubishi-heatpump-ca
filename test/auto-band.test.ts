// Regression test: the AUTO band keeps the vendor's 1.5 °C minimum, the way the
// vendor app keeps it — and without reopening the scene race that collapsed bands
// upstream.
//
// Measured on 2026-09-27, on a GX15 with the kumo cloud app:
//   * the app keeps `spHeat` and `spCool` at least 1.5 °C apart;
//   * it does so by pushing the edge that did NOT move — heating 22 -> 22.5 against
//     cooling 23.5 pushed cooling to 24; cooling lowered into the band pushed
//     heating down;
//   * one way only — lowering heating back to 22 left cooling at 24;
//   * it edits one handle at a time, so it never has to decide what happens when
//     both edges move at once;
//   * the UNIT enforces nothing: a 0.5° band sent over the LAN was accepted and held.
// So without this, HomeKit could leave the unit in a state the vendor never allows,
// including an inverted band. See docs/protocol.md.
//
// The part that needed care is concurrency. A scene sets both edges in one burst
// and HomeKit dispatches them concurrently. An edge clamped against the other's
// CACHED value is clamped against a stale one: moving 21/22.5 to 23/26, the heating
// writer would see cooling at the old 22.5 and push it to 24.5 — and if that landed
// last, the scene would end at 23/24.5. The design takes the decision after the
// 1.5 s hold, against the other edge's PENDING value, and the harness below models
// what CLAUDE.md requires of every scene-race test: transport latency AND a per-
// device queue. A fake that resolves instantly could not tell the two designs apart.

import test from 'node:test';
import assert from 'node:assert';

import { KumoThermostatAccessory } from '../dist/accessory.js';
import {
  MIN_AUTO_BAND_C, cToF, enforceAutoBand, fToC, quantizeOutward, quantizeSetpointC,
} from '../dist/temperature.js';
import type { AutoBand } from '../dist/temperature.js';
import type { Commands, Zone } from '../dist/settings.js';
import { Characteristic, Service, makeLog, makeAccessory } from './helpers';

const SERIAL = 'TESTSERIAL001';

// The profile ranges of the unit the rule was measured on: heating 10-31, cooling
// 16-31 (its log line: "setpoint range heat 10-31°C, cool 16-31°C").
const HEAT = { min: 10, max: 31 };
const COOL = { min: 16, max: 31 };

// ---- the rule itself --------------------------------------------------------

test('a band that is already wide enough comes back untouched — which is what makes it one-way', () => {
  // Widening never pulls the pushed edge back: after 22.5/24, lowering heating to
  // 22 is just a wider band, and the vendor app left cooling at 24.
  const band: AutoBand = { spHeat: 22, spCool: 24 };
  assert.deepStrictEqual(enforceAutoBand(band, 'spHeat', true, HEAT, COOL), band);
  assert.deepStrictEqual(enforceAutoBand({ spHeat: 22, spCool: 23.5 }, 'spCool', true, HEAT, COOL),
    { spHeat: 22, spCool: 23.5 }, 'exactly 1.5 is allowed — the vendor holds 22/23.5 itself');
});

test('heating raised into the band pushes cooling up — the measured case', () => {
  assert.deepStrictEqual(
    enforceAutoBand({ spHeat: 22.5, spCool: 23.5 }, 'spHeat', true, HEAT, COOL),
    { spHeat: 22.5, spCool: 24 },
  );
});

test('cooling lowered into the band pushes heating down — the measured symmetric case', () => {
  assert.deepStrictEqual(
    enforceAutoBand({ spHeat: 22, spCool: 23 }, 'spCool', true, HEAT, COOL),
    { spHeat: 21.5, spCool: 23 },
  );
});

test('an inverted band is corrected, not just a narrow one', () => {
  // Heating above cooling is the state that most needs preventing, and nothing
  // stopped a Shortcut or a third-party controller from sending it.
  assert.deepStrictEqual(
    enforceAutoBand({ spHeat: 25, spCool: 24 }, 'spHeat', true, HEAT, COOL),
    { spHeat: 25, spCool: 26.5 },
  );
});

test('when both edges moved, heating is protected and cooling yields', () => {
  // Only HomeKit can produce this — the vendor app edits one handle at a time — so
  // this tie-break is the plugin's own choice, not the vendor's.
  assert.deepStrictEqual(
    enforceAutoBand({ spHeat: 22, spCool: 22.5 }, 'both', true, HEAT, COOL),
    { spHeat: 22, spCool: 23.5 },
  );
});

test('at the top of the range the moved edge gives way, since the pushed one cannot', () => {
  // Heating 30.5 would need cooling at 32 against a ceiling of 31. The band stays
  // valid rather than the request staying exact.
  assert.deepStrictEqual(
    enforceAutoBand({ spHeat: 30.5, spCool: 30.5 }, 'spHeat', true, HEAT, COOL),
    { spHeat: 29.5, spCool: 31 },
  );
});

test('at the bottom of the range the moved edge gives way too', () => {
  // Unreachable on this unit (cooling cannot go below 16, heating can go to 10),
  // so the ranges here are narrowed to reach it.
  const heat = { min: 18, max: 31 };
  assert.deepStrictEqual(
    enforceAutoBand({ spHeat: 20, spCool: 18.5 }, 'spCool', true, heat, COOL),
    { spHeat: 18, spCool: 19.5 },
  );
});

test('on the Fahrenheit grid the pushed edge lands on a whole °F, at least 1.5 °C away', () => {
  // 72 °F is stored as 22.3; cooling at 74 °F (23.4) is a 1.1° band.
  const heat72 = quantizeSetpointC(fToC(72));
  const kept = enforceAutoBand({ spHeat: heat72, spCool: quantizeSetpointC(fToC(74)) },
    'spHeat', false, HEAT, COOL);
  assert.ok(kept.spCool - kept.spHeat >= MIN_AUTO_BAND_C - 0.05,
    `band ${kept.spHeat}/${kept.spCool} is under 1.5`);
  assert.strictEqual(kept.spCool, quantizeSetpointC(fToC(Math.round(cToF(kept.spCool)))),
    'and it is a value the °F grid can display without drift');
});

test('the rule itself rounds outward, so an off-grid edge still gets its full 1.5', () => {
  // Heating 22.0, set in the vendor app on a Celsius account, read by a Fahrenheit
  // accessory. Nearest would store cooling at 23.4 (74 °F): a 1.4° band.
  const kept = enforceAutoBand({ spHeat: 22, spCool: 22.5 }, 'spHeat', false, HEAT, COOL);
  assert.strictEqual(kept.spCool, 23.9, '75 °F — not 23.4, which is 74 °F and 0.1 short');
});

test('rounding outward never lands short; rounding to nearest does, from an off-grid edge', () => {
  // Why quantizeOutward exists. From a value this plugin quantized, nearest is
  // enough — but an edge set in the vendor app on a Celsius account, or at the IR
  // remote, is not on the °F grid. Heating 22.0 read by a Fahrenheit accessory:
  // 23.5 rounds to 74 °F, stored as 23.4, a 1.4° band.
  assert.strictEqual(quantizeSetpointC(22 + MIN_AUTO_BAND_C), 23.4, 'the premise: nearest lands short');
  assert.strictEqual(quantizeOutward(22 + MIN_AUTO_BAND_C, 1, false), 23.9);

  let shortNearest = 0;
  for (let c = 10; c <= 33.5; c = Math.round((c + 0.1) * 10) / 10) {
    const up = quantizeOutward(c + MIN_AUTO_BAND_C, 1, false);
    const down = quantizeOutward(c - MIN_AUTO_BAND_C, -1, false);
    assert.ok(up - c >= MIN_AUTO_BAND_C - 0.05, `outward up from ${c} landed at ${up}`);
    assert.ok(c - down >= MIN_AUTO_BAND_C - 0.05, `outward down from ${c} landed at ${down}`);
    if (quantizeSetpointC(c + MIN_AUTO_BAND_C) - c < MIN_AUTO_BAND_C - 0.05) {
      shortNearest++;
    }
  }
  assert.ok(shortNearest > 0, 'if nearest were never short, quantizeOutward would be dead weight');
});

// ---- the accessory: when, and against what, the decision is taken ----------

interface Sent { commands: Commands; at: number }

/**
 * A transport with the two properties a scene race needs: every command takes
 * 300 ms, and commands are strictly serialised, as the per-device mutex makes them.
 * Both holds therefore expire before either send completes, which is the window in
 * which a decision against a cached value goes wrong.
 */
function makeHarness(
  { celsius = true, sendResult = true, localClient = undefined as unknown }: {
    celsius?: boolean; sendResult?: boolean; localClient?: unknown;
  } = {},
) {
  const sent: Sent[] = [];
  let lane: Promise<boolean> = Promise.resolve(true);
  const t0 = Date.now();
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    kumoConfig: {},
    localClient,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    unsubscribeFromDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(_serial: string, commands: Commands) {
      const mine = JSON.parse(JSON.stringify(commands)) as Commands;
      lane = lane
        .then(() => new Promise<void>((r) => setTimeout(r, 300)))
        .then(() => {
          sent.push({ commands: mine, at: Date.now() - t0 });
          return sendResult;
        });
      return lane;
    },
  };
  const accessory = makeAccessory('Salon', SERIAL);
  if (celsius) {
    (accessory.context as unknown as Record<string, unknown>).displayUnits = 'C';
  }
  const handler = new KumoThermostatAccessory(
    platform as never, accessory as never, kumoAPI as never, 30,
  );
  const threshold = (name: 'HeatingThresholdTemperature' | 'CoolingThresholdTemperature') =>
    accessory.getService(Service.HeaterCooler)!.getCharacteristic(Characteristic[name]).value;
  return { handler, sent, threshold };
}

const zone = (over: Record<string, unknown> = {}): Zone => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'auto',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 22, spAuto: null, humidity: null,
    ...over,
  },
}) as unknown as Zone;

/** Where the unit ends up: every command applied in the order it landed. */
function finalBand(start: AutoBand, sent: Sent[]): AutoBand {
  const band = { ...start };
  for (const { commands } of sent) {
    if (typeof commands.spHeat === 'number') {
      band.spHeat = commands.spHeat;
    }
    if (typeof commands.spCool === 'number') {
      band.spCool = commands.spCool;
    }
  }
  return band;
}

const settle = () => new Promise((r) => setTimeout(r, 2600));

test('a Home app drag of cooling into the band pushes heating down, in the same command', async () => {
  // The Home app writes BOTH handles on every drag. The heating one is a
  // re-assertion of 22 and is dropped before it registers — so the dragged edge is
  // the only one moving, exactly as in the vendor app.
  const { handler, sent, threshold } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 22, spCool: 24 }));

  await Promise.all([
    handler.setCoolingThresholdTemperature(22.5),
    handler.setHeatingThresholdTemperature(22),
  ]);
  await settle();

  assert.deepStrictEqual(sent.map((s) => s.commands), [{ spCool: 22.5, spHeat: 21 }],
    'one command carrying both edges, so they cannot land apart');
  assert.strictEqual(threshold('HeatingThresholdTemperature'), 21,
    'HomeKit never asked for heating to move, so it has to be told');
  assert.strictEqual(threshold('CoolingThresholdTemperature'), 22.5);
});

for (const order of ['heating first', 'cooling first'] as const) {
  test(`a scene is never clamped against the other edge's stale value (${order})`, async () => {
    // THE trap. From 21/22.5 to 23/26, the scene's own band is valid and must land
    // exactly. Decided against the cached cooling of 22.5, heating's writer would
    // push cooling to 24.5; with cooling dispatched first, that push lands last and
    // the scene ends at 23/24.5. Both dispatch orders are run because a design that
    // is only right in one of them is the bug waiting for the other.
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone({ spHeat: 21, spCool: 22.5 }));

    const heat = () => handler.setHeatingThresholdTemperature(23);
    const cool = () => handler.setCoolingThresholdTemperature(26);
    await Promise.all(order === 'heating first' ? [heat(), cool()] : [cool(), heat()]);
    await settle();

    assert.deepStrictEqual(finalBand({ spHeat: 21, spCool: 22.5 }, sent), { spHeat: 23, spCool: 26 },
      'the scene must land as captured. Sent: ' + JSON.stringify(sent.map((s) => s.commands)));
    assert.ok(!sent.some((s) => s.commands.spCool === 24.5),
      'no command may carry a push computed from the stale 22.5');
  });

  test(`a scene into a too-narrow band converges with heating protected (${order})`, async () => {
    // Both edges moved, so neither writer pushes the other; each sends its own field,
    // computed from the same pending state, and they agree.
    const { handler, sent, threshold } = makeHarness();
    handler.updateFromZone(zone({ spHeat: 21, spCool: 24 }));

    const heat = () => handler.setHeatingThresholdTemperature(22);
    const cool = () => handler.setCoolingThresholdTemperature(22.5);
    await Promise.all(order === 'heating first' ? [heat(), cool()] : [cool(), heat()]);
    await settle();

    assert.deepStrictEqual(finalBand({ spHeat: 21, spCool: 24 }, sent), { spHeat: 22, spCool: 23.5 },
      'Sent: ' + JSON.stringify(sent.map((s) => s.commands)));
    assert.ok(sent.every((s) => Object.keys(s.commands).length === 1),
      'each writer sends only its own field — a cross-push would be a second, redundant '
      + 'command on an adapter that takes one connection at a time. Sent: '
      + JSON.stringify(sent.map((s) => s.commands)));
    assert.strictEqual(threshold('CoolingThresholdTemperature'), 23.5,
      'the yielded edge shows what was actually sent, not what was asked');
  });
}

test('outside AUTO nothing is pushed — the other edge is invisible there', async () => {
  // In HEAT the Home app shows only the heating threshold. Pushing cooling from here
  // would rewrite a setting the user cannot see, and meet them next summer.
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', spHeat: 20, spCool: 23 }));

  await handler.setHeatingThresholdTemperature(22.5);
  await settle();

  assert.deepStrictEqual(sent.map((s) => s.commands), [{ spHeat: 22.5 }]);
});

test('a poll arriving while the pushed edge is in flight does not snap its tile back', async () => {
  // The pushed edge is guarded exactly like the moved one. Unguarded, the first
  // poll after the push — still carrying the old heating of 22 — would put the
  // handle back for one cycle: the bounce 2.3.1 removed for the moved edge.
  const { handler, threshold } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 22, spCool: 24 }));

  await handler.setCoolingThresholdTemperature(22.5);
  await settle();
  assert.strictEqual(threshold('HeatingThresholdTemperature'), 21, 'the push landed');

  handler.updateFromZone(zone({ spHeat: 22, spCool: 22.5 })); // a lagging read

  assert.strictEqual(threshold('HeatingThresholdTemperature'), 21,
    'a read taken before the adapter applied the push must not undo it');
});

test('a failed command leaves the pushed edge untouched and unguarded', async () => {
  // The pushed edge rode the same command and failed with it. Its tile was never
  // updated, so there is nothing to revert — but a guard left behind would hold a
  // value the device never took over the next honest poll.
  const { handler, threshold } = makeHarness({ sendResult: false });
  handler.updateFromZone(zone({ spHeat: 22, spCool: 24 }));

  await handler.setCoolingThresholdTemperature(22.5);
  await settle();

  assert.strictEqual(threshold('HeatingThresholdTemperature'), 22, 'heating was never moved');
  const pending = (handler as unknown as { setpointPending: Map<string, number> }).setpointPending;
  assert.ok(!pending.has('spHeat'), 'and no guard is left on it');
});

test('a push is confirmed by the next poll, not by a second status read', async () => {
  // Each setpoint reconcile is a full status read over the LAN. Reconciling the
  // pushed edge too would read the unit twice, a moment apart, on an adapter that
  // takes about one connection at a time. Only the LAN path reconciles at all, so
  // this is the one test here that goes through a local client.
  const reads: string[] = [];
  const { handler } = makeHarness({
    localClient: {
      hasLocal: () => true,
      sendCommand: () => Promise.resolve(true),
      getStatus: (serial: string) => {
        reads.push(serial);
        return Promise.resolve(null);
      },
    },
  });
  handler.updateFromZone(zone({ spHeat: 22, spCool: 24 }));

  await handler.setCoolingThresholdTemperature(22.5); // pushes heating to 21
  await new Promise((r) => setTimeout(r, 4000));      // past the 2 s reconcile

  assert.strictEqual(reads.length, 1, 'one read for the moved edge, none for the pushed one');
});
