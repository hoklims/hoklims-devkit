# E-recovery witnesses — hoklims-devkit PR #6 @ e1b301c8 (tree 1c1279f7)

Commands: `rtk proxy bun test test/app.test.js -t '<regex>'` from WORK (exact command at the top of each log). All paths are src/app.js unless noted. Red = mutated tree, green = pristine tree, same command.

| id | guarantee / negative control | mutation (file:line, one line) | command (-t regex) | red exit + failing test | green | verdict |
|---|---|---|---|---|---|---|
| E1 | --with kept in saved-plan recovery (NC: drop --with) | :154 remove `--with ${optional}` from stateRecoveryCommand | `state I/O recovery repeats the recorded upgrade selectors` | 1: same test (expects `--with assertledger --refresh-pending`); 19 tests fail on full file | 0 | WITNESS |
| E2 | --with kept in shared-host `--host all` advice (NC: drop --with) | :1342 remove `--with` from HOST_SCOPE retry | `shared-host upgrade advice preserves explicit component selectors` | 1: same test | 0 | WITNESS |
| E3 | --with kept in RELEASE_SKEW `--refresh-pending` suggestion | :1372 remove `--with` from refreshCommand | `refresh\|release\|skew\|pending` + full file | 0 (24/24, 159/159 pass) | n/a | GAP (low: see F2) |
| E4 | --refresh-pending kept while refresh not yet persisted (NC: drop --refresh-pending) | :154 remove `--refresh-pending` suffix | `lock contention preserves an admitted refresh request\|state I/O recovery repeats…` | 1: both tests | 0 | WITNESS |
| E5 | --refresh-pending in skew suggestion (NC) | :1372 remove ` --refresh-pending` | `an interrupted upgrade can explicitly refresh a now-unavailable stable plan` | 1: same test | 0 | WITNESS |
| E6 | --refresh-pending in shared-host retry, no pending plan | :1342 remove `--refresh-pending` suffix | full file | 0 (159/159) | n/a | GAP (flag inert without a pending plan, see F3) |
| E7 | `--host all` expansion when plan has both hosts (NC: wrong host scope) | :152 `host = plan.hosts[0]` | `refreshing a pending plan cannot silently drop its other host\|all and auto recoveries…` | 1: both tests | 0 | WITNESS |
| E8 | hosts from saved plan, not request (NC: wrong host scope) | :146 `selectedHosts = hosts` | `early Bun and Git failures recover the validated saved plan\|STATE_CHANGED recovery restores a missing host…` | 1: both tests | 0 | WITNESS |
| E9 | missing host CLI prerequisite (NC: omit missing-host prereq) | :88 drop `${host} CLI` check in retryGuidance | `shared-host upgrade advice names a missing host prerequisite…\|late authority loss retains missing-host repair…` | 1: both tests | 0 | WITNESS |
| E10 | Bun prerequisite | :87 drop Bun check | `a missing-Bun subdirectory lookup cannot prove repository state absence` | 1: same test | 0 | WITNESS |
| E11 | npm bootstrap prerequisite | :90 only report `node` | `AssertLedger recovery includes its npm bootstrap alongside the selected package manager` | 1: same test (pnpm case) | 0 | WITNESS |
| E12 | declared package manager prerequisite | :90 only report node/npm | `doctor incomplete-plan recovery retains its declared pnpm prerequisite` | 1: same test | 0 | WITNESS |
| E13 | uv prerequisite | :92 drop uv check | `implicit upgrade selection is shared by execution and recovery prerequisites` | 1: same test | 0 | WITNESS |
| E14 | undeclared PM → "inspect the declared package manager" | :96 `if (false)` | `all and auto recoveries restore missing saved-plan hosts before the full retry` | 1: same test | 0 | WITNESS |
| E15 | shared-host prereqs checked for expanded hosts | :1343 `expandedHosts = hosts` | `shared-host upgrade advice names a missing host prerequisite before its retry` | 1: same test | 0 | WITNESS |
| E17 | verb from saved plan (NC: non-admitted plan) | :144 `command = options.command` | `STATE_CHANGED recovery uses the latest locked reread plan\|a rejected refresh preflight resumes…` | 1: both tests | 0 | WITNESS |
| E18 | selectors from saved plan (NC: non-admitted plan) | :145 `selected = requestedSelected` | `recovery prerequisites follow the same admitted saved plan as the retry command` | 1: same test | 0 | WITNESS |
| E19 | bound to last persisted/locked plan, not pre-lock read | :1382 `recoveryState = () => state` | `native failure resumes a successfully persisted refreshed plan…\|STATE_CHANGED treats a locked absence as authoritative` | 1: both tests | 0 | WITNESS |
| E20 | rejected refresh → resume saved plan without --refresh-pending (NC: drop/keep refresh wrongly) | :159 drop `!candidateState?.inProgress &&` | `a rejected shared-host refresh resumes…\|a rejected refresh preflight resumes…` | 1: both tests | 0 | WITNESS |
| E21 | authority loss → state unknown | :1394 drop `lockedStateUnverified = true` | `late authority loss replaces every earlier recovery instruction\|lock release ownership conflict…` | 1: both tests | 0 | WITNESS |
| E22 | foreign locked state never authority (NC) | :1452 `validateState(...)` instead of `validateBoundState(..., root)` | `a locked foreign state never becomes recovery authority` | 1: same test (got STATE_CHANGED, expected STATE_CONFLICT) | 0 | WITNESS |
| E23 | ownership lost at lock release invalidates | :1554 drop invalidateLockedAuthority | `lock release ownership conflict makes recorded-plan recovery conditional` | 1: same test | 0 | WITNESS |
| E24 | ownership lost at transaction close invalidates | :1545 drop invalidateLockedAuthority | `late authority loss replaces every earlier recovery instruction` | 1: same test | 0 | WITNESS |
| E25 | invalid locked reread invalidates | :1533 condition `(false)` | `an invalid locked reread invalidates refresh and requires state revalidation` | 1: same test | 0 | WITNESS |
| E16 | ownership lost at a transaction **write** invalidates | :1534 drop `\|\| (stateTransaction && error?.code === "STATE_CONFLICT")` | full file + out-of-tree probe `probe/recovery-probe.test.js -t 'probe U5'` | repo suite 0 (159/159); probe 1 | n/a | GAP (see F1) |
| E26 | unverifiable early state stays unknown | :1212 `if (true)` | `an unverifiable early state makes the current retry explicitly conditional` | 1: same test | 0 | WITNESS |
| E27 | unreadable initial state stays unknown | :1274-1275 unconditional `Run …` | `an unreadable initial state remains unobserved during refresh recovery` | 1: same test | 0 | WITNESS |
| N4 | STATE_CHANGED inline action from locked plan | :1457 `recoveryActionFor(state)` | full file + probe `-t 'probe N4'` | 0; probe output byte-identical to pristine | n/a | INVALID (equivalent mutant: recordFailureRecovery retires the inline segment and re-renders from recoveryState()) |

