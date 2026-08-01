// The shared test harness is only useful if it agrees with real HAP.
//
// Two ways it can silently disagree, both of which have actually happened here:
//
//   1. Enum drift. Ten hand-rolled copies of the harness encoded
//      TargetHeaterCoolerState.AUTO = 3 — the old *Thermostat* value — while HAP
//      defines AUTO = 0 for HeaterCooler. No test failed, because src never uses
//      a numeric literal for a HAP state, so the fake supplied both sides of
//      every assertion. helpers.ts now reads the members off hap-nodejs, so this
//      cannot recur; these tests pin that it really is reading them.
//
//   2. A service name that HAP does not define. The vane service is `Slats`, not
//      `Slat`, and a wrong name here would make every getService() lookup miss
//      and return null rather than fail loudly.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Characteristic as HapCharacteristic,
  Service as HapService,
} from '@homebridge/hap-nodejs';

import { Characteristic, Service, makeAccessory, makeService } from './helpers';

test('every service name in the harness is a real HAP service', () => {
  for (const [key, name] of Object.entries(Service)) {
    assert.equal(key, name, `${key} must map to its own name`);
    assert.ok(
      (HapService as unknown as Record<string, unknown>)[name],
      `Service.${name} is not defined by hap-nodejs (a typo here makes every ` +
        'getService() lookup silently return null)',
    );
  }
});

test('the harness reports the real HAP enum values, not copies', () => {
  // Spot-check the ones that have actually caused trouble. The two AUTOs are
  // opposite polarities, which is precisely what a single shared bag of
  // constants used to hide.
  assert.equal(
    Characteristic.TargetHeaterCoolerState.AUTO,
    HapCharacteristic.TargetHeaterCoolerState.AUTO,
  );
  assert.equal(Characteristic.TargetHeaterCoolerState.AUTO, 0);
  assert.equal(Characteristic.TargetFanState.AUTO, HapCharacteristic.TargetFanState.AUTO);
  assert.equal(Characteristic.TargetFanState.AUTO, 1);
  assert.notEqual(
    Characteristic.TargetHeaterCoolerState.AUTO,
    Characteristic.TargetFanState.AUTO,
  );
});

test('TargetHeaterCoolerState has no OFF member', () => {
  // Off lives on Active. A harness that invents an OFF here would let a test
  // assert a state the real characteristic cannot express.
  assert.equal(Characteristic.TargetHeaterCoolerState.OFF, undefined);
  assert.equal(
    (HapCharacteristic.TargetHeaterCoolerState as unknown as Record<string, unknown>).OFF,
    undefined,
  );
});

test('distinct characteristics do not alias each other', () => {
  // The old shared bag made AUTO(3) == COOLING(3) and HEAT(1) == ACTIVE(1) ==
  // IDLE(1), so a guard like notStrictEqual(current, INACTIVE) could be
  // satisfied by a value from an entirely different characteristic.
  assert.notEqual(Characteristic.Active._name, Characteristic.CurrentHeaterCoolerState._name);
  assert.equal(Characteristic.Active.ACTIVE, HapCharacteristic.Active.ACTIVE);
  assert.equal(
    Characteristic.CurrentHeaterCoolerState.COOLING,
    HapCharacteristic.CurrentHeaterCoolerState.COOLING,
  );
});

test('a name HAP does not define yields no members', () => {
  // Reading an unknown constant must come back undefined rather than matching
  // something by accident.
  assert.equal(Characteristic.NotARealCharacteristic.SOMETHING, undefined);
  assert.equal(Characteristic.NotARealCharacteristic._name, 'NotARealCharacteristic');
});

test('getCharacteristic adds on lookup, like real HAP does', () => {
  // hap-nodejs's Service.getCharacteristic() ADDS an optional characteristic as
  // a side effect. Several fixes in this repo depend on that behaviour being
  // faithfully modelled — it is how a post-publish characteristic sneaks in.
  const svc = makeService(Service.Fanv2, 'Test Fan', 'airflow');
  assert.equal(svc.chars.size, 0);
  svc.getCharacteristic(Characteristic.RotationSpeed);
  assert.equal(svc.chars.size, 1);
});

test('makeAccessory distinguishes services by subtype', () => {
  const acc = makeAccessory();
  acc.addService(Service.Switch, 'Dry', 'dry');
  acc.addService(Service.Switch, 'Fan', 'fan-only');

  assert.equal(acc.getServiceById(Service.Switch, 'dry')!.name, 'Dry');
  assert.equal(acc.getServiceById(Service.Switch, 'fan-only')!.name, 'Fan');
  assert.equal(acc.getServiceById(Service.Switch, 'nope'), null);
});
