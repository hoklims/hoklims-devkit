# Witness results: C (global preflight + versions/states)

Frozen head e1b301c88cf4e592d076b7ddf302db23f11e67ba, tree 1c1279f7e314dba64811a7f26184f8e5e4de2a16 (checked before starting and at the end). Bun 1.4.2, Linux.
Every command is `rtk proxy bun test <file> -t '<regex>'`, run from WORK by `run.sh` / `green.sh`. Each log starts with the exact command and ends with `EXIT CODE`. `<id>.patch` holds the mutation. `green.sh` runs `git checkout -- .`, checks that `git status --porcelain` is empty, then reruns the same command.
"full" means `test/ -t '.'`, the whole suite. File:line refers to pristine src.

Note on the fake runtime: `rt.writes` counts devkit state-file writes. Repository and host-profile writes show up as non-dry-run native calls: semctx `install`/`setup`, `npm install`/`pnpm add`, `assertledger setup --write`, `uv tool install`, `latent-compass host install`. The tests check both.

## Family 1: a global preflight conflict forbids every managed write

| id | guarantee / negative control | mutation (file:line, one line) | command | red exit + failing test | green exit | verdict |
|---|---|---|---|---|---|---|
| P1 | a conflict in the 2nd component blocks the 1st component's writes | app.js:1352/1361/1365 the write gate only counts conflicts recorded up to Semctx's preflight | app.test.js `optional package-manager conflict…\|conflicting AssertLedger declarations…\|a Compass preview without evidence` | 1: "optional package-manager conflict blocks Semctx application too" (L1136 non-dry-run install true), "a Compass preview without evidence…" (L2264) | 0 | WITNESS |
| P1b | the AssertLedger tool recheck runs after later component previews | app.js:1364 removes the post-loop `recordMissingAssertLedgerTools` | app.test.js `global preflight rechecks AssertLedger tools…` | 1: same test, L1586 expected NODE_REQUIRED, received [COMPASS_HOOK_CONFLICT] | 0 | WITNESS (detection only, see F3) |
| P2 | a conflict in the last component (Compass) blocks earlier writes | app.js:1361 gate snapshot taken before the latent-compass preview | app.test.js 4× `a Compass preview …\|global preflight rechecks…` | 1: all 5 fail on writes/install assertions | 0 | WITNESS |
| P2b | 3rd of 3 selected components conflicts (semctx+assertledger+compass) | app.js:1353-1365 ignores conflicts added by the component at selection index 2 | full | 0, 213 pass | n/a | **GAP** |
| P2c | same, alternative mutation | app.js:928 drops COMPASS_HOOK_CONFLICT when AssertLedger is also planned | full | 0, 213 pass | n/a | **GAP** |
| P3a | `--host all`: AssertLedger preview conflicts only on the 2nd host | app.js:874 records ASSERTLEDGER_CONFLICT only for `hosts[0]` | full | 0, 213 pass | n/a | **GAP** |
| P3b | `--host all`: Compass preview conflicts only on the 2nd host | app.js:928 records COMPASS_HOOK_CONFLICT only for `hosts[0]` | full | 0, 213 pass | n/a | **GAP** |
| P3c | `--host all`: Semctx content drift / marketplace only on the 2nd host | app.js:756 `for (host of hosts.slice(0,1))` | full | 0, 213 pass | n/a | **GAP** |
| P3d | `--host all`: Semctx install dry-run lacks the 2nd host | app.js:561 `hosts.slice(0,1).every(…detected/status)` | full | 0, 213 pass (3 reruns) | n/a | **GAP** |
| P3e | `--host all`: Semctx plugin-status lacks the 2nd host | app.js:661 `hosts.slice(0,1).every(…)` | full | 0, 213 pass (first run had 1 unrelated flake, see F5) | n/a | **GAP** |
| P3f | `--host all`: a prerequisite lost between host previews stops preflight | app.js:853,865 removes the per-host tool rechecks | app.test.js `AssertLedger multi-host preflight rechecks every required tool` | 1: L1551, the claude-code preview still ran | 0 | WITNESS (early stop; the writes stay blocked by L885) |
| P4 | a malformed packageManager / lockfile conflict blocks before any write | app.js:1365 gate ignores PACKAGE_MANAGER_CONFLICT | app.test.js `malformed packageManager declarations…\|optional package-manager conflict…` | 1: L1180 writes length 2; L1136 install true | 0 | WITNESS |
| P5 | conflicting AssertLedger declarations block every write | app.js:1329 drops PACKAGE_MANIFEST_CONFLICT after resolveComponents | app.test.js `conflicting AssertLedger declarations block every write` | 1: L2142 ok=true | 0 | WITNESS |
| P5b | a version-resolution failure in any component blocks before native preflight | app.js:1330 `if (false)` | app.test.js `optional registry failure…\|blocks published Semctx 0.3.3` | 1: L2311 a setup call happened; L176 5 calls instead of 2 | 0 | WITNESS |
| P6a | conflicting lockfiles are detected | app.js:338 `found.size > 2` | app.test.js `optional package-manager conflict blocks Semctx application too` | 1: L1135 PACKAGE_MANAGER_CONFLICT missing | 0 | WITNESS |
| P6b | every lockfile detector is inspected before checkpointing | app.js:328 drops `bun.lockb` | app.test.js `AssertLedger inspects the manifest and every lockfile detector…` | 1 | 0 | WITNESS |
| P7 | dry-run writes nothing | app.js:1365 drops `\|\| options.dryRun` | app.test.js `dry-run performs every preflight…` | 1: L331, component state not "planned" (it applied) | 0 | WITNESS |

