# G — Native reports: witness results

Candidate: head e1b301c88cf4e592d076b7ddf302db23f11e67ba, tree 1c1279f7e314dba64811a7f26184f8e5e4de2a16 (verified in WORK before starting). Bun 1.4.2, Linux.
Witness command form: `rtk proxy bun test test/app.test.js -t '<regex>'` (each `.red.log`/`.green.log` has the exact command and `EXIT=`).
Gap command: `rtk proxy bun test test/app.test.js test/runtime.test.js` (full suites) with the mutation applied.
Tooling: `witness.sh`, `apply.py`, `mutmap.py` (coverage map over 80 single-check mutations: `mutmap.log`, `mutmap2.log`), `probe/` (behaviour probe, not part of the suite).

## Witnesses

| id | guarantee / negative control | mutation (file:line, one line) | command (-t regex) | red exit + failing test | green | verdict |
|---|---|---|---|---|---|---|
| W-G01 | wrong tool identity (Compass status without schema/operation/version/project_root accepted) | app.js:599,606 identity checks skipped when `schema_version` absent; missing `project_root` accepted | `doctor rejects Compass host flags without status identity` | 1 — same test, `configured` expected "unknown", got "yes" (test:1017) | 0 | WITNESS |
| W-G02 | wrong/missing version (Semctx install report) | app.js:558 drop `parsed.version === version` | `applied Semctx host reports retain exact install identity` | 1 — same, expected APPLY_FAILED, got [] (test:440) | 0 | WITNESS |
| W-G03 | malformed version (Semctx plugin-status installed.version) | app.js:663 stable-version check -> `true` | `a malformed Semctx installed version blocks before any write` | 1 — same, expected SEMCTX_STATUS_INVALID, got APPLY_FAILED (test:372) | 0 | WITNESS |
| W-G04 | wrong repository (Semctx plugin-status / install plan repositoryRoot) | app.js:540 `optionalNativeRootMatches` always true | `naming another repository blocks all writes` | 1 — both "…host plan naming another repository…" (test:416) and "Semctx plugin status naming another repository…" (test:464): ok true | 0 | WITNESS |
| W-G05 | wrong project root (Compass install preview) | app.js:509 drop `&& project === root` | `a Compass preview for another repository blocks every write` | 1 — same, expected COMPASS_HOOK_CONFLICT, got APPLY_FAILED (test:2303) | 0 | WITNESS |
| W-G06 | wrong project root (AssertLedger artifact paths) | app.js:570 `fileBelongsToRoot` returns true | `doctor keeps invalid AssertLedger artifact evidence unknown` | 1 — same, configured "yes" instead of "unknown" (test:758) | 0 | WITNESS |
| W-G07 | wrong repository (Semctx doctor/index-health) | app.js:672 root loop always `continue` | `doctor rejects a Semctx diagnostic naming another repository` | 1 — same, ok true (test:690) | 0 | WITNESS |
| W-G08 | selected host outcome not configured (Compass apply) | app.js:1036 drop `states[host].installed/configured !== true` | `a successful native write without host configuration remains partial` | 1 — same, ok true (test:2696) | 0 | WITNESS |
| W-G09 | malformed artifact entries (AssertLedger) | app.js:585-591 whole artifact block removed from `validAssertSetupReport` | `malformed AssertLedger artifacts…\|doctor does not infer … empty artifacts` | 1 — "empty artifacts" test: configured "yes" vs "unknown" (test:786); "malformed…" test crashes with TypeError (non-assertion) | 0 | WITNESS (via empty-artifacts assertion) |
| W-G10 | Semctx workspace unknown collapsed to no | app.js:691 remove `return "unknown"` on unstructured evidence | `doctor refuses zero-exit … missing readiness fields\|doctor preserves unknown configuration …` | 1 — both, configured "no" vs "unknown" (test:650, 702) | 0 | WITNESS |
| W-G11 | Semctx workspace unknown ignored in setup preflight | app.js:803 `if (workspaceStatus === "unknown")` -> `if (false)` | `setup preserves unknown Semctx workspace evidence as a typed conflict` | 1 — same, SEMCTX_WORKSPACE_STATUS_INVALID missing (test:1102) | 0 | WITNESS |
| W-G12 | Semctx workspace no collapsed to yes (setup skipped) | app.js:807 `skipSetup = workspaceStatus !== "unknown"` | same as W-G11 | 1 — same, repairable leg: setup writes 0 vs 1 (test:1114) | 0 | WITNESS |
| W-G13 | AssertLedger invalid diagnostic evidence treated as a readiness answer | app.js:1114 `configured: configured ? "yes" : "no"` (drop `!admitted ? "unknown"`) | `doctor keeps invalid AssertLedger artifact evidence unknown\|…empty artifacts` | 1 — both, "no" vs "unknown" (test:758, 786) | 0 | WITNESS |
| W-G14 | Semctx content attestation missing (null) before replacing plugin | app.js:764 UNVERIFIED branch -> `else if (false)` | `Semctx setup never replaces installed bytes without positive content attestation` | 1 — same, SEMCTX_CONTENT_UNVERIFIED missing (test:2520) | 0 | WITNESS |
| W-G15 | content drift classification on upgrade | app.js:761 DRIFT branch skipped on upgrade | `Semctx upgrade never replaces…\|a pinned same-version upgrade…` | 1 — both, got UNVERIFIED instead of DRIFT (test:2503, 2534) | 0 | WITNESS (label only; still blocked) |
| W-G15b | content attestation bypassed on upgrade (bytes actually replaced) | app.js:761,764 both branches skipped when `command === "upgrade"` | same as W-G15 | 1 — both, got APPLY_FAILED (native install ran) (test:2503, 2534) | 0 | WITNESS |
| W-G16 | content attestation missing in doctor | app.js:1066 drop `contentMatchesSnapshot === true` | `doctor keeps Semctx installation unknown without positive content attestation` | 1 — same, installed not "unknown" (test:639) | 0 | WITNESS |
| W-G17 | native report read/parse failure swallowed | app.js:208 `nativeResult` returns `{}` instead of NATIVE_REPORT_INVALID | `native stream failures retain the validated report and saved retry` | 1 — same, got SEMCTX_STATUS_INVALID (test:233) | 0 | WITNESS |
| W-G18 | stream failure escalated instead of typed | runtime.js:596 catch -> `throw error` | same as W-G17 | 1 — same test, but fails by rejected `execute` (EIO), not an assertion | 0 | INVALID (exception, and opposite of the named defect) |

