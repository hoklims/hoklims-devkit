import { expect, test } from "bun:test";
import { requireFixtureReady, qualifyInstalledFixture } from "../scripts/fixture-readiness.js";

const doctor = () => ({ code: 0, version: "0.4.2", healthy: true, checks: ["cli", "workspace", "config", "index", "runtime"].map(name => ({ name, ok: true, ...(name === "index" ? { status: "healthy" } : {}) })) });
const health = () => ({ code: 0, schemaVersion: 1, kind: "index_health", binding: { status: "valid" }, freshness: { verdict: "FRESH", canRunHighRiskControl: true }, coverage: { status: "complete", candidates: 1, selected: 1, excluded: 0, analyzed: 1, unsupported: 0, failed: 0, disabled: 0 }, reasonSummary: [], candidates: [{selectionDecision:"selected",analysisOutcome:"analyzed",negativeEvidenceEligible:false}], capabilities: [], evaluations:{decisions:[]} });

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
