#!/usr/bin/env node
// What the kumo cloud's v2 sign-in says about each zone's wireless sensor and Dry
// Mode Automation — and nothing else.
//
// WHY IT EXISTS
//   On a GX15 with a PAC-USWHS003-TH-1 paired, linked to its zone, reporting
//   humidity and battery in the kumo app, the app still refused to enable Dry Mode
//   Automation: "Please add a wireless sensor or capable thermostat to the zone".
//   The v2 reply carries, per zone, a `kumoSensorSettings` and an `autoDrySettings`
//   that the plugin never reads. This tool shows them. Its first run, on that GX15
//   (2026-10-14), answered the question it was built for: the cloud HAD attached the
//   sensor to the zone — `kumoSensorSettings` held the adapter's own sensor uuid with
//   live battery, humidity, rssi, temperature and txPower — so the refusal comes from
//   somewhere else. `autoDrySettings` held isAutoDry, enable, targetHumid, overcool,
//   offset and active, all switched off. See docs/protocol.md.
//
// WHAT THE REPLY ALSO CONTAINS, AND WHY NONE OF IT IS PRINTED
//   The same reply carries every unit's LAN `password` and `cryptoSerial`, a session
//   token, and the account holder's name, phone and postal addresses. This tool
//   walks the zone tree, reads three named sub-objects per zone — the two above and
//   `mhk2Settings`, since the message also names "a capable thermostat" — plus the
//   zone's label, and prints only those, through a filter that drops any key that
//   looks like a secret or personal data and any long string. On an error the body
//   is not read at all: a v2 error body can echo the account address back.
//
// ONE SIGN-IN, NEVER RETRIED
//   It signs in exactly as the plugin does at startup — same host, path, body and
//   headers, redirects refused so the credentials cannot be sent anywhere else — and
//   stops at the first answer. A refused sign-in (401/403) is reported and not
//   repeated: repeating a rejected sign-in risks locking the account.
//
// CREDENTIALS
//   Read from the Homebridge config (the KumoV3 platform block): `username`,
//   `password`, `cloudRegion`. They are sent to the kumo cloud and printed nowhere.
//
// USAGE (on the Homebridge host)
//   sudo /opt/homebridge/bin/node kumo-v2-zones.mjs
//   sudo /opt/homebridge/bin/node kumo-v2-zones.mjs --config /path/to/config.json
//
//   Copy it beside the installed plugin, as for tools/kumo-probe.mjs: it borrows the
//   v2 endpoint and app version from the plugin's own dist/kumo-v2.js.
//
// For verification only, KUMO_V2_URL_OVERRIDE may point it at a local fake server —
// accepted for http://127.0.0.1 and http://localhost and nothing else, so the
// override can never send real credentials to another host.

import { readFileSync } from 'node:fs';

let v2Endpoint;
let V2_APP_VERSION;
for (const specifier of ['../dist/kumo-v2.js', 'homebridge-mitsubishi-heatpump-ca/dist/kumo-v2.js']) {
  try {
    ({ v2Endpoint, V2_APP_VERSION } = await import(specifier));
    break;
  } catch { /* try the next one */ }
}
if (!v2Endpoint) {
  console.error(
    'Cannot find the plugin\'s kumo-v2 module.\n'
    + '  In a repo checkout: run `npm run build` first.\n'
    + '  On a Homebridge host: copy this file somewhere the installed plugin resolves from,\n'
    + '  e.g. /var/lib/homebridge/ (which has node_modules alongside it).',
  );
  process.exit(1);
}

// ---- credentials, from the Homebridge config --------------------------------

const argv = process.argv.slice(2);
const at = argv.indexOf('--config');
const configPath = at === -1 ? '/var/lib/homebridge/config.json' : argv[at + 1];

let block;
try {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  block = (config.platforms ?? []).find((p) => p && p.platform === 'KumoV3');
} catch (err) {
  console.error(`Cannot read ${configPath}: ${err.message}`);
  process.exit(1);
}
if (!block || !block.username || !block.password) {
  console.error(`${configPath} has no KumoV3 platform block with a username and password.`);
  process.exit(1);
}
const region = String(block.cloudRegion ?? 'us').toLowerCase() === 'ca' ? 'ca' : 'us';

let { host, url } = v2Endpoint(region);
const override = process.env.KUMO_V2_URL_OVERRIDE;
if (override) {
  const u = new URL(override);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
    console.error('KUMO_V2_URL_OVERRIDE is for a local fake server only (http://127.0.0.1 or localhost).');
    process.exit(1);
  }
  host = u.host;
  url = override;
}

// ---- the sign-in -----------------------------------------------------------

console.log(`Signing in to ${host} once, as the plugin does at startup (region: ${region}).\n`);
let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: block.username, password: block.password, appVersion: V2_APP_VERSION }),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
} catch (err) {
  console.error(`${host} did not answer (${err.message}).`);
  process.exit(1);
}
if (!response.ok) {
  // The body is not read: it can echo the account address back.
  const refused = response.status === 401 || response.status === 403;
  console.error(`${host} answered HTTP ${response.status}.${refused
    ? ' The sign-in was refused, and is not retried: repeating it risks locking the account.'
    : ''}`);
  process.exit(1);
}
let raw;
try {
  raw = await response.json();
} catch {
  console.error(`${host} answered 200 with a body that is not JSON.`);
  process.exit(1);
}

// ---- the walk, and the only things printed -----------------------------------

/**
 * Keys never printed, whatever object they turn up in. Names are matched as
 * `firstName` / `lastName`, not as bare "first" / "last": the bare words withheld
 * `lastUpdated` from the first real run, which is exactly the field that says how
 * fresh the cloud's copy of the sensor is.
 */
const SENSITIVE = /pass|token|crypto|secret|email|phone|addr|street|zip|first_?name|last_?name|serial|mac/i;

/** A copy of `value` holding only what is safe to show. */
function safe(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length <= 64 ? value : `(string of ${value.length} characters, not shown)`;
  }
  if (depth > 3 || typeof value !== 'object') {
    return '(not shown)';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((v) => safe(v, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '(withheld)' : safe(v, depth + 1);
  }
  return out;
}

const zones = [];
function walk(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) {
    return;
  }
  if (node.zoneTable && typeof node.zoneTable === 'object') {
    for (const zone of Object.values(node.zoneTable)) {
      if (zone && typeof zone === 'object') {
        zones.push(zone);
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }
}
walk(Array.isArray(raw) ? raw[2] : undefined, 0);

if (zones.length === 0) {
  console.log('The reply holds no zones in the shape this tool knows. Nothing to show.');
  process.exit(0);
}
console.log(`${zones.length} zone(s).\n`);
for (const zone of zones) {
  const label = typeof zone.label === 'string' && zone.label.length <= 64 ? zone.label : '(unnamed)';
  console.log(`── ${label}`);
  for (const key of ['kumoSensorSettings', 'autoDrySettings', 'mhk2Settings']) {
    const shown = key in zone ? JSON.stringify(safe(zone[key])) : '(absent)';
    console.log(`   ${key}: ${shown}`);
  }
  console.log('');
}
console.log('Nothing else from the reply was printed. It also holds secrets and personal data.');