## Coverage gaps (mutation applied, full app+runtime suites green, EXIT=0; see `<id>.gap.log`, `<id>.patch`)

Alternative mutations tried per gap are in `mutmap.log`/`mutmap2.log` (all also green unless noted). `probe/probe.<id>.log` vs `probe/probe.pristine.log` shows that each mutant takes the wrong decision on a crafted native report, while pristine code rejects it. So these are test gaps, not candidate bugs.

| id | negative control | mutation (file:line) | probe effect of mutant | alternatives also green |
|---|---|---|---|---|
| GAP-G01 | tool identity: Compass install `operation` | app.js:508 drop `parsed.operation === "install"` | — | Compass install `schema_version`, status `operation`, status `schema_version` |
| GAP-G02 | tool identity: Semctx plugin-status `kind` | app.js:660 `kind` -> true | — | `schemaVersion === 2`; setup-plan `kind` (532); apply setup `kind` (951); index-health `kind` |
| GAP-G03 | tool identity: AssertLedger `client` + `connection.client` | app.js:584,594 both dropped | report for claude-code accepted for codex: ok true (pristine ASSERTLEDGER_CONFLICT) | `mode` check (584). Test "…another repository or client" only varies repository |
| GAP-G04 | wrong version: Compass install preview | app.js:508 drop `parsed.version === version` | 9.9.9 plan accepted: ok true | — |
| GAP-G05 | wrong version: Compass host status | app.js:599 drop `parsed.version !== version` | — | — |
| GAP-G06 | wrong version: Semctx doctor | app.js:683,692 `doctor.version === version` -> true | — | Compass `--version` regex loosened |
| GAP-G07 | wrong root: Semctx setup plan | app.js:532 drop `parsed.repositoryRoot === root` | plan for /other: configured/yes, 3 state writes (pristine: SEMCTX_WORKSPACE_CONFLICT, 0 writes) | — |
| GAP-G08 | wrong root: Semctx applied setup report | app.js:951 drop `repositoryRoot !== root` | configured/yes (pristine APPLY_FAILED) | — (test "post-write refusal" is over-determined by `SETUP_REFUSED`) |
| GAP-G09 | selected host outcome missing/failed: Semctx install report | app.js:561 host `detected`/`status` check -> true | `status:"failed"` accepted: configured/yes | `requested` (560), `ok === true` (558), status only. "missing its selected host" test is over-determined (its fixture also lacks `workspace`) |
| GAP-G10 | selected host outcome: Compass preview `hosts[0] === host` | app.js:511 | — | status `hosts[0].host` (601) |
| GAP-G11 | selected host failed: Compass preview with non-empty `conflicts` | app.js:525 -> true | — | — |
| GAP-G12 | failed outcome: native exit code ignored (Semctx setup preview exit 4 with valid body) | app.js:745 drop `setup.code !== 0` | configured/yes (pristine SEMCTX_WORKSPACE_CONFLICT) | Compass preview exit (928), AssertLedger preview exit (874), Semctx apply install exit (943), Compass post-install status exit (1041) |
| GAP-G13 | malformed artifact entries: per-entry `state` | app.js:591 drop `artifactStates.includes` | — | non-object guard (586), count (585), uniqueness `=== 1` (588), owner (589), Compass `file.action` (523), Compass count/uniqueness |
| GAP-G14 | Semctx workspace no collapsed to yes (index-health ignored) | app.js:699 `doctorReady ? "yes" : "no"` | doctor healthy + index partial: doctor ok true, configured "yes" (pristine "no", DOCTOR_NOT_READY) | doctor ignored; index `status === "healthy"` (694); `coverage === "complete"` |
| GAP-G15 | AssertLedger diagnostic exit/status consistency | app.js:1104 drop `exitCode === exitCodes[status]` | — | `ready: admitted` (1115) |
| GAP-G16 | content attestation after install (Semctx apply readback) | app.js:968 drop `contentMatchesSnapshot !== true` | post-install content null: configured/yes (pristine APPLY_FAILED) | post-install installed-version check (966) |
| GAP-G17 | native stream read failure swallowed in runtime | runtime.js:589 `new Response(child.stdout).text().catch(() => "")` | exec returns `{code:0, stdout:"", stderr:""}` (pristine code 5 + "Native process output read failed") | code 0 kept with message. Stays fail-closed through NATIVE_REPORT_INVALID, but the detail becomes "exit 0". No test asserts the detail |

