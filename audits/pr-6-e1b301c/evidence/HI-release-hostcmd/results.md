# Witness results: families H (release verification) and I (host command quoting)

Candidate: head e1b301c8, tree 1c1279f7 (verified). Commands are prefixed `rtk proxy bun test`.
RR = test/release-report.test.js, RU = test/release-upgrade.test.js, PS = test/profile-snapshot.test.js,
QT = `test/app.test.js -t 'shell-quoted recovery paths round-trip'`, APP = test/app.test.js, ALL = full suite.

| id | guarantee / negative control | mutation (file:line, one line) | command | red exit + failing test | green exit | verdict |
|---|---|---|---|---|---|---|
| H1-order | wrong component order/name rejected | scripts/release-report.js:29 positional name check -> `expectedNames.includes(name)` | RR | 1: "rejects empty, subset, superset, wrong, reordered, and duplicate component lists" (:65) | 0 | WITNESS |
| H2-root | wrong project root rejected | release-report.js:6 drop `report.projectRoot !== projectRoot` | RR | 1: "rejects false readiness flags, wrong state, and wrong project root" (:75) | 0 | WITNESS |
| H3a-doctor-state | doctor report must carry no state | release-report.js:30 `expectedState !== null && state !== expected` | RR | 1: "rejects planned reports without five flags and doctor reports with a plan state" (:50) | 0 | WITNESS |
| H3b-state-ignored | wrong state rejected | release-report.js:30 state check deleted | RR | 1: same test (:50) + "rejects false readiness flags, wrong state..." (:74) | 0 | WITNESS |
| H4a | flag weakened: loaded/approved/observed unchecked (loaded yes accepted) | release-report.js:31 compare only `installed`,`configured` | RR (and ALL) | 0 - all 7 pass; ALL 213 pass | 0 | GAP |
| H4b | flag weakened: expected `unknown` accepts `yes` | release-report.js:31 skip mismatch when expected unknown and actual yes | RR | 0 - all 7 pass | 0 | GAP |
| H5a-sparse | sparse component array rejected | release-report.js:25-26 `for (const index in components)` (skips holes), own-index check removed | RR | 1: "rejects sparse component and expectation arrays" (:115) | 0 | WITNESS |
| H5b-throw | throwing accessor -> false, no propagation | release-report.js:34 `catch (error) { throw error; }` | RR | 1: "rejects throwing option accessors without propagating the exception" (:125) | 0 | WITNESS |
| H6a | snapshot diff ignored | scripts/profile-snapshot.js:22 `if (false && ...)` | PS RU | 1: 6 PS tests + "same-version upgrade rejects changed managed bytes" | 0 | WITNESS |
| H6b | file mode in snapshot | profile-snapshot.js:13 drop `mode` for files | PS | 1: "detects an executable permission change", "detects special permission-bit changes" | 0 | WITNESS |
| H6c | protected path uv-bin | profile-snapshot.js:31 drop `uv-bin` | PS | 1: "detects a persistent tool written outside host config folders" (:47) + 2 mode tests | 0 | WITNESS |
| H6d | protected path .claude | profile-snapshot.js:29 drop `.claude` | PS | 0 - all pass | 0 | GAP |
| H6e | protected devkit state paths | profile-snapshot.js:34-35 drop AppData/Local/hoklims-devkit and .local/state/hoklims-devkit | PS | 0 - all pass | 0 | GAP |
| H7a | no-op upgrade that modifies files rejected | scripts/release-upgrade.js:32 delete `if (sameVersions) assertSnapshotUnchanged(...)` | RU | 1: "same-version upgrade rejects changed managed bytes" (:21) | 0 | WITNESS |
| H7b | same-version judged on applied, not plan | release-upgrade.js:31 `planned[index][1]` instead of `applied[index][1]` | RU | 1: same test (:24) | 0 | WITNESS |
| H8a | applied versions differing from plan rejected | release-upgrade.js:33-35 plan-vs-applied check deleted | RU | 0 - both pass | 0 | GAP |
| H8b | component selection differing across installed/plan/applied rejected | release-upgrade.js:27-28 condition -> `if (false)` | RU | 0 - both pass | 0 | GAP |
| H9a | smoke stage 7 (post-upgrade doctor) | scripts/release-smoke.js:169-177 deleted (`node --check` OK) | ALL | 0 - 213 pass | 0 (attempt 1 hit unrelated flake, see F5) | GAP |
| H9b | smoke stage 2 (repeated setup) | release-smoke.js:139-144 deleted | ALL | 0 - 213 pass | 0 | GAP |
| H9c | smoke stage 6 (same-version no-change) | release-smoke.js:168 `assertNoopUpgradeUnchanged(...)` deleted | ALL | 0 - 213 pass | 0 | GAP |
| I1a | unquoted token | src/app.js:134 `if (true) return text;` | QT | 1: "shell-quoted recovery paths round-trip as one inert token" (exitCode 2, :3883) | 0 | WITNESS |
| I1b | space-only path left unquoted (POSIX) | app.js:134 POSIX safe regex adds space | QT (and ALL) | 0 - pass; ALL 213 pass | 0 | GAP |
| I2 | POSIX `'` escaped as `\'` inside single quotes | app.js:137 `replaceAll("'", "\\'")` | QT | 1: round-trip test (exitCode 2, :3883) | 0 | WITNESS |
| I3 | PowerShell `'` not doubled | app.js:136 `'${text}'` | APP | 0 on Linux - win32 branch not executed | 0 | GAP on Linux (Windows CI likely covers, not run here) |
| I4 | backtick left interpretable (double quotes) | app.js:137 wrap in `"..."` | QT | 1: round-trip test (exitCode 2 from unterminated backtick) | 0 | WITNESS |
| I4b | `$()` left interpretable | app.js:137 double quotes escaping only `"`, backtick, `\` | QT | 1: round-trip, stdout lost `$()` (:3884) | 0 | WITNESS |
| I5 | backslash preserved literally | app.js:137 double backslashes inside single quotes | QT | 1: round-trip, stdout `a\\b` (:3884) | 0 | WITNESS |
| I6a | recovery command call site quotes root | app.js:154 `${root}` instead of `quoteShellToken(root)` | APP | 1: "fresh registry and preflight failures include the complete admitted retry" (:200), "late authority loss replaces every earlier recovery instruction", "late authority loss retains missing-host repair..." | 0 (attempt 1 hit flake F5) | WITNESS |
| I6b | HOST_SCOPE_UPGRADE_CONFLICT retry quotes root | app.js:1342 `${root}` | APP | 0 - all pass | 0 | GAP |
| I6c | release-skew refresh command quotes root | app.js:1372 `${root}` | APP | 0 - all pass | 0 | GAP |
| I7 | leading/trailing whitespace kept | app.js:133 `String(value).trim()` | APP | 0 - all pass | 0 | GAP |
| I-emp | empirical round-trip | none (pristine) | `bun quote-roundtrip.mjs <WORK>` | 29 values x {sh(dash), bash, dash}: 87/87 byte-exact via `printf '%s\n'`, argc=5 inside a full printed command, no `$()` side effect | EXIT 0 | PASS (POSIX); pwsh NOT INSTALLED |

## Findings

- F1 (GAP, H) scripts/release-smoke.js has no test coverage at all. No test imports or reads it (grep: only the three helper modules are imported by test/). Deleting the post-upgrade doctor stage (H9a), repeated setup (H9b) or the same-version no-change check (H9c) leaves all 213 tests green. The seven-stage sequence (setup, repeated setup, doctor, upgrade dry-run, upgrade apply, same-version check, post-upgrade doctor at lines 129-177) is present on reading, but only CI (release.yml:102/174, bootstrap-verify.yml:67) runs it. I could not run the smoke here: it needs an installed consumer package, real codex/claude CLIs and network.
- F2 (GAP, H) scripts/release-report.js:31: nothing tests that loaded/approved/observed must match. The only flag negatives are `installed:"no"` and `configured:"unknown"` (test/release-report.test.js:72-73). A validator that accepts `loaded:"yes"` passes every test (H4a, H4b).
- F3 (GAP, H) scripts/release-upgrade.js:33-35: the plan-vs-applied version check is never exercised alone. The only mismatch test (test/release-upgrade.test.js:164) also rewrites the file and accepts either error regex, so the snapshot error hides the missing check. The name-selection check at :27-28 is untested too (H8a, H8b).
- F4 (GAP, H) scripts/profile-snapshot.js:28-36: only `.codex` (skill test) and `uv-bin` are pinned by tests. You can drop `.claude`, `.config`, `uv-tools`, `uv-python*` or both devkit state dirs without any test failing (H6d, H6e).
- F5 (flake, outside H/I, pristine tree) `public CLI > state checkpoints stay bound to the locked filesystem observation` failed 2 of about 8 pristine APP/ALL runs, with "Unsafe managed state path: /tmp changed during managed parent inspection". Logs: H9a-pristine-flake.green-attempt1.log, I6a-pristine-flake.green-attempt1.log. It passed 15/15 when run alone. Likely cause: src/runtime.js:63 compares `ctimeNs` of the nearest existing parent. When that parent is the shared /tmp, any concurrent sibling creation (other witnesses were running) trips it. The same false STATE_CONFLICT could happen in production if the nearest existing ancestor of the state path is a busy directory. Belongs to family F; not investigated further.
- F6 (GAP, I) quoting has one behavioural oracle, the round-trip test (test/app.test.js:3874). Its single input always contains `'`, so the "safe" fast path is never tested for spaces-only paths (I1b). Leading/trailing whitespace is not tested (I7). Two of three call sites, src/app.js:1342 (host-scope upgrade retry) and :1372 (release-skew refresh), are only tested with `/repo`, so dropping their quoting is uncaught (I6b, I6c). Other call-site tests build their expectation with `quoteShellToken` itself (test/app.test.js:198, 3178, 3254). They are self-referential about quoting correctness and only catch a missing call.
- F7 (probable BUG, Windows only, not executed) src/app.js:136, PowerShell branch. It doubles only ASCII `'`. PowerShell also treats U+2018/U+2019/U+201A/U+201B as single-quote characters. So the path `C:\Val’s repo` is emitted as `'C:\Val’s repo'`, the string ends early, and the rest becomes live tokens. The quote-roundtrip.mjs output with platform forced to win32 shows the emitted text. I could not confirm by execution because pwsh is not installed. A related limit: Windows output is PowerShell-only. In cmd.exe the single quotes are literal.
- F8 (limit, I) The win32 branch (src/app.js:134-136) is not exercised on Linux (I3 is green here). The round-trip test does run `powershell` on the windows-latest CI leg (ci.yml:17), which should catch I3 there.
- F9 (note, I) the POSIX safe regex allows a leading `-`, so `-dash` is printed unquoted. This does not matter today because the root is always an absolute resolved path.
- Empirical I check: every POSIX output round-trips byte-exactly through sh/bash/dash. The inputs cover spaces, `'`, `''`, `$()`, backticks, `$HOME`, `${PATH}`, backslashes (including a trailing one), leading/trailing whitespace, tab, newline, globs, `;&|<>`, `#`, `~`, `!`, `"`, non-ASCII, U+2019 and the empty string. The canary `$(touch /tmp/PWNED_HI)` did not run.
- Final: pristine tree restored (`git status --porcelain` empty). Full suite 213 pass, EXIT=0 (final-green.log).
