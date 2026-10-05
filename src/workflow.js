import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_REQUEST_BYTES = 256 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function commitId(value) {
  return typeof value === "string" && SHA.test(value);
}

function object(value, required, optional = []) {
  return value && !Array.isArray(value) && typeof value === "object"
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => [...required, ...optional].includes(key));
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function relativePath(value) {
  return text(value) && !value.startsWith("/") && !/[\\:]/u.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

function list(value, predicate, required = false) {
  return Array.isArray(value) && value.length <= 100 && (!required || value.length > 0)
    && value.every(predicate) && new Set(value).size === value.length;
}

function validRequest(request) {
  if (!object(request, ["schemaVersion", "kind", "repositoryRoot", "source", "scope", "intent", "proofObligationIds"], ["tests", "regression"])
    || request.schemaVersion !== 1 || request.kind !== "proof-routing-request"
    || !text(request.repositoryRoot)
    || !["change", "regression", "migration"].includes(request.intent)
    || !object(request.source, ["provider", "version"]) || request.source.provider !== "semctx"
    || typeof request.source.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(request.source.version)
    || !object(request.scope, ["base", "head", "diffSha256"])
    || !commitId(request.scope.base) || !commitId(request.scope.head)
    || typeof request.scope.diffSha256 !== "string" || !DIGEST.test(request.scope.diffSha256)
    || !list(request.proofObligationIds, value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value), true)
    || (request.tests !== undefined && !list(request.tests, relativePath))) return false;
  if (request.intent !== "regression") return request.regression === undefined;
  const r = request.regression;
  return object(r, ["claim", "framework", "before", "neutral", "neutralReason", "test", "baseTests"])
    && text(r.claim) && text(r.framework) && text(r.neutralReason)
    && commitId(r.before) && commitId(r.neutral) && r.before === request.scope.base
    && r.neutral !== r.before && r.neutral !== request.scope.head
    && relativePath(r.test) && list(r.baseTests, relativePath, true);
}

function readRequest(path) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) throw new Error("Request must be a regular file of at most 256 KiB");
    const bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_REQUEST_BYTES) throw new Error("Request exceeds 256 KiB");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    closeSync(fd);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function prepareWorkflow(options, rt, root, report) {
  Object.assign(report, { kind: "workflow_plan", verdict: "BLOCKED", execution: "not-run", authority: "none", checks: [], limitations: [], unprovenObligationIds: [] });
  const blocked = (code, detail, exitCode = 4) => {
    report.conflicts.push({ code, detail });
    report.exitCode = exitCode;
    return report;
  };
  let request;
  try {
    request = readRequest(rt.resolve(options.request));
  } catch {
    return blocked("WORKFLOW_REQUEST_UNREADABLE", "Provide a readable UTF-8 JSON request file of at most 256 KiB");
  }
  if (!validRequest(request)) return blocked("WORKFLOW_REQUEST_INVALID", "Expected proof-routing-request v1 with source identity, committed scope and declared obligations");
  try {
    if (rt.resolve(request.repositoryRoot) !== request.repositoryRoot || rt.realpath(request.repositoryRoot) !== root) {
      return blocked("WORKFLOW_ROOT_MISMATCH", "The request must name this canonical absolute Git repository root");
    }
  } catch {
    return blocked("WORKFLOW_ROOT_MISMATCH", "The request repository root cannot be resolved");
  }
  report.unprovenObligationIds = [...request.proofObligationIds].sort();
  const git = (...args) => rt.exec(["git", "--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args], root, 120_000, args[0] === "diff");
  const head = await git("rev-parse", "--verify", "HEAD");
  if (head.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot resolve the current Git HEAD", 3);
  if (head.stdout.trim() !== request.scope.head) return blocked("WORKFLOW_HEAD_MISMATCH", "The requested head differs from the current Git HEAD");
  const status = await git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
  if (status.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot inspect the working tree", 3);
  if (status.stdout.length) return blocked("WORKFLOW_DIRTY_SOURCE", "This first profile requires a clean committed source; keep the request outside the working tree");
  const revisions = new Set([request.scope.base, request.scope.head, ...(request.regression ? [request.regression.neutral] : [])]);
  for (const revision of revisions) {
    const commit = await git("rev-parse", "--verify", `${revision}^{commit}`);
    if (commit.code !== 0 || commit.stdout.trim() !== revision) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Every requested revision must resolve to an exact commit in this repository", 3);
  }
  const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", request.scope.base, request.scope.head);
  if (diff.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot read the requested committed diff", 3);
  if (!(diff.stdoutBytes instanceof Uint8Array)) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "The Git adapter must preserve raw diff bytes", 3);
  if (hash(diff.stdoutBytes) !== request.scope.diffSha256) return blocked("WORKFLOW_DIFF_MISMATCH", "The requested diff digest differs from the observed Git diff");
  const finalHead = await git("rev-parse", "--verify", "HEAD");
  const finalStatus = await git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
  if (finalHead.code !== 0 || finalStatus.code !== 0 || finalHead.stdout !== head.stdout || finalStatus.stdout !== status.stdout) {
    return blocked("WORKFLOW_SOURCE_CHANGED", "Git source changed during planning; capture a new request");
  }
  Object.assign(report, { requestDigest: hash(JSON.stringify(canonical(request))), source: request.source, scope: request.scope });
  report.limitations.push("OBLIGATIONS_DECLARED_NOT_COMPLETE", "SOURCE_PROVIDER_UNAUTHENTICATED", "PROVIDER_READINESS_UNKNOWN", "NO_PROOF_EXECUTED");
  report.checks.push({ id: "semctx-impact", tool: "semctx verify diff", status: "readiness-required", arguments: ["verify", "diff", "--base", request.scope.base, "--head", request.scope.head, "--format", "json"] });
  report.checks.push({ id: "native-tests", status: "not-run", tests: request.tests ?? [], obligationIds: report.unprovenObligationIds });
  report.nextActions.push("Check Semctx binding, freshness and coverage before analysing this exact diff", "Run the repository's required native checks; this plan grants no exemption");
  if (!request.tests?.length) report.limitations.push("NATIVE_TEST_SELECTION_REQUIRED");
  if (request.intent === "regression") {
    const r = request.regression;
    if (r.framework !== "node:test") report.limitations.push("ASSERTLEDGER_FRAMEWORK_UNSUPPORTED");
    else if (![r.test, ...r.baseTests].every(path => /\.(?:js|mjs|cjs)$/iu.test(path))) report.limitations.push("ASSERTLEDGER_GIT_TEST_SCOPE_UNSUPPORTED");
    else {
      report.checks.push({ id: "assertledger-regression", tool: "assertledger check", status: "native-preflight-required", request: { ...r, after: request.scope.head } });
      report.nextActions.push("Use AssertLedger's native preflight to check dependencies, revisions and execution policy before qualifying this named regression");
    }
  }
  if (request.intent === "migration") {
    report.checks.push({ id: "migration-plan", tool: "semctx_control_plan_change", status: "explicit-bindings-required" });
    report.nextActions.push("Use the complete Semctx planning lane with explicit scope, invariants and any required accepted target");
  }
  report.ok = true;
  report.verdict = "PLANNED";
  return report;
}
