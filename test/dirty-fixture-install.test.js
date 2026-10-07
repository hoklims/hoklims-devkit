import { expect, test } from "bun:test";
import { isAttributableDirtyFixtureInstall } from "../scripts/fixture-readiness.js";

function report() { return { ok: false, exitCode: 3, conflicts: [{ code: "SEMCTX_NOT_READY" }], components: [
  { name: "semctx", installed: "yes", configured: "no", state: "needs-attention", semanticQualification: { binding: { status: "valid" }, freshness: { verdict: "DIRTY_KNOWN", canRunHighRiskControl: true }, coverage: { unsupported: 0, failed: 0, disabled: 0 } }, checks: [{ command: "doctor", exitCode: 1 }, { command: "index-health", exitCode: 2 }] },
  { name: "assertledger", installed: "yes", configured: "yes", state: "configured" } ] }; }
test("only attributable aggregate DIRTY permits owned fixture stabilization", () => expect(isAttributableDirtyFixtureInstall(report(), 3, ["semctx", "assertledger"])).toBe(true));
for (const defect of ["binding", "unknown", "transport", "other-component", "other-error", "unsupported"]) test(`fixture refuses ${defect}`, () => {
  const r = report();
  if (defect === "binding") r.components[0].semanticQualification.binding.status = "invalid";
  if (defect === "unknown") r.components[0].semanticQualification.freshness.verdict = "UNKNOWN";
  if (defect === "transport") r.components[0].checks[0].exitCode = 5;
  if (defect === "other-component") r.components[1].configured = "unknown";
  if (defect === "other-error") r.conflicts[0].code = "APPLY_FAILED";
  if (defect === "unsupported") r.components[0].semanticQualification.coverage.unsupported = 1;
  expect(isAttributableDirtyFixtureInstall(r, 3, ["semctx", "assertledger"])).toBe(false);
});
