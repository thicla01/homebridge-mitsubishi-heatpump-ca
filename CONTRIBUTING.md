# Contributing

This is `homebridge-mitsubishi-heatpump-ca`, a fork of
[ukaratay/homebridge-mitsubishi-heatpump](https://github.com/ukaratay/homebridge-mitsubishi-heatpump)
carrying Canadian-account (v2 cloud + LAN-only) support. Orientation lives in
`CLAUDE.md`; the vendor protocol in `docs/protocol.md`; every config option in
`docs/configuration.md`. **Security vulnerabilities:** see [SECURITY.md](SECURITY.md) —
do not open a public issue for those.

## Build and test

```bash
npm install
npm run build   # src/ → dist/
npm test        # builds src/ AND test/, then node --test dist-test/*.test.js
```

**The two-tsconfig trap, bluntly:** `tsc --noEmit` type-checks `src/` only. The root
`tsconfig.json` includes `src/**/*` and nothing else; the all-TypeScript test suite
compiles only through `npm test`, whose `pretest` runs `tsc -p tsconfig.test.json`
(`test/` → `dist-test/`). So "tsc passes" does **not** mean the tests build — a type
error in `test/` is invisible until `npm test`. The split is deliberate (test code must
never reach a published tarball, and compiled tests must sit next to `dist/` so their
`require('../dist/...')` resolves — see the comment in `tsconfig.test.json`), so do not
"fix" it; just never trust a bare `tsc` as proof the repo compiles.

Tests run against `dist/`, not `src/` — running `node --test` by hand after editing
`src/` tests the previous build. Always go through `npm test`.

## Regression discipline

Every behavioural fix in this repo ships with a test that was **verified RED by
re-applying the exact mutation the fix removes** (see the per-release records in
`CHANGELOG.md`). A test that has only ever been seen green proves nothing — several of
this repo's bugs were found precisely because mutation testing showed the suite blind to
them. So: write the test, re-introduce the bug, watch the test fail, restore the fix,
watch it pass. Keep only tests that completed that loop.

One trap in the loop: **a mutation that does not compile produces misleading silence.**
If the re-applied bug breaks the build, `pretest` fails and `node --test` never runs —
grepping the output for your test's name finds no failure, which reads exactly like "my
test passed". Read the full `npm test` tail every time — either the node:test summary
(`pass N` / `fail N`) or a compiler error — never a grep.

## Cutting a release

The fork versions as `2.3.0-ca.N` and is **not published to npm** — install is from
source or an `npm pack` tarball. Do not publish a GitHub Release expecting
`.github/workflows/publish.yml` to do the right thing: it is inherited from upstream,
triggers on release publish, and its already-published guard still queries the
pre-rename name (`npm view "homebridge-mitsubishi-heatpump@$VERSION"`), so it would
attempt an unintended npm publish of the `-ca` package.

1. `npm version 2.3.0-ca.N --no-git-tag-version`, update `CHANGELOG.md`, commit.
2. `npm pack` → `homebridge-mitsubishi-heatpump-ca-2.3.0-ca.N.tgz`.
3. Copy the tarball to the Homebridge host and install it from the Homebridge storage
   directory. On the official Raspberry Pi image the bundled Node is **not on `PATH`**,
   so name it explicitly:

   ```bash
   sudo env PATH=/opt/homebridge/bin:/usr/bin:/bin /opt/homebridge/bin/npm install ./homebridge-mitsubishi-heatpump-ca-2.3.0-ca.N.tgz
   ```

4. Restart the right thing: plugin **code** changes need only a child-bridge restart;
   plugin **config** changes need a **full Homebridge restart**, because a child bridge
   receives its configuration from the parent process.

One-time note: a host that still has the pre-rename package must
`npm uninstall homebridge-mitsubishi-heatpump` first — both packages register the
`KumoV3` platform, and Homebridge cannot tell which one a `KumoV3` config block means.

## Merging upstream

The fork tracks ukaratay's repo from v2.2.1. Before a merge, know where the fork's
weight sits — `git diff --stat v2.2.1..HEAD` (run it fresh; as of `ca.13` it reports
35 files, 8740 insertions, 179 deletions), with the changed lines concentrated in:

| File | Changed lines | What lives there |
|---|---|---|
| `src/platform.ts` | 1021 | v2 bootstrap, `reconcileImpliedConfig`, ca kill switch, local-only mode |
| `src/kumo-v2.ts` | 578 (new) | the entire v2 cloud client — no upstream counterpart |
| `src/accessory.ts` | 355 | scene-race guards, setpoint hold windows, redundant-command skips |
| `src/kumo-api.ts` | 264 | `cloudDisabled` guards, redaction, redirect guards |
| `src/local-api.ts` | 202 | auth-retry/streak policy, `isLocalHost`, 64KB reply cap, sensor/MHK2 reads |

Everything upstream touches in those files is suspect in a merge. `CLAUDE.md`'s
hard-won invariants section is the list of things a merge must not break — several are
timing- or ordering-sensitive and pinned by tests that a plausible-looking merge
resolution can silently defeat, so after any merge, run the full suite and read the
tail (see the discipline above).

## Everything else

Match the neighbours: node:test with no framework, HAP enums read off
`@homebridge/hap-nodejs` at runtime (never hand-rolled — `CLAUDE.md` records why),
design rationale in a comment next to the code it justifies, and vendor-API facts
stated once, in `docs/protocol.md`.
