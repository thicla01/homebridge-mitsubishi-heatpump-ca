// Guards the shape of config.schema.json, which nothing else in the suite touches.
//
// The Homebridge verification bot rejected 2.1.0 for carrying draft-3 style
// `"required": true` on individual properties. It rendered correctly anyway — the UI runs
// convertSchemaToDraft6 first — so nothing failed and nothing caught it. In JSON Schema
// proper, `required` is an array of property names on the enclosing object.
//
// No ajv here on purpose: the file also carries Homebridge UI keywords (`placeholder`,
// `titleMap`, `condition`) that a strict JSON Schema validator rejects, so pulling one in
// would mean silencing it. These assertions target the mistake that actually happened.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validatePlatformConfig } from '../dist/platform.js';
import type { KumoConfig } from '../dist/settings.js';

interface SchemaNode {
  type?: string;
  required?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

// `properties` is indexed by name in the layout checks below, so the root node is
// typed the same way the walker already assumes.

const schemaPath = join(__dirname, '..', 'config.schema.json');
const raw = readFileSync(schemaPath, 'utf8');
const config = JSON.parse(raw) as { pluginAlias: string; pluginType: string; schema: SchemaNode };

/** Every object node in the schema, at any depth. */
function walk(node: SchemaNode, path: string, out: Array<[string, SchemaNode]> = []) {
  out.push([path, node]);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    walk(child, `${path}.${key}`, out);
  }
  if (node.items) {
    walk(node.items, `${path}[]`, out);
  }
  return out;
}

const nodes = walk(config.schema, 'schema');

test('config.schema.json is valid JSON', () => {
  assert.ok(config.schema, 'has a schema key');
  assert.strictEqual(config.pluginType, 'platform');
  assert.strictEqual(config.pluginAlias, 'KumoV3');
});

test('no node uses the draft-3 boolean form of required', () => {
  const offenders = nodes
    .filter(([, n]) => typeof n.required === 'boolean')
    .map(([p]) => p);
  assert.deepStrictEqual(offenders, [], 'required must be an array on the parent object');
});

test('every required entry is an array of strings naming real properties', () => {
  for (const [path, node] of nodes) {
    if (node.required === undefined) {
      continue;
    }
    assert.ok(Array.isArray(node.required), `${path}.required is an array`);
    for (const name of node.required as unknown[]) {
      assert.strictEqual(typeof name, 'string', `${path}.required entries are strings`);
      assert.ok(
        node.properties && name as string in node.properties,
        `${path}.required names "${name}", which is not a property of ${path}`,
      );
    }
  }
});

test('only name is unconditionally required, because credentials are not always needed', () => {
  // This list used to be ['name', 'username', 'password'], on the reasoning that it
  // matched what the platform enforces. Local-only mode (`localOnly: true`) broke
  // that premise rather than the assertion: it never signs in, so a valid config in
  // that mode has no username or password at all, and a root-level `required` — which
  // JSON Schema cannot make conditional — would have made the objective config
  // unsavable in the UI form. The credential rule now lives entirely in
  // validatePlatformConfig, which knows which mode is in play; the form expresses it
  // as a layout `condition` instead. The test below pins that the runtime rule is
  // still enforced, so relaxing this array did not relax the requirement itself.
  assert.deepStrictEqual(config.schema.required, ['name']);
});

test('the credential fields still exist and are still enforced at runtime', () => {
  const props = config.schema.properties ?? {};
  assert.ok(props.username, 'username is still offered by the form');
  assert.ok(props.password, 'password is still offered by the form');

  // The real gate, in the mode where credentials ARE needed.
  const cloud = { name: 'test', platform: 'KumoV3' } as unknown as KumoConfig;
  assert.match(
    validatePlatformConfig(cloud) ?? '',
    /Username and password are required/,
    'a cloud config with no credentials is still rejected',
  );
});

test('the local-only form fields exist, since the mode is unusable without them', () => {
  const props = config.schema.properties ?? {};
  assert.strictEqual(props.localOnly?.type, 'boolean');

  const devices = props.localDevices;
  assert.strictEqual(devices?.type, 'array', 'localDevices is an array of unit declarations');
  assert.ok(devices.items?.properties, 'with per-unit fields the form can render');
});

test('the two v2 bootstrap options render as dropdowns with the right values', () => {
  // oneOf + enum is the form the Homebridge UI renders as a select. A bare `enum`
  // renders too, but with no human-readable labels — and these two options carry the
  // one thing a user cannot guess (which host serves their account).
  const props = config.schema.properties ?? {};
  for (const [name, values, dflt] of [
    // cloudRegion may keep its default: "us" is what an absent value means anyway,
    // so the UI writing it changes nothing.
    ['cloudRegion', ['us', 'ca'], 'us'],
    // localCredentialSource may NOT. See the test below.
    ['localCredentialSource', ['v3', 'v2'], undefined],
  ] as Array<[string, string[], string | undefined]>) {
    const node = props[name] as unknown as {
      type?: string; default?: string; oneOf?: Array<{ title?: string; enum?: string[] }>;
    };
    assert.ok(node, `${name} is offered by the form`);
    assert.strictEqual(node.type, 'string');
    assert.strictEqual(node.default, dflt);
    assert.deepStrictEqual(node.oneOf?.flatMap((o) => o.enum ?? []), values);
    for (const option of node.oneOf ?? []) {
      assert.ok(option.title && option.title.length > 0, `${name} labels every option`);
    }
  }
});