## Family 2: versions and states

| id | guarantee / negative control | mutation (file:line, one line) | command | red exit + failing test | green exit | verdict |
|---|---|---|---|---|---|---|
| V1 | setup keeps the recorded version; only upgrade resolves | app.js:708 `false &&` on the recorded-version branch | app.test.js `setup keeps the recorded version…\|adding a host cannot silently move…` | 1: L516 expected 0.3.4, got 0.3.5; L603 | 0 | WITNESS |
| V1b | setup with a recorded version does not re-query the registry | app.js:709 `await resolveVersion()` before reusing the recorded version | full | 0, 213 pass | n/a | **GAP** (low) |
| V1c | resuming a pinned pending plan does not re-query the registry | app.js:707 same, on the pending branch | full | 0, 213 pass | n/a | **GAP** (low) |
| V2 | setup keeps an existing declared AssertLedger version | app.js:717 always `resolveVersion` | full | 0, 213 pass | n/a | **GAP** (fails closed, see F2) |
| V3 | setup keeps an existing uv-installed Compass version | app.js:721 ignores the uv inventory result | full | 0, 213 pass | n/a | **GAP** (fails closed) |
| V4a | unmanaged setup must not bump an existing Semctx plugin install | app.js:773 `false &&` on EXISTING_VERSION | full | 0, 213 pass | n/a | **GAP (high)**: the probe shows a silent bump from 0.3.4 to 0.3.5 with ok=true |
| V4b | setup must not replace an existing Compass version | app.js:907 `false &&` on EXISTING_VERSION | full | 0, 213 pass | n/a | GAP (narrow: only when a pending plan pins an unrecorded Compass version) |
| V4c | recorded Semctx version drift is rejected at preflight | app.js:776 `false &&` on INSTALLED_VERSION_DRIFT | full | 0, 213 pass | n/a | GAP (apply still fails later, after checkpoint) |
| V5 | a pending setup plan that changes a recorded version is rejected | runtime.js:432 `false &&` | test/ `a pending setup cannot change…\|state validation accepts only canonical…` | 1: app L532 got APPLY_FAILED instead of STATE_CONFLICT; runtime L1179 did not throw | 0 | WITNESS |
| V6a | configured must not imply loaded | app.js:1507 `loaded = configured` | app.test.js `every planned and applied component reports the five distinct states\|successful setup records…` | 1: L343, L478 loaded "yes" | 0 | WITNESS |
| V6b | configured must not imply approved | app.js:1506 adds `approved = configured` | app.test.js `every planned and applied … five distinct states` | 1: L343 | 0 | WITNESS |
| V6c | not-ready Semctx stays unknown (not "no") | app.js:1506 `"unknown"`→`"no"` | app.test.js `Semctx negative verdict remains unconfigured…` | 1: L507 | 0 | WITNESS |
| V7a | Compass apply: installed must not imply configured | app.js:1036+1043 drops both `configured !== true` checks | full | 0, 213 pass | n/a | **GAP**: the probe gives configured "yes" when the native report says configured=false |
| V7b | Compass doctor: installed must not imply configured | app.js:1137 drops `configured === true` | full | 0, 213 pass | n/a | **GAP**: the probe gives configured "yes" and observed "yes" when configured=false |
| V7c | AssertLedger doctor: installed must not imply configured | app.js:1111 `configured = admitted` | full | 1: "doctor rejects AssertLedger native CONFLICT…" L724 | 0 | WITNESS |
| V8a | Compass observed stays unknown without boolean evidence | app.js:1140 drops the non-boolean guard | app.test.js `doctor keeps Compass observation unknown…` | 1: L945 | 0 | WITNESS |
| V8b | Semctx installed stays unknown without attestation | app.js:1071 unknown→"no" | app.test.js `doctor keeps Semctx installation unknown…` | 1: L639 | 0 | WITNESS |
| V8c | AssertLedger configured stays unknown on invalid evidence | app.js:1114 drops the `!admitted ? "unknown"` branch | app.test.js `doctor keeps invalid AssertLedger artifact evidence unknown\|…empty artifacts` | 1: L758 expected unknown, got no | 0 | WITNESS |
| V8d | Semctx loaded stays unknown when no session is observed | app.js:1069 unknown→"no" | app.test.js `doctor keeps unobserved session and approval unknown` | 1: L624 | 0 | WITNESS |
| V8e | Semctx configured stays unknown when diagnostics are unavailable | app.js:1074 unknown→"no" | app.test.js `doctor preserves unknown configuration…` | 1: L702 | 0 | WITNESS |
| V8f | absent Compass keeps configured unknown | app.js:1122 `configured: "unknown"`→`"no"` | full | 0, 213 pass | n/a | GAP (low) |

