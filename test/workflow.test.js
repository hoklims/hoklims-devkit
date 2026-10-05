import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execute, parseArgs } from "../src/app.js";
import { createRuntime } from "../src/runtime.js";

const cli = resolve(import.meta.dir, "../bin/hoklims-devkit.js");
let fixture, root, before, head, neutral, request;

function git(...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "devkit-workflow-")));
  root = join(fixture, "repo");
  const init = Bun.spawnSync(["git", "init", root], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  root = realpathSync(root);
  root = realpathSync(git("rev-parse", "--show-toplevel"));
  writeFileSync(join(root, "value.js"), "export const value = 1;\n");
  git("add", ".");
  git("-c", "user.name=Workflow Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "before");
  before = git("rev-parse", "HEAD");
  writeFileSync(join(root, "value.js"), "export const value = 2;\n");
  git("add", ".");
  git("-c", "user.name=Workflow Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "neutral");
  neutral = git("rev-parse", "HEAD");
  writeFileSync(join(root, "value.js"), "export const value = 3;\n");
  git("add", ".");
  git("-c", "user.name=Workflow Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "after");
  head = git("rev-parse", "HEAD");
  const diff = Bun.spawnSync(["git", "-C", root, "diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", before, head], { stdout: "pipe" });
  request = {
    schemaVersion: 1,
    kind: "proof-routing-request",
    repositoryRoot: root,
    source: { provider: "semctx", version: "0.4.1" },
    scope: { base: before, head, diffSha256: createHash("sha256").update(diff.stdout).digest("hex") },
    intent: "change",
    proofObligationIds: ["evidence.value-behaviour"],
    tests: ["tests/value.test.js"],
  };
}, 15000);

afterAll(() => {
  if (fixture && dirname(fixture) === realpathSync(tmpdir())) rmSync(fixture, { recursive: true, force: true });
});

async function plan(input = request, extra = []) {
  const requestPath = join(fixture, "request.json");
  writeFileSync(requestPath, JSON.stringify(input));
  const child = Bun.spawn([process.execPath, cli, "workflow", root, "--request", requestPath, "--json", ...extra], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stderr, report: stdout ? JSON.parse(stdout) : null };
}

test("a real CLI invocation prepares a read-only plan bound to the committed diff", async () => {
  const result = await plan();
  expect(result.report.conflicts).toEqual([]);
  expect(result.code).toBe(0);
  expect(result.report.kind).toBe("workflow_plan");
  expect(result.report.verdict).toBe("PLANNED");
  expect(result.report.execution).toBe("not-run");
  expect(result.report.authority).toBe("none");
  expect(result.report.unprovenObligationIds).toEqual(request.proofObligationIds);
  expect(result.report.checks.map(x => x.id)).toEqual(["semctx-impact", "native-tests"]);
  expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe("");
});

test("unknown request versions and omitted obligations cannot produce a plan", async () => {
  for (const invalid of [{ ...request, schemaVersion: 2 }, { ...request, proofObligationIds: [] }, { ...request, source: { provider: "semctx" } }, { ...request, scope: { ...request.scope, base: [before] } }]) {
    const result = await plan(invalid);
    expect(result.code).toBe(4);
    expect(result.report.verdict).toBe("BLOCKED");
    expect(result.report.conflicts[0].code).toBe("WORKFLOW_REQUEST_INVALID");
  }
});

test("preview invokes only bounded Git reads and the runtime version check", async () => {
  const rt = createRuntime();
  const run = rt.exec;
  const calls = [];
  rt.exec = async (...args) => { calls.push(args[0]); return run(...args); };
  rt.fetchJson = async () => { throw new Error("network is forbidden"); };
  rt.readState = rt.writeState = rt.acquireLock = () => { throw new Error("state access is forbidden"); };
  const requestPath = join(fixture, "read-only-request.json");
  writeFileSync(requestPath, JSON.stringify(regression()));
  const report = await execute(parseArgs(["workflow", root, "--request", requestPath]), rt);
  expect(report.verdict).toBe("PLANNED");
  expect(calls.every(argv => argv[0] === "git" || JSON.stringify(argv) === JSON.stringify(["bun", "--version"]))).toBe(true);
  expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe("");
});

test("a foreign repository root is rejected", async () => {
  const result = await plan({ ...request, repositoryRoot: fixture });
  expect(result.code).toBe(4);
  expect(result.report.conflicts[0].code).toBe("WORKFLOW_ROOT_MISMATCH");
});

test("a same-root junction or symlink cannot stand in for the canonical root", async () => {
  const alias = join(fixture, "alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  const result = await plan({ ...request, repositoryRoot: alias });
  expect(result.code).toBe(4);
  expect(result.report.conflicts[0].code).toBe("WORKFLOW_ROOT_MISMATCH");
});

test("a different HEAD and a tampered diff digest cannot be rebound", async () => {
  const wrongHead = await plan({ ...request, scope: { ...request.scope, head: before } });
  expect(wrongHead.code).toBe(4);
  expect(wrongHead.report.conflicts[0].code).toBe("WORKFLOW_HEAD_MISMATCH");
  const wrongDiff = await plan({ ...request, scope: { ...request.scope, diffSha256: "0".repeat(64) } });
  expect(wrongDiff.code).toBe(4);
  expect(wrongDiff.report.conflicts[0].code).toBe("WORKFLOW_DIFF_MISMATCH");
});

test("uncommitted code invalidates the committed profile and restoration recovers it", async () => {
  writeFileSync(join(root, "value.js"), "export const value = 99;\n");
  try {
    const result = await plan();
    expect(result.code).toBe(4);
    expect(result.report.conflicts[0].code).toBe("WORKFLOW_DIRTY_SOURCE");
  } finally {
    writeFileSync(join(root, "value.js"), "export const value = 3;\n");
  }
  expect((await plan()).code).toBe(0);
});

test("hidden index flags cannot conceal uncommitted code", async () => {
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git("update-index", `--${flag}`, "value.js");
    writeFileSync(join(root, "value.js"), "export const value = 99;\n");
    try {
      expect(git("status", "--porcelain=v1")).toBe("");
      const result = await plan();
      expect(result.code).toBe(4);
      expect(result.report.conflicts[0].code).toBe("WORKFLOW_HIDDEN_INDEX");
    } finally {
      writeFileSync(join(root, "value.js"), "export const value = 3;\n");
      git("update-index", `--no-${flag}`, "value.js");
    }
  }
  expect((await plan()).code).toBe(0);
}, 15000);

function regression(framework = "node:test") {
  return { ...request, intent: "regression", regression: {
    claim: "value must equal three", framework, before, neutral,
    neutralReason: "The neutral revision exercises the unrelated value two case",
    test: "tests/regression.test.js", baseTests: ["tests/base.test.js"],
  } };
}

test("a named node:test regression proposes native preflight without executing it", async () => {
  const result = await plan(regression());
  expect(result.code).toBe(0);
  expect(result.report.checks.map(x => x.id)).toEqual(["semctx-impact", "native-tests", "assertledger-regression"]);
  expect(result.report.checks[2].status).toBe("native-preflight-required");
  expect(result.report.execution).toBe("not-run");
  expect(result.report.unprovenObligationIds).toEqual(request.proofObligationIds);
});

test("an unsupported framework retains native tests and exposes the limitation", async () => {
  const result = await plan(regression("vitest"));
  expect(result.code).toBe(0);
  expect(result.report.checks.map(x => x.id)).toEqual(["semctx-impact", "native-tests"]);
  expect(result.report.limitations).toContain("ASSERTLEDGER_FRAMEWORK_UNSUPPORTED");
});

test("unsafe test paths and an invented neutral revision are rejected", async () => {
  const escaping = regression();
  escaping.regression.test = "../outside.js";
  expect((await plan(escaping)).report.conflicts[0].code).toBe("WORKFLOW_REQUEST_INVALID");
  const missing = regression();
  missing.regression.neutral = "f".repeat(40);
  expect((await plan(missing)).report.conflicts[0].code).toBe("WORKFLOW_SOURCE_UNAVAILABLE");
});

test("request key ordering does not alter the digest or plan", async () => {
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  expect((await plan(reordered)).report).toEqual((await plan()).report);
});

test("migration advice retains a separate plan and all unresolved obligations", async () => {
  const result = await plan({ ...request, intent: "migration" });
  expect(result.code).toBe(0);
  expect(result.report.checks.map(x => x.id)).toEqual(["semctx-impact", "native-tests", "migration-plan"]);
  expect(result.report.unprovenObligationIds).toEqual(request.proofObligationIds);
});
