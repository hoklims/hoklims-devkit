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

function staleReport() {
  const r = report(); r.projectRoot = "/fixture";
  const q = r.components[0].semanticQualification;
  q.binding.sidecarDigest = "sha256:" + "a".repeat(64);
  q.binding.workspaceDigest = "sha256:" + "b".repeat(64);
  q.freshness = { verdict: "STALE", canRunHighRiskControl: false, reasons: ["WORKING_DIFF_MISMATCH"] };
  q.nativeSetup = { schemaVersion: 1, kind: "setup", repositoryRoot: r.projectRoot, check: { ok: true, errors: 0 }, indexHealth: { binding: { ...q.binding }, freshness: { verdict: "FRESH", canRunHighRiskControl: true } } };
  return r;
}
test("only a known working diff change after an initially fresh native setup permits fixture stabilization", () => {
  expect(isAttributableDirtyFixtureInstall(staleReport(), 3, ["semctx", "assertledger"])).toBe(true);
});
for (const defect of ["unknown-stale-reason", "mixed-stale-reason", "missing-initial-readback", "initial-stale", "initial-foreign", "changed-sidecar", "invalid-digest", "initial-error"]) test(`stale fixture refuses ${defect}`, () => {
  const r = staleReport(), q = r.components[0].semanticQualification;
  if (defect === "unknown-stale-reason") q.freshness.reasons = ["UNKNOWN"];
  if (defect === "mixed-stale-reason") q.freshness.reasons.push("UNKNOWN");
  if (defect === "missing-initial-readback") delete q.nativeSetup;
  if (defect === "initial-stale") q.nativeSetup.indexHealth.freshness.verdict = "STALE";
  if (defect === "initial-foreign") q.nativeSetup.repositoryRoot = "/foreign";
  if (defect === "changed-sidecar") q.nativeSetup.indexHealth.binding.sidecarDigest = "sha256:" + "c".repeat(64);
  if (defect === "invalid-digest") q.binding.sidecarDigest = q.nativeSetup.indexHealth.binding.sidecarDigest = "unknown";
  if (defect === "initial-error") q.nativeSetup.check.errors = 1;
  expect(isAttributableDirtyFixtureInstall(r, 3, ["semctx", "assertledger"])).toBe(false);
});
