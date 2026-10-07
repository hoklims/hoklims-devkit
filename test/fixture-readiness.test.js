import { expect, test } from "bun:test";
import { requireFixtureReady, qualifyInstalledFixture } from "../scripts/fixture-readiness.js";
import { prepareFixtureScope } from "../scripts/fixture-readiness.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doctor = () => ({ code: 0, version: "0.4.2", healthy: true, checks: ["cli", "workspace", "config", "index", "runtime"].map(name => ({ name, ok: true, ...(name === "index" ? { status: "healthy" } : {}) })) });
const health = () => ({ code: 0, schemaVersion: 1, kind: "index_health", binding: { status: "valid" }, freshness: { verdict: "FRESH", canRunHighRiskControl: true }, coverage: { status: "complete", candidates: 1, selected: 1, excluded: 0, analyzed: 1, unsupported: 0, failed: 0, disabled: 0 }, reasonSummary: [], candidates: [{ candidateIdentity: "typescript:index.ts", path: "index.ts", language: "typescript", selectionDecision: "selected", analysisOutcome: "analyzed", negativeEvidenceEligible: true }], capabilities: [{ language: "typescript", factKind: "module", completenessClaim: "producer-declared", negativeEvidenceEligible: true }], evaluations: { decisions: [{ candidateIdentity: "typescript:index.ts", factKind: "module", scope: { language: "typescript", selectedPaths: ["index.ts"] }, admissible: true, gates: Object.fromEntries(["discoveryAndScope", "bindingAndIntegrity", "currentFreshness", "capabilityMatch", "negativeCompleteness", "taskRelativeAuthority"].map(name => [name, "passed"])) }] } });

test("fixture qualification accepts complete fresh native reports", () => expect(() => requireFixtureReady(doctor(), health())).not.toThrow());
for (const defect of ["partial", "dirty", "broken-binding", "doctor-failed", "index-unhealthy", "missing-runtime"]) test(`fixture qualification refuses ${defect}`, () => {
  const d = doctor(), h = health();
  if (defect === "partial") h.coverage.status = "partial";
  if (defect === "dirty") h.freshness.canRunHighRiskControl = false;
  if (defect === "broken-binding") h.binding.status = "invalid";
  if (defect === "doctor-failed") d.healthy = false;
  if (defect === "index-unhealthy") d.checks.find(c => c.name === "index").status = "degraded";
  if (defect === "missing-runtime") d.checks = d.checks.filter(c => c.name !== "runtime");
  expect(() => requireFixtureReady(d, h)).toThrow("positive configuration readiness");
});
test("native interpreter failure cannot produce a ready fixture", () => {
  const calls = [];
  expect(() => qualifyInstalledFixture(argv => { calls.push(argv); if (argv.includes("index")) throw new Error("native interpreter exited 5"); return ""; }, "fixture")).toThrow("native interpreter exited 5");
  expect(calls.some(argv => argv.includes("doctor"))).toBe(false);
});
test("a database cannot be committed as generated fixture source", () => {
  expect(() => qualifyInstalledFixture(argv => argv.includes("diff") ? ".semctx/semctx.db\0" : "", "fixture")).toThrow("must not include database");
});
test("native repository preparation commits generated files before its one clean index refresh", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "prepared-native-fixture-"))), calls = [];
  try {
    const run = (argv, options) => {
      calls.push({ argv, options });
      if (argv.includes("init")) { mkdirSync(join(repo, ".semctx")); writeFileSync(join(repo, ".semctx", "config.json"), JSON.stringify({ version: 2, selectionMode: "globs-v1", include: ["src/**/*.ts"], languages: { typescript: "on", markdown: "on" } })); return ""; }
      if (argv.includes("setup")) return { code: 1, stdout: JSON.stringify({ schemaVersion: 1, kind: "setup", repositoryRoot: repo, verdict: "SETUP_NOT_READY", check: { ok: false, errors: 0 } }) };
      if (argv.includes("diff")) return ".gitignore\0";
      if (argv.includes("doctor")) return { code: 0, stdout: JSON.stringify(doctor()) };
      if (argv.includes("index-health")) return { code: 0, stdout: JSON.stringify(health()) };
      return "";
    };
    expect(prepareFixtureScope(run, repo).configuration).toBe("yes");
    const args = calls.map(item => item.argv);
    expect(args.findIndex(argv => argv.includes("setup"))).toBeLessThan(args.findIndex(argv => argv.includes("commit")));
    expect(args.findIndex(argv => argv.includes("commit"))).toBeLessThan(args.findIndex(argv => argv.includes("index")));
    expect(args.filter(argv => argv.includes("index"))).toHaveLength(1);
    expect(calls.find(item => item.argv.includes("doctor")).options).toEqual({ acceptedCodes: [0, 1], captureResult: true });
    const config = JSON.parse(readFileSync(join(repo, ".semctx", "config.json")));
    expect(config.include).toEqual(["index.ts"]); expect(config.languages.markdown).toBe("on");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
