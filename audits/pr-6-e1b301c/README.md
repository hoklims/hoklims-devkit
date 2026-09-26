# Independent audit of PR #6 at `e1b301c` (issue #7)

**Outcome: BLOCKED. No receipt is issued, and there is no `ALLOW`.**

The N-1 `proof-integrity-review` evaluator was not available to this auditor, so no epoch, classifier or gate decision could be produced. The audit also found three confirmed defects and one probable Windows defect in the candidate (see [Defects](#defects)). This record does not claim readiness, merge eligibility or publication eligibility.

This PR adds audit evidence only. It does not touch PR #6 or its candidate bytes.

## Frozen candidate: observed identities

| Identity | Expected (issue #7) | Observed | Match |
| --- | --- | --- | --- |
| Aggregated base | `5d38fd4b59227cbab3949780d632cce90c2f037f` | same; ancestor of `main` (`31be7ba`) | yes |
| Head | `e1b301c88cf4e592d076b7ddf302db23f11e67ba` | `git rev-parse HEAD` | yes |
| Tree | `1c1279f7e314dba64811a7f26184f8e5e4de2a16` | `git rev-parse HEAD^{tree}` | yes |
| SHA-256 of `git diff --no-ext-diff --binary base head` | `d8c741ad…26acb` | `d8c741ad144c5e1288c75875abad21983de07b8d4830e7ab42605c0893b26acb` | yes |
| `git status --porcelain` after checkout and after `bun run check` | empty | empty | yes |
| N-1 Windows policy | `sha256:6d14a9ee…bae5` | **not verifiable**: evaluator not accessible | n/a |

The aggregated diff is 20 files, +7959/−294. It also includes PRs #1 to #5, which are already on `main`, because the base is older than `main`.

## Independence and session identity

- **Auditor:** Claude Code desktop, model Claude Opus 5.5, session `e90c724e-4ef0-48ad-8599-172e694fc5f1`. The session was new and not forked, run on 2026-09-26 by GitHub account `Laegel`, on Linux 6.8 x86_64.
- **No authorship:** all 114 candidate commits are authored by Guillaume Fossier. This account and harness contributed nothing to the candidate, and the session had no memory of the author's work.
- **Read-only candidate:** the candidate was cloned read-only. Every mutation ran in a separate throw-away clone, and each clone was restored and verified clean afterwards.
- **Witness sub-agents:** five fresh, non-forked sub-agents of the same harness and account produced the witness matrix. They followed [`evidence/WITNESS_PROTOCOL.md`](evidence/WITNESS_PROTOCOL.md). Each worked on its own clone, with no push access, and was told to treat commit messages and the PR body as claims to verify.
- **Order of reading:** the first pass was built from the diff, the workflows, the scripts and the test commands. The producer's PR body and summary were checked afterwards, as claims.
- **Not satisfied:** the separate account/harness constraints of hoklims/latent-compass#5. They are not attested here.

## Environment and commands

- **Toolchain:** Bun 1.4.2 (CI pins 1.4.0), Node 24.21.0 (CI pins 22.15.0), Git 2.43.0.
- **Pinned tools, matching CI:** codex-cli 0.147.0, Claude Code 2.1.229, uv 0.12.5, installed into a scratch prefix.
- **Not available:** `pwsh` and Windows, so no Windows branch was executed.

```sh
git clone https://github.com/hoklims/hoklims-devkit.git devkit-audit
git -C devkit-audit checkout --detach e1b301c88cf4e592d076b7ddf302db23f11e67ba
git diff --no-ext-diff --binary 5d38fd4b… e1b301c8… > candidate.diff   # sha256 above
bun run check                                   # 213 pass, 0 fail, 1699 expect() calls, build ok
```

The producer reported 1 614 assertions; the Windows CI job reports exactly 1 614 `expect()` calls. The difference with Linux and macOS (1 699) comes from platform-gated tests, not from a divergent candidate.

## Acceptance criteria of issue #7

| Criterion | Status | Evidence |
| --- | --- | --- |
| Fresh epoch and classifier bound to the exact base and head | **Not met.** N-1 `proof-integrity-review` evaluator not accessible (searched the whole machine and GitHub) | none |
| Independent audit of the full aggregated diff, with findings, limits and session identity | Done (this document) | below |
| Material matrix covered by relevant red-then-green witnesses | **Partly.** Every family has witnesses, but 53 plausible defect mutations stay green (gaps), and the policy/routing family depends on the evaluator | [Witness matrix](#witness-matrix) |
| Fresh independent receipt accepted by the N-1 Windows gate with `ALLOW` | **Not met.** No evaluator; unresolved defects; the release smoke fails | none |
| CI and out-of-checkout package verification bound to the same candidate | **Partly.** CI is bound to the tree. The release smoke has never run in CI and fails locally | [CI and package](#ci-and-out-of-checkout-package) |
| No readiness, merge or publication verdict inferred from missing proof | Met: none is given | this document |

## Defects

### D1 — The release smoke fails at the first `--host claude` dry-run (release blocker)

- **What happens:** `scripts/release-smoke.js` asserts that a dry-run leaves the protected profile unchanged. With the CI-pinned Claude Code 2.1.229, a `setup --host claude --dry-run` on a fresh fixture profile creates `~/.claude/.claude.json` and `~/.claude/backups/`. The chain is:
  1. The launcher calls `bunx semctx@0.3.5 plugin-status --host claude` (`src/app.js:748`).
  2. That calls the Claude CLI.
  3. `claude plugin list` writes both paths into `CLAUDE_CONFIG_DIR`. `claude --version` does not.
- **Reproduction:** this reproduces with the inherited `CLAUDE*`/`ANTHROPIC*` environment removed. It fails the same way in the subset run. The full run stops earlier, on D1b.
- **Why CI has not caught it:** `release.yml` has never run on this repository (`gh run list --workflow release.yml` is empty). The seven-stage smoke therefore has no CI proof on any OS, and `release.yml`'s `verify` job and `bootstrap-verify.yml` would fail the same way.
- **README claim affected:** "without changing … host configuration" holds only if Claude's own bookkeeping files are exempt. The candidate has to decide whether they are exempt, or avoid the write.
- **Evidence:** `evidence/probe-dryrun-profile-diff.log`, `evidence/release-smoke-subset-linux.log`, `evidence/claude-dryrun-diff.js`.

### D1b — The full-profile smoke cannot pass yet (external dependency)

`https://pypi.org/pypi/latent-compass/json` returns HTTP 404, so `--with assertledger,latent-compass` fails with `VERSION_UNAVAILABLE` (`evidence/release-smoke-linux.log`). This matches the dependency already listed in issue #7. It is not a defect of the candidate, but it means the release verification cannot be complete today.

### D2 — A cleanup I/O error replaces an already-observed `STATE_CONFLICT` (guarantee named in issue #7)

- **Location:** `src/runtime.js:542` (transaction `write`), `:650` (`writeState`) and `:684` (`acquireLock`). All three rethrow `cleanupError` unconditionally instead of using `preferredBoundaryError`.
- **Scenario:** the destination is replaced by a third party during the temp write, which is a `STATE_CONFLICT`. Unlinking the still-owned temp then fails with `EIO` or `EBUSY`. The caller receives the `EIO`, and the temp file is left behind.
- **Effect in `app.js`:** the error is classified as `STATE_IO_ERROR`, with "check disk space and permissions" guidance and exit code 5 instead of 4. `app.js:1533-1536` does not invalidate the locked recovery authority, because the code is not `STATE_CONFLICT`.
- **Mitigation, transaction path:** `close()` re-detects the conflict and invalidates authority, but the report still leads with a misleading `STATE_IO_ERROR`.
- **Mitigation, `writeState`:** none. `writeState` is only reached by runtimes without `openStateTransaction`, which today means only the test fakes.
- **Coverage:** no test covers this.
- **Reproduced independently twice:** `evidence/probe-conflict-precedence.log` (auditor) and `evidence/F-files-locks/probe-cleanup-precedence*.log` (witness F).

### D3 — Ancestor ctime check gives false `STATE_CONFLICT`s, and the suite is flaky

- **Location:** `src/runtime.js:56-67`, `:93`. During the root-down walk, `assertManagedParentSnapshot(observed, true)` compares the `ctimeNs` of the deepest ancestor observed so far. That directory is often a shared one (`/tmp`, `$HOME`, `~/.local/state`, or the shared `hoklims-devkit` state directory).
- **Effect:** any unrelated file created or removed there by another process aborts the run with "changed during managed parent inspection", and the user is told to replace linked paths. This fails closed, so nothing unsafe is written, but it is a false conflict.
- **Measured:**
  - 0 of 2 000 conflicts with a quiet `/tmp`; 14 of 2 000 while another process writes in `/tmp` (`evidence/F-files-locks/probe-tmp-churn.log`).
  - The pristine test "state checkpoints stay bound to the locked filesystem observation" (`test/app.test.js:2951`) failed 6/18 under parallel load, and in 2/8 and 2/40 ordinary full runs seen by two other witness agents.

### D4 — Probable Windows defect: PowerShell treats curly quotes as single quotes (not executed)

- **Location:** `src/app.js:136` doubles only ASCII `'`.
- **Problem:** PowerShell's tokenizer also treats U+2018, U+2019, U+201A and U+201B as single-quote delimiters. A repository path such as `C:\Val’s repo` would therefore be printed as a recovery command whose quoted string ends early, and the rest would be interpreted by the shell.
- **Status:** derived from PowerShell's documented quoting rules. It was not executed, because `pwsh` was not available. Needs one Windows run to confirm.

## Witness matrix

Each witness mutates the current Git bytes of non-test sources, fails on the named test with an assertion about the named defect, then passes on the restored tree.

- A **gap** is a plausible defect mutation that leaves the whole suite green.
- An **invalid** mutation is recorded but not counted.

Every family ended with a restored, clean tree and a full `bun test` run of 213 passing tests (`final-green.log`).

| Family (issue #7) | Witnesses | Gaps | Invalid | Details |
| --- | --- | --- | --- | --- |
| Policy and test routing | 1 (a source defect makes `bun run check` exit 1) | not assessable: trigger bypass, stale epoch, missing receipt and omitted test all need the N-1 evaluator. CI does not pin the test count, so a skipped or deleted test file stays green | 0 | [A-policy](evidence/A-policy) |
| Release graph (`release.yml`) | static review only: no executable test covers any workflow | all workflow guarantees are untested | — | [below](#release-graph-static-review) |
| Global preflight + versions and states | 21 | 17 | 0 | [C](evidence/C-preflight-versions/results.md) |
| Recovery and resume | 25 | 3 | 1 | [E](evidence/E-recovery/results.md) |
| Files, transactions and locks | 17 | 2 | 1 | [F](evidence/F-files-locks/results.md) |
| Native reports | 18 | 17 | 1 | [G](evidence/G-native-reports/results.md) |
| Release verification + host commands | 17 | 14 | 0 | [HI](evidence/HI-release-hostcmd/results.md) |

### Lock error paths named in issue #7

| Guarantee | Result | Evidence |
| --- | --- | --- |
| (a) An observed `STATE_CONFLICT` stays a conflict after a secondary I/O error | Holds for descriptor reads and lock release. **Violated** for temp and lock cleanup | Fa witnesses it for reads; D2 covers the cleanup path |
| (b) An I/O error on an unchanged lock keeps its I/O classification | Holds | Fb, Fb2, Fb3 |
| (c) Reports invalidate recovery authority when ownership is lost | Holds at lock release and transaction close | Fc, Fc2, E23, E24 |
| (c) same, at a transaction write | Not covered by any test | gap E16; D2 when the conflict is demoted |

### Material gaps

These are guards that exist in the candidate but that no test pins. For most of them, a probe shows the pristine code behaves correctly and the mutant does not.

- **`scripts/release-smoke.js` is untested.** Deleting the repeated-setup, same-version or post-upgrade doctor stage keeps all tests green (H9a–c). The smoke report validator never tests `loaded`, `approved` or `observed` (H4). The plan-versus-applied version check and the component-selection check in `release-upgrade.js` are untested (H8). Most protected profile paths are unpinned (H6d/e).
- **`--host all` with a conflict on the second host only, and a conflict only in the third of three components, are untested** (C P2b/c, P3a–e). Under those mutations, native writes and `uv tool install` run.
- **An unmanaged Semctx install is silently upgraded by `setup` if `EXISTING_VERSION` (`app.js:773`) regresses** (C V4a, probe S5). This breaks "only `upgrade` changes versions".
- **Latent Compass "installed" can imply "configured"** with no test in apply or doctor catching it (C V7a/b).
- **Native reports: 17 single guards have no test** (G GAP-G01…G17). These include:
  - native exit codes;
  - Semctx setup-plan and applied `repositoryRoot`;
  - install `status: "failed"`;
  - the AssertLedger `client`;
  - Compass version and hosts;
  - individual artifact checks;
  - index health;
  - post-install content readback.

  In six of these cases the mutant records state and reports `configured: yes` on a bad native report.
- **The recovery path has no test where ownership is lost at `stateTransaction.write`** (E16). Separately, no test races a malformed lock record into the exclusive-create window (F9b).
- **Quoting has one real round-trip test.** Paths containing only spaces, leading or trailing whitespace, and the call sites at `app.js:1342` and `:1372` are untested (I1b, I6b, I6c, I7). A direct `sh`/`bash`/`dash` round-trip of 29 hostile values was byte-exact (87/87), and `$()` never executed.

### Release graph (static review)

The auditor read `release.yml`, `ci.yml` and `bootstrap-verify.yml` in full.

**Checks confirmed:**
- A single `build` job produces one tarball. `verify` checks its SHA-256 and `publish` checks it again before `npm publish <tarball>`.
- The OIDC `publish` job has no checkout and runs no repository code.
- An existing version is compared by `dist.integrity` and is never republished.
- `public-smoke` then `release` run only after publication.
- Every action is pinned by SHA, and `persist-credentials: false` is set everywhere.

**Limits:**
- The OIDC job runs `npm install --global npm@11.5.1`, which is registry code pinned by version but not by integrity.
- No workflow is exercised by any test.
- `release.yml` has never run (see D1).

## CI and out-of-checkout package

- **CI binding:** [CI run 36259858042](https://github.com/hoklims/hoklims-devkit/actions/runs/36259858042) (`pull_request`, success on ubuntu, windows and macos) checked out merge `37bc440`. Its tree `1c1279f7…` is identical to the candidate tree, because the head already contains `main`. The run is therefore bound to the exact candidate bytes.
- **What CI checked outside the checkout:** only `--help` and `--version` (`evidence/ci-36259858042.log`).
- **Local package check (Linux):**
  - `npm pack` gave `hoklims-devkit-0.1.0.tgz`, sha256 `f3a777791e5f4a03b92e2b821e12d1e003270c647ab14f8dddceb6bfd8139823`, 13 files (`evidence/tarball-files.txt`).
  - It was installed with `--ignore-scripts` into a fresh consumer outside the checkout.
- **`scripts/release-smoke.js` run:** `codex` default dry-run passed. It then failed on D1b (`evidence/release-smoke-linux.log`).
- **Subset run** (Latent Compass removed; the driver diff is in `evidence/smoke-subset.diff`): the `codex` default and `codex --with assertledger` dry-runs passed. It then failed on D1, at the `claude` default dry-run (`evidence/release-smoke-subset-linux.log`).
- **Not run:** setup, repeat, doctor, upgrade and post-upgrade doctor stages; Windows; macOS. They were not reached, or were not available.

## Limits of this audit

- **No N-1 evaluator,** so no epoch, classifier, receipt or gate. The N-1 Windows policy digest could not be checked.
- **No Windows or PowerShell execution.** Windows-only branches were never run: the descriptor close-then-rename, the missing `O_NOFOLLOW`, `LOCALAPPDATA`, `.exe` paths and PowerShell quoting. The documented Windows boundary (hostile substitution after the last pre-syscall check) was respected and is not reported as a defect.
- **Version drift:** Bun 1.4.2 and Node 24 locally, against CI's 1.4.0 and 22.15.0.
- **Fake runtimes:** most app tests use a fake runtime. It counts state-file writes, but repository and host-profile writes appear only as native command lines.
- **Harness distinctness:** the witness sub-agents ran on the auditor's harness and account, so they are not a distinct harness.

## Evidence layout

`evidence/` contains:

- **Top level:**
  - `00-pristine-check.log`, `candidate.diff.sha256`, `ci-36259858042.log`;
  - the release-smoke logs, `smoke-subset.js` / `smoke-subset.diff`, and `tarball-files.txt`;
  - the auditor's probes (`conflict-precedence.js`, `claude-dryrun-diff.js`) and their logs;
  - `WITNESS_PROTOCOL.md`.
- **Per-family folders** `A-policy/`, `C-…/`, `E-…/`, `F-…/`, `G-…/`, `HI-…/`: `results.md`, and for each id a `<id>.patch` plus `<id>.red.log` / `.green.log` / `.gap.log`, `final-green.log`, and the probes.

Absolute paths in the logs refer to the auditor's scratch directory.