Final: pristine tree, `rtk proxy bun test` → 213 pass / 0 fail, EXIT=0 (final-green.log). `git status --porcelain` empty, HEAD e1b301c8.

## Findings

- **F1 (GAP, real defect class)** — src/app.js:1533-1536. Loss of ownership raised by `stateTransaction.write` (runtime.js:505 `ownedFileConflict`, code STATE_CONFLICT) after the pending plan was persisted is covered only by this disjunct. Removing it keeps all 159 app tests green, yet the recovery then claims authority: probe output `…Managed state file ownership changed. Resolve the reported native conflict, then complete the recorded plan with hoklims-devkit setup /repo --host codex.` instead of the conditional "inspect and validate the saved Devkit state…". Pristine code behaves correctly (probe passes on the pristine tree). The existing "typed state path conflicts…" test (test/app.test.js:3916-3924) injects the write conflict through `writeState` (no transaction) and asserts only codes. Evidence: E16-*.patch/.gap.log, probe/recovery-probe.test.js.
- **F2 (GAP, low)** — src/app.js:1372. Dropping `--with` from the RELEASE_SKEW `--refresh-pending` suggestion fails no test (test 2619 uses `selected: ["semctx"]` only). The effect at runtime is limited because `upgrade --refresh-pending` without `--with` falls back to `pending.selected` (app.js:648-650). Still, the family requires selectors to be retained and nothing pins that here.
- **F3 (GAP, inert)** — src/app.js:1342. Dropping `--refresh-pending` from the shared-host retry fails no test. Without a pending plan the flag changes only recovery rendering (every execution use is gated on `state.inProgress`), so the two commands behave the same.
- **Limit — fallback path** — src/app.js:1534 invalidates on STATE_CONFLICT only when `stateTransaction` exists. With a runtime lacking `openStateTransaction` (used only by test fakes; `createRuntime` exports it at runtime.js:627), a `writeState` STATE_CONFLICT keeps recorded-plan authority. Production is unaffected.
- **Wording (minor)** — STATE_CHANGED guidance renders "Resolve the reported native conflict, then complete the recorded plan with …" (probe N4 output). This is not a native conflict. The command itself is correct.
- **Limit — Windows** — `quoteShellToken` win32 branch (src/app.js:133-137) is not exercised on Linux.
- No correctness bug found in recovery-command rendering. The one pending-plan/shared-host scenario that would produce a non-admitted `--host all` retry is excluded by state validation (test "every accepted pending upgrade host scope has an admitted retry").