Final: `rtk proxy bun test` on the pristine tree → 213 pass, exit 0 (`final-green.log`). `git status --porcelain` is empty.

## Findings

**F1: Gaps in family 1.** The code gate is correct: app.js:1365 blocks on any conflict, and probe.pristine.log S1–S4 all end blocked with 0 writes. No test pins these negative controls:
- `--host all` with a conflict on only the second host. This covers AssertLedger (app.js:874), Compass (app.js:928), Semctx drift/marketplace (app.js:756), the Semctx install plan (app.js:561) and Semctx status (app.js:661). Every test fixture returns identical evidence for both hosts, or runs a single host.
- All three components selected with only the 3rd (Compass) native preview conflicting.
- probe.mutated.log shows what the untested mutations do: 2–3 state writes plus `semctx install`, `semctx setup`, `assertledger --write` and `uv tool install`.

**F2: Version-keeping gaps (family 2).**
- V4a (app.js:773) is the most serious. Setup on an unmanaged repository whose Semctx plugin is already at 0.3.4, with npm stable at 0.3.5, is blocked today by EXISTING_VERSION. No test covers it, so deleting the check silently upgrades the plugin through `setup` and returns ok=true (probe S5). That breaks "only upgrade changes versions".
- V2 (app.js:717) and V3 (app.js:721) are untested because the fake registry returns the same version as the declared or installed one (assertledger 1.2.0, compass 0.3.0). Their mutations fail closed (INSTALLED_VERSION_DRIFT / EXISTING_VERSION), so the setup is refused instead of the version being bumped.
- V1b/V1c: nothing checks that setup or a resumed plan avoids the registry. With the mutation, an offline setup on a managed repo fails with RELEASE_SKEW_OR_UNAVAILABLE (probe S8).

**F3: Test 1564's no-write assertions prove nothing.** "global preflight rechecks AssertLedger tools after later component previews" (test/app.test.js:1564) has a fixture Compass preview that always conflicts. The fake runtime has no handler for the persistent `latent-compass host install --dry-run`, so the call falls into the Semctx `install` branch and returns COMPASS_HOOK_CONFLICT. Probe S11 is the same scenario without removing npm: it is blocked with no writes anyway. Only the NODE_REQUIRED / "Restore npm" assertions depend on the recheck.

**F4: Flag distinctness gaps.** For Compass, installed=true with configured=false is never tested in either apply (app.js:1036/1043) or doctor (app.js:1137):
- Test 2687 uses installed=false.
- Test 2702 fails on status recognizability first.
- Test 1020 uses a DEGRADED status.

So "installed implies configured" mutations pass the suite. Probes S9 and S10 show configured "yes" reported against a native configured=false. In the doctor case, observed also flips to "yes" (V7b).

**F5: Flaky real-filesystem tests, unrelated to mutations.** 3 failures across 40 full-suite runs on the pristine tree (flaky-pristine-40runs.log):
- "state checkpoints stay bound to the locked filesystem observation" (app.test.js:2951, failed at L3015 `raced.replaced`): 2 of 40.
- "runtime never commits a replacement temporary file after a successful callback": 1 of 40.
- Also seen once during mutation runs: "runtime preserves a state destination replaced during temporary write" and "runtime classifies a parent replaced during root-down inspection as a conflict".

Logs: flaky-*-observed.log. The gap verdicts above rest on reruns that were clean.

**Limits:**
- Windows branches were not exercised on Linux: the win32 descriptor close before rename (runtime.js:524), `quoteShellToken` win32, and the `.exe` Compass path.
- Tests use the fake runtime, which counts state writes. Real host-profile writes are only represented by native non-dry-run argv.
- Dry-run preflights still run `bunx semctx@v`, `npm exec --package=assertledger@v` and `uv tool run --from latent-compass==v`. These fill package caches but do not touch managed files. Not treated as a violation.
- No bugs found in the candidate itself for these families; every gap above is a missing test.
