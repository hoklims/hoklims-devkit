---
name: proof-workflow
description: Prepare proportionate checks for a committed code change and associate AssertLedger evidence with its exact scope. Use for a nontrivial change or a named regression in an onboarded repository; skip prose and mechanical edits with a known cause.
---

Own the outcome and use the repository's existing gates. Semctx supplies impact and declared obligations; native tests observe behavior; AssertLedger qualifies an admitted regression. Their stores and authority remain separate.

Resolve `PLUGIN_ROOT` from this skill's installed path (the directory above `skills/`); do not assume a shell variable is already set. Use the absolute bundled CLI path in tool arguments.

1. Preserve dirty work and read repository instructions. Check the loaded Semctx provider's exact source binding, freshness and coverage before using its context. If absent or stale, use source/native tools, retain that gap and do not initialize an index implicitly.
2. Select the actual obligations and useful native checks. For a clean committed candidate, invoke the bundled CLI with `bun "${PLUGIN_ROOT}/runtime/bin/hoklims-devkit.js" workflow REPOSITORY --base BASE --obligation ID --test PATH --json`. Repeat `--obligation` or `--test` as needed. Codex supplies these arguments; the developer does not write JSON. A declared Semctx version is not an authenticated provider result.
3. Run the existing mandatory checks under their own policy. Use AssertLedger only for a named compatible regression with before, after and a justified neutral revision. Read [the regression and evidence reference](references/evidence.md) for this lane. A plan does not authorize unsandboxed execution.
4. Report observed checks, associated observations, still-unproven obligations and the next useful action. Preserve original subjects, modalities and environment limits. A replay or installation never closes a Semctx obligation or establishes universal correctness, authenticity, isolation, freshness or completeness.

For dirty candidates, keep the native workflow and state that this committed profile is unavailable. Commit only within the user's task and repository rules; never commit solely to satisfy this skill.
