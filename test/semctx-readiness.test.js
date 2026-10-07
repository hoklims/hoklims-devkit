import { expect, test } from "bun:test";
import { semctxReadiness } from "../src/semctx-readiness.js";

function reports() {
  return [{ code: 1, report: { version: "0.4.2", healthy: false, checks: ["cli", "workspace", "config", "index", "runtime"].map(name => ({ name, ok: name !== "index", ...(name === "index" ? { status: "degraded" } : {}) })) } },
    { code: 2, report: { schemaVersion: 1, kind: "index_health", binding: { status: "valid" }, freshness: { verdict: "FRESH", canRunHighRiskControl: true }, coverage: { status: "partial", candidates: 1, selected: 1, excluded: 0, analyzed: 1, unsupported: 0, failed: 0, disabled: 0 }, reasonSummary: ["NEGATIVE_COMPLETENESS_MISSING"], capabilities: [], candidates: [{ selectionDecision: "selected", analysisOutcome: "analyzed", negativeEvidenceEligible: false }], evaluations: { decisions: [{ admissible: false, gates: { negativeCompleteness: "failed" } }] } } }];
}
test("positive partial installation preserves native evidence and blocks negative qualification", () => {
  const [d, h] = reports(); const result = semctxReadiness(d, h, "0.4.2", "/repo");
  expect(result.configuration).toBe("yes"); expect(result.semanticQualification.status).toBe("blocked");
  expect(result.semanticQualification.coverage).toBe(h.report.coverage);
  expect(result.semanticQualification.evaluations).toBe(h.report.evaluations);
  expect(result.semanticQualification.negativeEvidenceEligible).toBe(false);
});
for (const defect of ["dirty", "binding", "can-control", "transport", "unsupported", "failed", "unknown-reason", "foreign", "compatibility"]) test(`positive configuration refuses ${defect}`, () => {
  const [d, h] = reports();
  if (defect === "dirty") h.report.freshness.verdict = "STALE";
  if (defect === "binding") h.report.binding.status = "invalid";
  if (defect === "can-control") h.report.freshness.canRunHighRiskControl = false;
  if (defect === "transport") d.code = 5;
  if (defect === "unsupported") h.report.coverage.unsupported = 1;
  if (defect === "failed") h.report.coverage.failed = 1;
  if (defect === "unknown-reason") h.report.reasonSummary = ["PRODUCER_FAILED"];
  if (defect === "foreign") h.report.repositoryRoot = "/foreign";
  if (defect === "compatibility") d.report.cliCompatibility = { compatible: false, version: null, found: true, reason: "CLI_PROBE_FAILED" };
  expect(semctxReadiness(d, h, "0.4.2", "/repo").configuration).not.toBe("yes");
});
test("COMPLETE alone or empty native evidence never certifies negative conclusions", () => {
  const [d, h] = reports(); d.code = 0; d.report.healthy = true;
  Object.assign(d.report.checks.find(c => c.name === "index"), { ok: true, status: "healthy" });
  h.code = 0; h.report.coverage.status = "complete"; h.report.reasonSummary = [];
  expect(semctxReadiness(d, h, "0.4.2", "/repo").semanticQualification.status).not.toBe("certified");
  h.report.candidates = []; h.report.evaluations.decisions = [];
  expect(semctxReadiness(d, h, "0.4.2", "/repo").semanticQualification.status).not.toBe("certified");
});

for (const defect of ["missing-count", "duplicate-check", "missing-capacities", "missing-decisions"]) test(`essential native metadata ${defect} is not ready`, () => {
  const [d, h] = reports();
  if (defect === "missing-count") delete h.report.coverage.analyzed;
  if (defect === "duplicate-check") d.report.checks.push({ name: "index" });
  if (defect === "missing-capacities") delete h.report.capabilities;
  if (defect === "missing-decisions") delete h.report.evaluations;
  expect(semctxReadiness(d, h, "0.4.2", "/repo").configuration).not.toBe("yes");
});
test("only matching nonempty qualified native scope can be certified", () => {
  const [d, h] = reports(); d.code = 0; d.report.healthy = true;
  Object.assign(d.report.checks.find(c => c.name === "index"), { ok: true, status: "healthy" });
  h.code = 0; h.report.coverage.status = "complete"; h.report.reasonSummary = [];
  Object.assign(h.report.candidates[0], { candidateIdentity: "ts:index.ts", path: "index.ts", language: "typescript", negativeEvidenceEligible: true });
  h.report.capabilities = [{ language: "typescript", completenessClaim: "producer-declared" }];
  h.report.evaluations.decisions = [{ candidateIdentity: "ts:index.ts", scope: { language: "typescript", selectedPaths: ["index.ts"] }, admissible: true, gates: { negativeCompleteness: "passed" } }];
  expect(semctxReadiness(d, h, "0.4.2", "/repo").semanticQualification.status).toBe("certified");
  h.report.capabilities = [];
  expect(semctxReadiness(d, h, "0.4.2", "/repo").semanticQualification.status).not.toBe("certified");
});
