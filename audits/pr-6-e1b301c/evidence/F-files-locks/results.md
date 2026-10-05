# Family F: files and transactions on managed state. Witness results

Frozen head e1b301c88cf4e592d076b7ddf302db23f11e67ba, tree 1c1279f7e314dba64811a7f26184f8e5e4de2a16 (verified in the workspace).
Runner: `run-witness.sh`. It saves `<id>.patch`, then writes `<id>.red.log` with the mutation applied and `<id>.green.log` after `git checkout -- .` on a clean tree, using the same command both times.
RT = `test/runtime.test.js`, APP = `test/app.test.js`. Every command is `rtk proxy bun test <file> -t '<regex>'`.

| id | guarantee / negative control | mutation (file:line, one line) | command | red exit + failing test name | green exit | verdict |
|---|---|---|---|---|---|---|
| F1 | Symlinked state file (and lock file) is rejected as STATE_CONFLICT | runtime.js:107-108: drop the `isSymbolicLink` rejection and exempt symlinks from `!isFile` | RT `-t 'dangling state symlink'` | 1: "rejects a dangling state symlink while reading" and "preserves a dangling state symlink and its target while writing" (received ELOOP, expected /Unsafe managed state path/) | 0 | WITNESS |
| F2a | Symlinked ancestor, single guard | runtime.js:90-91: drop only the root-down `isSymbolicLink` rejection | RT `-t 'linked state directory\|dangling state-directory links…'` | 0: the snapshot recheck at runtime.js:61 still rejects, so the defect is not reintroduced (redundant guard) | 0 | INVALID (redundant) |
| F2 | Symlinked ancestor, state directory, or profile root | runtime.js:90-91 plus :61: accept symlinks in both the walk and the snapshot | same | 1: "refuses a linked state directory before every managed-state operation" and "refuses dangling state-directory links and linked profile roots" (did not throw) | 0 | WITNESS |
| F3 | Inode swap between the read and the return (post-read pathname revalidation) | runtime.js:216: remove the final `assertReadIdentity()` | RT `-t 'revalidates every pathname after descriptor reads'` | 1: that test (code undefined, expected STATE_CONFLICT) | 0 | WITNESS |
| F4 | Inode swap or removal between inspection and open is a conflict, not I/O | runtime.js:193-198: open failure rethrown without identity revalidation | RT `-t 'binds state and lock reads…\|removal after inspection…'` | 1: "binds state and lock reads to the inspected regular file" (ELOOP) and "classifies removal after inspection as ownership drift" (ENOENT) | 0 | WITNESS |
| F5 | Inode swap of the owned temp or lock before commit | runtime.js:338-339: drop the dev/ino comparison in `assertOwnedFile` | RT `-t 'replacement temporary file\|replacement lock…\|staged ownership'` | 1: 4 tests, including "never commits a replacement temporary file after a successful callback", "preserves a replacement lock after its writer returns" and "revalidates staged ownership after the final destination read" | 0 | WITNESS |
| F6 | Partial write: owned temp and lock are removed (writeState, acquireLock) | runtime.js:648 and :682: `cleanupOwnedFile` replaced by `closeOwnedFile` | RT `-t 'removes an owned partial'` | 1: "removes an owned partial temporary state file after a write failure" and "removes an owned partial lock after its write fails" | 0 | WITNESS |
| F6b | Partial write: owned temp removed in `openStateTransaction().write` | runtime.js:540: `cleanupOwnedFile` replaced by `closeOwnedFile` | RT `-t runtime`, plus the full suite | 1, but only "revalidates Windows destination bytes after publication fails" fails, and only because its foreign-mutation hook lives inside `removeOwnedFile`. No test asserts that the transaction temp is removed. | 0 | GAP (incidental failure only) |
| F7 | Third-party replacement bytes preserved on cleanup (identity checked before unlink) | runtime.js:359: remove `assertOwnedFile` before `removeOwnedFile` | RT `-t 'preserves a replacement temporary file…\|replacement lock…'` | 1: "preserves a replacement temporary file when the writer fails" and "preserves a replacement lock after its writer returns" (foreign lock deleted, ENOENT on the preservation read) | 0 | WITNESS |
| F8 | Owned lock removal failure propagates | runtime.js:703: `cleanupOwnedFile` wrapped in `try{}catch{}` | RT `-t 'propagates an owned lock unlink failure'` | 1: that test (did not throw) | 0 | WITNESS |
| F9 | Only exact UUIDv4 lock records count as contention; a foreign record is STATE_CONFLICT | runtime.js:384: remove the UUID regex | RT `-t 'distinguishes malformed lock records from contention'` | 1: that test (RUN_LOCKED, expected STATE_CONFLICT) | 0 | WITNESS |
| F9b | Same rule for a lock that appears in the EEXIST race | runtime.js:690: remove `readLockRecord` in the raced branch | RT and APP full files | 0 (197 pass). `F9b-probe.log` shows a foreign `{token:"foreign"}` record: STATE_CONFLICT on the pristine tree, RUN_LOCKED under the mutation | 0 | GAP |
| Fa | (a) An observed STATE_CONFLICT keeps precedence over a secondary I/O error | runtime.js:38-41: `preferredBoundaryError` returns `secondary ?? primary` | RT `-t runtime` | 1: "revalidates lock ownership when descriptor reads fail" at test:673 (secondary-fstat EIO case: EIO, expected STATE_CONFLICT) | 0 | WITNESS |
| Fb | (b) I/O error on an UNCHANGED lock stays I/O (release) | runtime.js:705: release converts every non-conflict error to `ownedFileConflict` | RT `-t 'lock ownership when descriptor reads fail\|propagates an owned lock unlink failure'` | 1: both tests (EIO/EACCES identity lost to a conflict) | 0 | WITNESS |
| Fb2 | (b) I/O stays I/O after a successful revalidation at every boundary | runtime.js:49: `rethrowAfterValidation` throws STATE_CONFLICT instead of the original error | RT `-t '…descriptor reads fail\|removal after inspection\|parent creation\|exclusive owned-file open failure\|root-down inspection'` | 1: all 5 fail on their EACCES/EIO identity assertions | 0 | WITNESS |
| Fb3 | (b, report) Release I/O does not invalidate recovery authority | app.js:1554: `invalidateLockedAuthority()` called unconditionally | APP `-t 'release I/O'` | 1: "ordinary failure finalization replaces stale recovery after release I/O" and "Semctx incomplete recovery is retired when release I/O adds prerequisites" | 0 | WITNESS |
| Fc | (c) Report invalidates resume and recovery authority when lock ownership is lost at release | app.js:1554: remove `if (STATE_CONFLICT) invalidateLockedAuthority()` | APP `-t 'lock release ownership conflict\|typed state path conflicts…\|STATE_CHANGED release failures'` | 1: "lock release ownership conflict makes recorded-plan recovery conditional" and "typed state path conflicts stay STATE_CONFLICT at every locked boundary" (still says "complete the recorded plan") | 0 | WITNESS |
| Fc2 | (c) Same at transaction close | app.js:1545: remove the close-catch invalidation | APP `-t 'late authority loss'` | 1: "late authority loss replaces every earlier recovery instruction" and "…retains missing-host repair…" | 0 | WITNESS |
| Fw1 | Windows: after a failed publish (descriptor already closed), the destination bytes and identity are rechecked | runtime.js:477: `closed-existing` branch returns early | RT `-t 'Windows destination bytes'` | 1: "revalidates Windows destination bytes after publication fails" (close did not throw) | 0 | WITNESS (simulated win32 via `currentPlatform`) |
| Fw2 | A substitution detectable before publish is caught (final destination checkpoint) | runtime.js:516: remove `assertExpectedDestination()` before the staged read | RT `-t 'final checkpoint read\|staged ownership…'` | 1: "rejects state growth and metadata races during the final checkpoint read" (commit happened) | 0 | WITNESS |

