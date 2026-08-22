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

## The `@types/node` floor

`engines.node` promises `>=20.0.0`, but `devDependencies` pins `@types/node` to `^24` —
deliberately, and against the usual convention of typing to the oldest supported Node.
The reason is upstream's, in commit `9e799e4`: the definitions had drifted to `^15`
while the plugin ran on 24, so the compiler was checking against a toolchain nobody
used, and an invalid Fanv2 characteristic compiled cleanly and only surfaced as a
runtime warning on the deployed box. Typing to what actually runs catches that class of
error; typing to the floor catches the opposite one.

The cost of that choice is that the compiler will NOT reject an API added after Node 20,
which a user on Node 20 would then hit at runtime. So the floor has to be checked by
hand whenever new platform API is introduced:

```bash
git archive HEAD | tar -x -C /tmp/types20 && cd /tmp/types20
npm install && npm install --save-dev "@types/node@^20"
npm test          # builds src, compiles the tests, runs them
```

Green means nothing in the tree needs a Node newer than the floor `engines` promises.
Note `npm test`, not `tsc --noEmit`: the tests import from `dist/`, so a bare type-check
in a fresh clone fails on missing modules rather than on anything real.

**Last verified 2026-08-21 at `2.3.0-ca.13`:** clean compile, 512/512 tests against
`@types/node@20.19.43`. The platform surface is small and old — `fetch` (Node 18),
`AbortSignal.timeout` (17.3), and `crypto`/`http`/`net`/`os` — and `tsconfig.json`
targets ES2018, which holds the language side well below the floor. Re-run the check if
that inventory grows; bumping the pin past 24 has no upside while the Homebridge hosts
this targets run 24.

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

## Publishing to npm

Not published yet. When it is, the first release is the awkward one and the rest are
automatic.

**Once, by hand.** npm's Trusted Publishing (OIDC) is what `.github/workflows/publish.yml`
uses — no `NPM_TOKEN` secret anywhere — but a trusted publisher can only be configured for
a package that already exists. So the first version goes up from a logged-in machine:

```bash
npm login                      # 2FA strongly recommended on the account
npm test                       # prepublishOnly runs this too; run it first anyway
npm publish --access public --tag beta
```

`--tag beta` matters while the version carries a prerelease suffix. `2.3.0-ca.13` under
`latest` would be a version `npm install <pkg>` refuses to resolve to, and the Homebridge
UI installs `latest` — so a prerelease published as `latest` is worse than not publishing.
The workflow applies the same rule automatically: any version containing `-` goes to
`beta`, a plain `2.3.0` goes to `latest`.

**Then, on npmjs.com**, configure the trusted publisher for the package (Settings →
Access): GitHub user `thicla01`, repository `homebridge-mitsubishi-heatpump-ca`, workflow
`publish.yml`, environment blank. `package.json`'s `repository.url` must match that repo,
or OIDC will refuse.

**After that**, publishing is: bump the version, update `CHANGELOG.md`, push, and create a
GitHub Release on the `vX.Y.Z` tag. The workflow builds, runs the suite, and publishes with
provenance. Do not add `registry-url` or `NODE_AUTH_TOKEN` to `setup-node` — they make npm
expect a token and break OIDC.

**Before the first publish**, be honest about scope: this plugin has been verified hard,
but on one unit in one home. Multi-zone, US/v3 accounts and local-only mode are exercised
by tests and not by hardware here. That is an argument for `beta`, not against publishing.

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
