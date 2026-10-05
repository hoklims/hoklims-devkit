# Witness protocol (read fully before acting)

You are an independent auditor of a frozen candidate of hoklims/hoklims-devkit PR #6.
You did not write it. Treat its commit messages, PR body and comments as claims to verify, not facts.

Frozen identities: base 5d38fd4b59227cbab3949780d632cce90c2f037f, head e1b301c88cf4e592d076b7ddf302db23f11e67ba,
tree 1c1279f7e314dba64811a7f26184f8e5e4de2a16. Aggregated diff: `git diff 5d38fd4b e1b301c8`.

## Your workspace
- WORK = your own clone (given below). It is detached at the head. Verify `git rev-parse HEAD HEAD^{tree}` first.
- EVID = your evidence folder (given below). Write everything there.
- NEVER touch any other directory. NEVER commit, push, or contact GitHub. Never edit files under test/ (tests are the subject).
- Run tests with `rtk proxy bun test <file> -t '<name regex>'` (the `rtk proxy` prefix avoids output filtering). Bun 1.4.2, Linux.

## What a witness is
For each guarantee in your family:
1. Read the diff + code and locate (a) the source code enforcing it (src/, scripts/, bin/) and (b) the test(s) that claim to cover it.
2. RED: apply a minimal mutation to NON-TEST source that re-introduces exactly the named defect (e.g. remove the check, swap classification, skip revalidation). Save it: `git diff > $EVID/<id>.patch`. Run the targeted test(s). The run must exit non-zero AND the failing test must be the one about this defect, failing on an assertion about this behaviour. A syntax error, import error, collection error, timeout, or unrelated test failing is NOT a valid witness: then refine the mutation.
   Save log: `$EVID/<id>.red.log` (include the command and exit code).
3. GREEN: `git checkout -- .` (confirm `git status --porcelain` empty), rerun the SAME command, must exit 0. Save `$EVID/<id>.green.log`.
4. If a plausible defect mutation makes NO test fail (all green), that is a COVERAGE GAP — keep the patch + log as `<id>.gap.log` and report it. Gaps are valuable findings; do not hide them. Try at least one alternative mutation before concluding a gap.
5. Also report any real BUG you find in the candidate while reading (with file:line and a concrete scenario). Verify it by running code if possible; do not fix it.

Aim for 3–6 witnesses per guarantee family, covering the listed negative controls. Stop when the family's obligations are established; don't pad.
Always restore the pristine tree at the end (`git checkout -- . && git status --porcelain` empty) and finish with one full `rtk proxy bun test` green run logged to `$EVID/final-green.log`.

## Output
Write `$EVID/results.md`: a table with columns
`id | guarantee / negative control | mutation (file:line, one line) | command | red exit + failing test name | green exit | verdict (WITNESS / GAP / INVALID)`
then a "Findings" section (bugs, gaps, limits: e.g. Windows-only branch not exercised on Linux), each with file:line.
Your final message: the results table + findings, concise. No readiness/merge verdict.