Final: pristine tree (`git status --porcelain` empty). `rtk proxy bun test` gives 213 pass / 0 fail, exit 0 (`final-green.log`).

## Findings

1. **BUG: conflict precedence is lost when cleanup of the owned temp fails (guarantee a).**
   - Where: `src/runtime.js:538-543` (`openStateTransaction().write`), `:646-651` (`writeState`), `:680-685` (`acquireLock`). The catch runs `cleanupOwnedFile(...)`, and `catch (cleanupError) { throw cleanupError; }` replaces the primary error unconditionally, instead of going through `preferredBoundaryError`.
   - Scenario (`probe-cleanup-precedence.mjs`, `.log`):
     1. The destination is replaced by a foreign file during the temp write, so the primary error is STATE_CONFLICT.
     2. Unlinking the still-owned temp then fails (EBUSY; plausible on Windows with AV or indexers).
     3. `writeState` and `transaction.write` throw EBUSY instead of STATE_CONFLICT, and the temp is left behind.
   - Impact at the app layer: `saveStateIfChanged` rethrows `code: EBUSY`, which `stateBoundaryProblem` classifies as STATE_IO_ERROR. `app.js:1533-1534` then skips `invalidateLockedAuthority()`.
   - Mitigation today: in the transaction path, `close()` re-detects the replacement (`closeCode: STATE_CONFLICT` on both the seeded and the absent destination) and invalidates later. The report still carries a misleading extra STATE_IO_ERROR ("Check disk space and permissions").
   - `writeState` (used when `openStateTransaction` is absent) has no such backstop. No test covers this seam.