## Findings

1. No candidate bug found in this family. All 9 probed inputs are rejected by pristine code (`probe/probe.pristine.log`). A second guard often backs the first, e.g. content DRIFT falls through to UNVERIFIED at app.js:761/764.
2. Coverage is concentrated. Root checks, AssertLedger evidence and content attestation are well witnessed (W-G01..W-G17). Identity, version, host-outcome and exit-code checks are mostly untested one field at a time (GAP-G01..G12). Several tests are over-determined: their fixtures break 2–4 checks at once, so any single check can be deleted without failing them:
   - test:395 "…missing its selected host" (fixture also lacks `workspace`)
   - test:1007 Compass identity (fixture lacks every identity field)
   - test:377/386 workspace conflict (exit 4 + kind + verdict)
   - test:481 post-write refusal (root + verdict)
   - test:1665 "another repository or client" (varies repository only)
   - test:1688 malformed artifacts (count check alone rejects `[null]`/`{}`)
3. The most consequential gaps are those where a single deleted guard lets the launcher record state and mark `configured/yes`: GAP-G07, G08, G09, G12, G14, G16 (probe shows `writes: 3`, `configured/yes`).
4. W-G09: with artifact validation removed, test:1688 crashes (`TypeError: Cannot destructure property 'owner'` at the previews map, app.js:881) instead of failing an assertion. The "empty artifacts" assertion (test:786) is what carries this witness.
5. W-G18 is INVALID by protocol. If the runtime catch is removed, `execute` rejects: app.js does not wrap `execute`, only `main` (app.js:1588) converts to UNEXPECTED_ERROR. The test catches this only as an unhandled rejection.
6. Design limits, not defects:
   - `repositoryRoot` is optional for Semctx plugin-status, install, doctor and index-health reports (app.js:540, 672). A report that omits it is accepted, so the wrong-root control holds only when the native tool emits the field.
   - `validSemctxSetupPlan` (532) and applied setup (951) compare roots with strict `===` without realpath, unlike the other checks. This fails closed on symlinked roots.
7. Platform limit: the Windows-only branches were not exercised on Linux: `latent-compass.exe` (app.js:616), backslash normalization in `validCompassInstallReport`/`fileBelongsToRoot` (505-518, 566), and `LOCALAPPDATA` state path.
8. Flake: "runtime revalidates lock ownership when descriptor reads fail" (test/runtime.test.js) failed once in about 90 full-suite runs, under an unrelated mutation (`id_assert_conn_client`). It did not reproduce in 8 pristine full runs or 5 runtime-only runs, or on rerunning that mutation.

Final: `git checkout -- .`, status clean, full `rtk proxy bun test` → 213 pass, 0 fail, EXIT=0 (`final-green.log`).
