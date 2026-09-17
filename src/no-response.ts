/**
 * How this plugin tells HomeKit "I do not know", instead of guessing.
 *
 * Two callers, one mechanism. `accessory.ts` refuses reads on a unit the poller
 * has given up on (2.3.4); `platform.ts` refuses them on an accessory that is
 * published but has no live handler behind it — a unit whose local credentials
 * came back empty, or one whose inventory has not arrived yet because the cloud
 * was down at the moment Homebridge restarted.
 *
 * Both cases are the same lie if left alone: a tile that renders a plausible
 * number and quietly does nothing with a command. The number is the dangerous
 * part — nobody re-checks a reading that looks fine.
 */

/**
 * Homebridge's `api`, narrowed to the part of hap-nodejs we need.
 *
 * Read off the live object rather than imported: the plugin has no runtime
 * dependency on hap-nodejs (Homebridge injects it) and both callers are also
 * built by tests against a minimal fake with no `hap` at all.
 */
type HapCarrier = {
  hap?: {
    HapStatusError?: new (status: number) => Error;
    HAPStatus?: { SERVICE_COMMUNICATION_FAILURE: number };
  };
};

/**
 * Throw what makes HomeKit answer "No Response".
 *
 * Any rejection makes HAP report a communication failure to the controller; the
 * typed error only names the status explicitly, so the plain-Error fallback is a
 * less precise path rather than a degraded one.
 */
export function throwCommunicationFailure(api: unknown, message: string): never {
  const hap = (api as HapCarrier | undefined)?.hap;
  const status = hap?.HAPStatus?.SERVICE_COMMUNICATION_FAILURE;
  if (hap?.HapStatusError && typeof status === 'number') {
    throw new hap.HapStatusError(status);
  }
  throw new Error(message);
}

/**
 * The characteristics a handler-less accessory is silenced on.
 *
 * Every one is bound by `KumoThermostatAccessory`'s constructor **unconditionally**
 * — no `if` on the path (accessory.ts, the HeaterCooler block) — and hap-nodejs's
 * `onGet` assigns rather than appends (`this.getHandler = handler`). Together
 * those two facts are what make this safe: the placeholder cannot outlive the
 * real handler's construction, and a placeholder that DID outlive it would be
 * permanent No Response, which is worse than the stale tile it replaces.
 *
 * That guarantee is not left to inspection. `test/unconfigured-accessory.test.ts`
 * builds a real handler and asserts every name below received a get handler, so
 * moving one of these bindings behind a condition fails the suite.
 *
 * They all live on the HeaterCooler, the one service a unit always has.
 */
export const UNCONFIGURED_GUARD_CHARACTERISTICS = [
  'Active',
  'CurrentHeaterCoolerState',
  'TargetHeaterCoolerState',
  'CurrentTemperature',
  'HeatingThresholdTemperature',
  'CoolingThresholdTemperature',
  'TemperatureDisplayUnits',
] as const;
