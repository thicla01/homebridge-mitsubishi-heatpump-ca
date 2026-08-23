// Mechanical HAP fakes, shared by every accessory test. Only the parts that were
// byte-identical in each file live here: the Characteristic identity map, the
// Service name map, and the service/accessory stubs. Per-file setup (harnesses,
// zone and profile payloads) deliberately stays in its own test file, where the
// values are the subject rather than scaffolding.
//
// Enum members are READ FROM hap-nodejs at runtime rather than copied here.
// Copies drift: 10 of the 13 hand-rolled versions of this file encoded
// TargetHeaterCoolerState.AUTO = 3, which is the old *Thermostat*
// characteristic's value, and HAP defines AUTO = 0 for HeaterCooler. Typing a
// hand-copied table would only assert that the wrong number is a number;
// deriving it makes that class of drift impossible.

import { Characteristic as HapCharacteristic } from '@homebridge/hap-nodejs';

/** A stand-in for a HAP Characteristic. Structural, not a real HAP object. */
export interface FakeCharacteristic {
  value: unknown;
  props?: Record<string, unknown>;
  onGet(handler?: unknown): FakeCharacteristic;
  onSet(handler?: unknown): FakeCharacteristic;
  setProps(props: Record<string, unknown>): FakeCharacteristic;
  updateValue(value: unknown): FakeCharacteristic;
}

/** A stand-in for a HAP Service. `type` is the name string from `Service` below. */
export interface FakeService {
  type: string;
  name?: string;
  subtype?: string;
  /**
   * Every characteristic this service has been asked for.
   *
   * Exposed so a test can ask whether a characteristic was ever *added* without
   * adding it by asking. That mirrors real HAP: hap-nodejs's
   * `Service.getCharacteristic()` ADDS an optional characteristic as a side
   * effect of the lookup, which is exactly how a post-publish characteristic
   * sneaks in unpublished.
   */
  chars: Map<unknown, FakeCharacteristic>;
  getCharacteristic(id: unknown): FakeCharacteristic;
  setCharacteristic(id: unknown, value: unknown): FakeService;
  updateCharacteristic(id: unknown, value: unknown): FakeService;
}

/** A stand-in for a Homebridge PlatformAccessory. */
export interface FakeAccessory {
  displayName: string;
  context: { device: { deviceSerial: string; siteId: string; displayName: string } };
  getService(type: string): FakeService | null;
  getServiceById(type: string, subtype: string): FakeService | null;
  addService(type: string, name?: string, subtype?: string): FakeService;
  removeService(service: FakeService): void;
}

export interface FakeLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Copy a real characteristic class's numeric constants.
 *
 * HAP declares them as static members (`TargetHeaterCoolerState.AUTO = 0`), so
 * the uppercase numeric statics are exactly the enum. `UUID` is a string and is
 * skipped by the type test.
 */
function realMembers(name: string): Record<string, number> {
  const cls = (HapCharacteristic as unknown as Record<string, unknown>)[name];
  if (typeof cls !== 'function') {
    return {};
  }
  const members: Record<string, number> = {};
  for (const key of Object.getOwnPropertyNames(cls)) {
    const value = (cls as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number' && /^[A-Z][A-Z0-9_]*$/.test(key)) {
      members[key] = value;
    }
  }
  return members;
}

/**
 * Stable characteristic identifiers: the same object comes back for a given
 * name, so it can be used as a Map key the way hap-nodejs uses the real class.
 * A name HAP does not define gets no members, which makes a mistyped constant
 * read as undefined instead of silently matching something else.
 */
const charCache: Record<string, { _name: string } & Record<string, unknown>> = {};
export const Characteristic: Record<string, { _name: string } & Record<string, number>> =
  new Proxy({}, {
    get(_target, prop: string) {
      if (!charCache[prop]) {
        charCache[prop] = { _name: String(prop), ...realMembers(prop) };
      }
      return charCache[prop];
    },
  }) as Record<string, { _name: string } & Record<string, number>>;

export const Service = {
  AccessoryInformation: 'AccessoryInformation',
  Thermostat: 'Thermostat',
  HeaterCooler: 'HeaterCooler',
  Fanv2: 'Fanv2',
  Slats: 'Slats',
  HumiditySensor: 'HumiditySensor',
  Switch: 'Switch',
  FilterMaintenance: 'FilterMaintenance',
  Battery: 'Battery',
};

export function makeLog(): FakeLog {
  const noop = () => { /* silent in tests */ };
  return { info: noop, warn: noop, error: noop, debug: noop };
}

export function makeCharacteristic(): FakeCharacteristic {
  const ch: FakeCharacteristic = {
    value: undefined,
    onGet() {
      return ch;
    },
    onSet() {
      return ch;
    },
    setProps(props: Record<string, unknown>) {
      ch.props = props;
      return ch;
    },
    updateValue(value: unknown) {
      ch.value = value;
      return ch;
    },
  };
  return ch;
}

export function makeService(type: string, name?: string, subtype?: string): FakeService {
  const chars = new Map<unknown, FakeCharacteristic>();
  const svc: FakeService = {
    type,
    name,
    subtype,
    chars,
    getCharacteristic(id: unknown) {
      if (!chars.has(id)) {
        chars.set(id, makeCharacteristic());
      }
      return chars.get(id)!;
    },
    setCharacteristic(id: unknown, value: unknown) {
      svc.getCharacteristic(id).value = value;
      return svc;
    },
    updateCharacteristic(id: unknown, value: unknown) {
      svc.getCharacteristic(id).value = value;
      return svc;
    },
  };
  return svc;
}

/**
 * AccessoryInformation is pre-seeded because the accessory constructor calls
 * `getService(...)!` on it and would throw on null.
 */
export function makeAccessory(
  displayName = 'Kitchen',
  deviceSerial = 'TESTSERIAL001',
): FakeAccessory {
  const entries: Array<{ type: string; subtype?: string; svc: FakeService }> = [
    {
      type: Service.AccessoryInformation,
      subtype: undefined,
      svc: makeService(Service.AccessoryInformation),
    },
  ];
  return {
    displayName,
    context: { device: { deviceSerial, siteId: 'site-1', displayName } },
    getService(type: string) {
      const e = entries.find((x) => x.type === type && x.subtype === undefined);
      return e ? e.svc : null;
    },
    getServiceById(type: string, subtype: string) {
      const e = entries.find((x) => x.type === type && x.subtype === subtype);
      return e ? e.svc : null;
    },
    addService(type: string, name?: string, subtype?: string) {
      const svc = makeService(type, name, subtype);
      entries.push({ type, subtype, svc });
      return svc;
    },
    removeService(service: FakeService) {
      const i = entries.findIndex((x) => x.svc === service);
      if (i >= 0) {
        entries.splice(i, 1);
      }
    },
  };
}
