// Security regression: no v3 fetch may follow redirects.
//
// A 307/308 re-sends the request — including the {username, password} login body,
// the {refresh: <token>} refresh body, and the bearer header — to whatever host the
// Location names, cross-origin and even https->http. kumo-v2.ts has always guarded
// this (redirect: 'error'); the v3 module did not, until 2.3.0. This asserts every
// fetch in kumo-api.ts is guarded, so a newly added one cannot silently regress.
//
// Reads the source rather than mocking global fetch: the guard is a property of the
// call site, and the API_BASE_URL host is hard-coded, so a behavioural test would
// need to intercept DNS. A source check is the honest shape of "every call site
// passes this option".

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'src', 'kumo-api.ts'), 'utf8');

test('every fetch() in kumo-api.ts is guarded against redirects', () => {
  // Split on each fetch call and inspect the RequestInit it is given.
  const parts = src.split(/await fetch\(/).slice(1);
  assert.ok(parts.length >= 5, `expected the 5 known v3 fetch calls, found ${parts.length}`);

  for (const part of parts) {
    // The init argument runs from after the URL to the matching close of the call.
    // Two legal shapes: an inline object literal that must carry the guard, or the
    // shared `options` identifier (the 401-retry), whose object is guarded where it
    // is built.
    const window = part.slice(0, 400);
    const inlineObject = /,\s*\{/.test(window);
    const sharedOptions = /,\s*options\s*\)/.test(window);

    if (sharedOptions) {
      continue; // options is guarded at its construction (asserted below)
    }
    assert.ok(inlineObject, 'a fetch call shape this test does not recognise — review it');
    assert.match(
      window, /redirect:\s*'error'/,
      'a v3 fetch with an inline init is missing redirect: \'error\':\n' + window.slice(0, 160),
    );
  }
});

test('the shared options object used by the 401-retry is itself guarded', () => {
  assert.match(
    src,
    /const options:\s*RequestInit\s*=\s*\{[^}]*redirect:\s*'error'/s,
    'the RequestInit shared by makeAuthenticatedRequest and its retry must set redirect',
  );
});
