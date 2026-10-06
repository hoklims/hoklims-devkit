import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { associateEvidence } from "./workflow-evidence.js";
import { PROOF_PINS } from "./proof-plugin.js";

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

export function readRequest(path, maxBytes = MAX_REQUEST_BYTES) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("JSON input must be a bounded regular file");
    const bytes = Buffer.alloc(maxBytes + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maxBytes) throw new Error("JSON input exceeds the size limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    closeSync(fd);
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function compatibleRegression(request) {
  return request.intent === "regression" && request.regression?.framework === "node:test"
    && [request.regression.test, ...request.regression.baseTests].every(path => /\.(?:js|mjs|cjs)$/iu.test(path));
}

export async function safeGitReader(rt, root) {
  const filterOverrides = [];
  const gitOptions = ["git", "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
  const git = (...args) => rt.exec([...gitOptions, ...filterOverrides, "-C", root, ...args], root, 120_000, args[0] === "diff");
  const readFilterNames = () => rt.exec([...gitOptions, "-C", root, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], root);
  const filters = await readFilterNames();
  if (![0, 1].includes(filters.code)) throw new Error("Cannot inspect Git conversion configuration");
  const drivers = new Set();
  for (const key of filters.stdout.split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key);
    if (!match || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error("Unsupported Git filter configuration");
    drivers.add(match[1]);
  }
  for (const driver of drivers) {
    for (const operation of ["clean", "smudge", "process"]) filterOverrides.push("-c", `filter.${driver}.${operation}=`);
    filterOverrides.push("-c", `filter.${driver}.required=false`);
  }
  return { git, readFilterNames, filters };
}

async function captureRequest(options, reader, root) {
  const { git } = reader;
  const resolveCommit = async ref => {
    const result = await git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    if (result.code !== 0 || !commitId(result.stdout.trim())) throw new Error("Cannot resolve the selected revision to a commit");
    return result.stdout.trim();
  };
  const [base, head] = await Promise.all([resolveCommit(options.base), resolveCommit("HEAD")]);
  const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", base, head);
  if (diff.code !== 0 || !(diff.stdoutBytes instanceof Uint8Array)) throw new Error("Cannot capture raw committed diff bytes");
  const request = { schemaVersion: 1, kind: "proof-routing-request", repositoryRoot: root,
    source: { provider: "semctx", version: PROOF_PINS.semctx }, scope: { base, head, diffSha256: hash(diff.stdoutBytes) },
    intent: options.intent ?? "change", proofObligationIds: options.obligation,
    ...(options.test ? { tests: options.test } : {}) };
  if (request.intent === "regression") {
    if (!options.neutral) throw new Error("A named regression needs a neutral revision and its reason");
    request.regression = { claim: options.claim, framework: options.framework ?? "node:test", before: base,
      neutral: await resolveCommit(options.neutral), neutralReason: options.neutralReason,
      test: options.regressionTest, baseTests: options.baseTest };
  } else if (["claim", "framework", "neutral", "neutralReason", "regressionTest", "baseTest"].some(key => options[key] !== undefined)) throw new Error("Regression options require --intent regression");
  return request;
}

export async function prepareWorkflow(options, rt, root, report) {
  Object.assign(report, { kind: "workflow_plan", verdict: "BLOCKED", execution: "not-run", authority: "none", checks: [], limitations: [], unprovenObligationIds: [] });
  const blocked = (code, detail, exitCode = 4) => {
    report.conflicts.push({ code, detail });
    report.exitCode = exitCode;
    return report;
  };
  let request, reader;
  try {
    if (options.request) request = readRequest(rt.resolve(options.request));
    else {
      reader = await safeGitReader(rt, root);
      request = await captureRequest(options, reader, root);
    }
  } catch {
    return blocked(options.request ? "WORKFLOW_REQUEST_UNREADABLE" : "WORKFLOW_CAPTURE_INVALID", options.request ? "Provide a readable UTF-8 JSON request file of at most 256 KiB" : "Select an existing base revision, declared obligations and complete regression inputs");
  }
  if (!validRequest(request)) return blocked("WORKFLOW_REQUEST_INVALID", "Expected proof-routing-request v1 with source identity, committed scope and declared obligations");
  try {
    if (request.repositoryRoot !== root || rt.resolve(request.repositoryRoot) !== request.repositoryRoot || rt.realpath(request.repositoryRoot) !== root) {
      return blocked("WORKFLOW_ROOT_MISMATCH", "The request must name this canonical absolute Git repository root");
    }
  } catch {
    return blocked("WORKFLOW_ROOT_MISMATCH", "The request repository root cannot be resolved");
  }
  report.unprovenObligationIds = [...request.proofObligationIds].sort();
  try { reader ??= await safeGitReader(rt, root); }
  catch { return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot safely inspect Git conversion configuration", 3); }
  const { git, readFilterNames, filters } = reader;
  const [head, indexFlags, entries, status] = await Promise.all([
    git("rev-parse", "--verify", "HEAD"), git("ls-files", "-v", "-z"), git("ls-files", "--stage", "-z"),
    git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"),
  ]);
  if (head.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot resolve the current Git HEAD", 3);
  if (head.stdout.trim() !== request.scope.head) return blocked("WORKFLOW_HEAD_MISMATCH", "The requested head differs from the current Git HEAD");
  if (indexFlags.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot inspect Git index flags", 3);
  if (indexFlags.stdout.split("\0").some(entry => entry && (entry[0] === "S" || /[a-z]/u.test(entry[0])))) {
    return blocked("WORKFLOW_HIDDEN_INDEX", "Assume-unchanged or skip-worktree entries can conceal source changes; clear the flags before capturing a request");
  }
  if (entries.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot inspect Git file modes", 3);
  if (entries.stdout.split("\0").some(entry => entry.startsWith("160000 "))) {
    return blocked("WORKFLOW_SUBMODULE_UNSUPPORTED", "The committed-source profile does not include submodules");
  }
  if (status.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot inspect the working tree", 3);
  if (status.stdout.length) return blocked("WORKFLOW_DIRTY_SOURCE", "This first profile requires a clean committed source; keep the request outside the working tree");
  const revisions = new Set([request.scope.base, request.scope.head, ...(request.regression ? [request.regression.neutral] : [])]);
  const commits = await Promise.all([...revisions].map(revision => git("rev-parse", "--verify", `${revision}^{commit}`)));
  for (const [index, revision] of [...revisions].entries()) {
    const commit = commits[index];
    if (commit.code !== 0 || commit.stdout.trim() !== revision) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Every requested revision must resolve to an exact commit in this repository", 3);
  }
  const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", request.scope.base, request.scope.head);
  if (diff.code !== 0) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "Cannot read the requested committed diff", 3);
  if (!(diff.stdoutBytes instanceof Uint8Array)) return blocked("WORKFLOW_SOURCE_UNAVAILABLE", "The Git adapter must preserve raw diff bytes", 3);
  if (hash(diff.stdoutBytes) !== request.scope.diffSha256) return blocked("WORKFLOW_DIFF_MISMATCH", "The requested diff digest differs from the observed Git diff");
  const [finalHead, finalStatus, finalIndexFlags, finalFilters] = await Promise.all([
    git("rev-parse", "--verify", "HEAD"), git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"),
    git("ls-files", "-v", "-z"), readFilterNames(),
  ]);
  if (finalHead.code !== 0 || finalStatus.code !== 0 || finalIndexFlags.code !== 0
    || finalHead.stdout !== head.stdout || finalStatus.stdout !== status.stdout || finalIndexFlags.stdout !== indexFlags.stdout
    || finalFilters.code !== filters.code || finalFilters.stdout !== filters.stdout) {
    return blocked("WORKFLOW_SOURCE_CHANGED", "Git source changed during planning; capture a new request");
  }
  Object.assign(report, { requestDigest: hash(JSON.stringify(canonical(request))), source: request.source, scope: request.scope });
  report.providerRequest = { schemaVersion: "1.0.0", consumerRequest: { reference: `sha256:${report.requestDigest}`, profileId: null, obligations: [] } };
  report.limitations.push("OBLIGATIONS_DECLARED_NOT_COMPLETE", "SOURCE_PROVIDER_UNAUTHENTICATED", "PROVIDER_READINESS_UNKNOWN", "NO_PROOF_EXECUTED");
  report.checks.push({ id: "semctx-impact", tool: "semctx verify diff", status: "readiness-required", arguments: ["verify", "diff", "--base", request.scope.base, "--head", request.scope.head, "--format", "json"] });
  report.checks.push({ id: "native-tests", status: "not-run", tests: request.tests ?? [], obligationIds: report.unprovenObligationIds });
  report.nextActions.push("Check Semctx binding, freshness and coverage before analysing this exact diff", "Run the repository's required native checks; this plan grants no exemption");
  if (!request.tests?.length) report.limitations.push("NATIVE_TEST_SELECTION_REQUIRED");
  if (request.intent === "regression") {
    const r = request.regression;
    if (r.framework !== "node:test") report.limitations.push("ASSERTLEDGER_FRAMEWORK_UNSUPPORTED");
    else if (!compatibleRegression(request)) report.limitations.push("ASSERTLEDGER_GIT_TEST_SCOPE_UNSUPPORTED");
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
  if (options.evidence) {
    await associateEvidence(options, rt, root, report, request, reader);
    const [afterHead, afterStatus, afterFlags, afterFilters] = await Promise.all([
      git("rev-parse", "--verify", "HEAD"), git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"),
      git("ls-files", "-v", "-z"), readFilterNames(),
    ]);
    if (afterHead.code !== 0 || afterStatus.code !== 0 || afterFlags.code !== 0 || afterFilters.code !== filters.code
      || afterHead.stdout !== head.stdout || afterStatus.stdout !== status.stdout || afterFlags.stdout !== indexFlags.stdout || afterFilters.stdout !== filters.stdout) {
      report.ok = false; report.verdict = "BLOCKED";
      return blocked("WORKFLOW_SOURCE_CHANGED", "Source changed during evidence association; capture a new request");
    }
  }
  return report;
}