// ---- a field whose ABSENCE is meaningful must carry no default --------------
// Saving the plugin's settings form materialises every schema `default` into
// config.json. So a default does not mean "the value used when unset" — it means
// "the value written the first time anyone opens this page", which is
// indistinguishable from a deliberate choice ever after.
//
// On 2026-08-19 that turned a working Canadian install idle: pressing Save wrote
// `localCredentialSource: "v3"`, and `cloudRegion: "ca"` cannot use v3. It also
// fabricated a whole localDevices entry out of the ten capability defaults, with
// hasModeDry/hasModeVent false and a heat floor of 16°C — which would have deleted
// the Dry and Fan switches and cut 6°C off the bottom of the real 10-31 range.
//
// The runtime absorbs both now (reconcileImpliedConfig, and localDevices being
// ignored outside local-only mode), but the schema must not manufacture them in
// the first place.

test('localCredentialSource carries no default, because its absence means "derive from the region"', () => {
  const node = (config.schema.properties ?? {})['localCredentialSource'] as unknown as Record<string, unknown>;
  assert.ok(node, 'still offered');
  assert.ok(!('default' in node),
    'a default here is written into config.json by the UI and then contradicts cloudRegion "ca"');
});

test('no localDevices capability carries a default, because each one fabricates a fake profile', () => {
  const items = ((config.schema.properties ?? {})['localDevices'] as unknown as {
    items?: { properties?: Record<string, Record<string, unknown>> };
  }).items;
  const props = items?.properties ?? {};
  assert.ok(Object.keys(props).length > 0, 'the entry shape is still described');

  const withDefaults = Object.entries(props)
    .filter(([, node]) => 'default' in node)
    .map(([name]) => name);
  assert.deepStrictEqual(withDefaults, [],
    'the UI materialises these into a phantom entry the user never declared');
});

test('the runtime rejects a value the form could never produce', () => {
  // The form cannot emit anything but the enum values; a hand-edited config.json can,
  // and that is the normal way these options get set.
  assert.match(
    validatePlatformConfig({
      name: 'test', platform: 'KumoV3', username: 'u@e.com', password: 'p', cloudRegion: 'canada',
    } as unknown as KumoConfig) ?? '',
    /cloudRegion must be/,
  );
});

test('a localDevices entry requires the serial, the address and both secrets', () => {
  // The four values that have no default and cannot be discovered in this mode.
  // The walker above separately proves each name is a real property of the item.
  const devices = config.schema.properties?.localDevices;
  assert.ok(devices?.items, 'localDevices is an array with items');
  assert.deepStrictEqual(devices.items.required, ['deviceSerial', 'ip', 'password', 'cryptoSerial']);
});

// ---- layout / schema agreement -------------------------------------------
//
// A `layout` entry naming a property that does not exist does not fail anything: the
// Homebridge UI simply renders nothing for it, so the option silently disappears
// from the form. That is the same class of mistake as the draft-3 `required` above
// — invisible unless something checks it — and it got easy to make once the layout
// started carrying `localDevices[].<field>` paths.

/** Every property key referenced anywhere in the layout tree. */
function layoutKeys(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) {
      layoutKeys(child, out);
    }
  } else if (node && typeof node === 'object') {
    const obj = node as { key?: unknown; items?: unknown };
    if (typeof obj.key === 'string') {
      out.push(obj.key);
    }
    layoutKeys(obj.items, out);
  }
  return out;
}

const layout = (config as unknown as { layout: unknown }).layout;

test('every layout key names a property that exists', () => {
  const root = config.schema.properties ?? {};
  for (const key of layoutKeys(layout)) {
    // Either "prop" or "prop[].child", the array-item form used by mirror and
    // localDevices.
    const [head, child] = key.split('[].');
    assert.ok(root[head], `layout references "${key}", but ${head} is not a property`);
    if (child !== undefined) {
      assert.ok(
        root[head].items?.properties?.[child],
        `layout references "${key}", but ${child} is not a property of ${head}[]`,
      );
    }
  }
});

test('every option renders in the form — an option the form cannot render is one it DROPS', () => {
  // This used to allow one exception: localControlIps, a free-form serial -> IP map
  // the form could not express, with a help block telling the user to edit the JSON.
  // That exception cost a working install its pin on 2026-08-21 — reinstalling the
  // plugin through the UI rewrote the platform block from the schema and silently
  // took the override with it, and the startup LAN sweep came back with nothing in
  // the log to say why. The map is now an array of pairs, which the form CAN render,
  // and the runtime accepts both shapes.
  const referenced = new Set(layoutKeys(layout).map((k) => k.split('[].')[0]));
  const absent = Object.keys(config.schema.properties ?? {}).filter((p) => !referenced.has(p));
  assert.deepStrictEqual(absent, [], 'anything listed here can be dropped by the UI');
});

test('localControlIps is an array of pairs, not a free-form map', () => {
  const node = (config.schema.properties ?? {})['localControlIps'] as unknown as {
    type?: string; items?: { required?: string[]; properties?: Record<string, unknown> };
  };
  assert.strictEqual(node?.type, 'array', 'a bare object is unrenderable, and therefore droppable');
  assert.deepStrictEqual(node.items?.required, ['deviceSerial', 'ip']);
  assert.deepStrictEqual(Object.keys(node.items?.properties ?? {}), ['deviceSerial', 'ip']);
});

test('a mirror entry requires both ends', () => {
  const mirror = config.schema.properties?.mirror;
  assert.ok(mirror?.items, 'mirror is an array with items');
  assert.deepStrictEqual(mirror.items.required, ['source', 'target']);
});
