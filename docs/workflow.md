# Read-only proof routing

`hoklims-devkit workflow <repository> --request <file> --json` prepares the next
checks for an explicitly bound change. It never executes candidate tests, invokes
providers, changes installation state, accepts evidence, or authorizes an action.
`--dry-run` is optional because this command is always read-only.

This is the adapter boundary for the forthcoming common Codex workflow. The agent
or integration prepares the request; this first tranche does not yet generate it
from a native Semctx handoff. It does not ask developers to author a campaign,
implement an AssertLedger adapter, or replace their repository's checks.

During development, run the checkout CLI with Bun:

```sh
bun bin/hoklims-devkit.js workflow /absolute/repository --request /outside/repository/request.json --json
```

Keep the request outside the worktree. The first profile accepts only clean,
committed sources. Dirty work is reported without discarding or committing it.
The common plugin, native evidence binding, package publication and observed
fresh-session use are separate delivery steps.

## Request v1

The strict JSON object contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` / `kind` | `1` / `proof-routing-request`; unknown fields and versions are rejected |
| `repositoryRoot` | Canonical absolute Git root matching the selected repository |
| `source` | `{ "provider": "semctx", "version": "0.4.1" }`; declared producer identity, not authenticated runtime evidence |
| `scope` | Exact `base`, current `head`, and lowercase SHA-256 `diffSha256` |
| `intent` | `change`, `regression`, or `migration` |
| `proofObligationIds` | One to 100 unique declared obligation identifiers; completeness is not established |
| `tests` | Optional unique repository-relative POSIX test paths |
| `regression` | Required only for `regression`; named claim, framework, before/neutral revisions, neutral rationale, candidate test and base tests |

Calculate `scope.diffSha256` over the **raw bytes**, including the final newline,
of `git diff --no-ext-diff --no-textconv --binary --full-index BASE HEAD`.
Every revision must resolve to that exact commit. Planning rechecks HEAD and
worktree/index state before returning; drift refuses the plan. Assume-unchanged
and skip-worktree entries are refused because they can hide source changes.
Git reads disable
replacement objects, filesystem-monitor hooks and optional index writes.

For a regression, `before` must equal `scope.base`; the fixed revision is
`scope.head`. `neutral` must be a distinct existing commit, with an explicit
`neutralReason`. `test` is a relative path and `baseTests` is a nonempty unique
list of relative paths. Their purpose and the neutrality claim remain declared.

The file must be regular UTF-8 JSON of at most 256 KiB. Absolute, escaping,
backslash and colon-bearing test paths are refused. Requests do not contain
shell commands, execution grants, provider results or verdicts.

## Result and scope

`PLANNED` means only that a routing request matches the inspected committed
source. The report carries its canonical request digest, original source/scope,
checks, limitations, next actions and **all** declared obligations as unproven.
Object-key ordering does not change the request digest.

- Ordinary changes retain Semctx readiness/impact checks and required native tests.
- Named `node:test` regressions using `.js`, `.mjs` or `.cjs` tests additionally
  propose AssertLedger's **native preflight**. Dependency support, path-set rules,
  actual producer version and execution policy still require native validation.
- Other regression frameworks retain native checks and an explicit limitation.
- Migrations additionally require the full Semctx planning lane with explicit
  bindings and any required accepted target.

No control is waived. `execution` is always `not-run`, `authority` is `none`,
provider readiness/authenticity is unknown, and no obligation becomes verified.
No AssertLedger unsafe-execution flag is added or accepted by this command.
Native replay and evidence admission are outside this tranche.

Exit `0` is a prepared plan, `4` is invalid/inapplicable context, `3` is an
unavailable source/prerequisite, `64` is invalid CLI usage, and `5` is an
unexpected operational failure. None is an observed regression-test result.