2. **BUG (fail-closed false positive, and the cause of a flaky test): parent-metadata comparison on intermediate ancestors.**
   - Where: `src/runtime.js:56-67` and `:93`. During the root-down walk, `assertManagedParentSnapshot(observed, true)` compares `ctimeNs` of the deepest ancestor observed *so far*. That is an unrelated shared directory (`/tmp`, `$HOME`, `~/.local`, `~/.local/state`).
   - Any unrelated file creation in that directory between two `lstat` calls produces STATE_CONFLICT "changed during managed parent inspection". The user is then told to "Replace linked state paths".
   - Proof:
     - `probe-ancestor-ctime.log` (deterministic hook): creating a sibling `.bash_history` in a grand-ancestor gives STATE_CONFLICT, and nothing is written.
     - `probe-tmp-churn.log` (no hooks): 0/2000 conflicts when quiet, 14/2000 with real `/tmp` churn.
   - Test impact: APP "state checkpoints stay bound to the locked filesystem observation" is flaky on the pristine tree, failing 6/18 when run 6-way in parallel (`flake-stress.log`, `stress/`). It fails at test lines 2965, 3008, 3015 and 3032, all consistent with a spurious early conflict. It also failed once in my F9b full run (`F9b-first-run-flake.log`). That failure was unrelated to the mutation, as reruns showed.
   - The doc's quiescent-profile contract covers the profile, not `$HOME` or `/tmp`.

3. **GAP F9b:** no test puts a malformed or foreign lock record into the EEXIST race branch (`runtime.js:687-692`). Existing tests race only a directory and a symlink, which `inspectManagedFile` rejects before `readLockRecord`. Dropping the record validation there turns a foreign lock into RUN_LOCKED (contention) instead of STATE_CONFLICT, and every test stays green.

4. **GAP F6b:** transaction-path cleanup of a partially written owned temp (`runtime.js:538-541`) has no direct assertion. `writeState` and lock have one (F6).

5. **Scope note on "stale-lock removal failure must propagate":** the runtime never removes a stale lock itself. A valid foreign lock gives RUN_LOCKED and manual-removal guidance (`runtime.js:667-670`). The only removal is release of the owned lock, whose failure propagation is witnessed (F8, plus the app STATE_IO_ERROR path in Fb3).

6. **Redundancy (F2a):** the ancestor symlink rejection has two independent layers: the walk check at `:90` and the snapshot at `:61`. A single-site removal is not a defect.

7. **Limits and Windows-only branches not exercisable on Linux:**
   - `openVerifiedReadDescriptor` on win32 (`runtime.js:136-139`) opens without `O_NOFOLLOW`/`O_NONBLOCK`. On Linux, F1 shows `O_NOFOLLOW` as a backstop that turns a missed symlink into ELOOP (misclassified, but not followed). On Windows the lstat checks are the only guard, and that cannot be run here.
   - The win32 publish sequence (`runtime.js:524-528`: close the held destination, then `renameSync`) was exercised only through `currentPlatform: () => "win32"` on POSIX semantics. Real Windows rename-over-open-file and EBUSY/EPERM behaviour is not exercised.
   - Also Windows-only: the `statePath` LOCALAPPDATA branch (`:615-616`) and the junction-type symlink fixtures.
   - Several RT tests `return` early on win32 (FIFO, replacement temp and lock, EEXIST symlink race, lock read error), so Windows CI does not run those witnesses.
   - Documented limit (not a bug): on both platforms, the final destination check (`:516`) precedes the staged-temp read (`:517`) and then close and rename. A swap after that point is inside the documented out-of-scope window.
