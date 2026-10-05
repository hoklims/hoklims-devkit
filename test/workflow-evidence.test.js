import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { associateEvidence } from "../src/workflow-evidence.js";
import { canonical, hash } from "../src/workflow.js";

// This native-generated fixture contains synthetic recorded observations only.
// Unit tests inject the replay boundary; a separate packaged integration invokes
// the pinned provider. Neither is candidate execution or observation attestation.
const evidence = JSON.parse(readFileSync(new URL("./fixtures/workflow-export.json", import.meta.url), "utf8"));
const root = "/syntheticrepo";
const request = { schemaVersion: 1, kind: "proof-routing-request", repositoryRoot: root, source: { provider: "semctx", version: "0.4.1" },
  scope: { base: "b".repeat(40), head: "a".repeat(40), diffSha256: "d".repeat(64) }, intent: "regression", proofObligationIds: ["compat", "detect"],
  regression: { claim: "synthetic named regression", framework: "node:test", before: "b".repeat(40), neutral: "c".repeat(40), neutralReason: "synthetic neutral", test: "tests/candidate.test.js", baseTests: ["tests/base.test.js"] } };
const fixtures = [];
afterAll(() => { for (const directory of fixtures) if (dirname(directory) === realpathSync(tmpdir())) rmSync(directory, { recursive: true, force: true }); });

async function associate(input = evidence, mode = "valid") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "devkit-evidence-"))); fixtures.push(directory);
  const path = join(directory, "export.json"); writeFileSync(path, JSON.stringify(input));
  const report = { ok: true, verdict: "PLANNED", authority: "none", execution: "not-run", requestDigest: hash(JSON.stringify(canonical(request))), conflicts: [], checks: [], limitations: [], unprovenObligationIds: [...request.proofObligationIds] };
  const calls = [];
  const rt = { resolve: value => value, exists: () => true, which: () => "node",
    readText: () => { if (mode === "absent") throw new Error("absent"); return JSON.stringify({ version: "1.4.0" }); },
    exec: async (...args) => { calls.push(args); return mode === "crash" ? { code: 5, stdout: "", stderr: "operational failure" }
      : { code: mode === "invalid" ? 4 : 0, stdout: JSON.stringify({ valid: mode !== "invalid", schemaValid: true, sourceManifestValid: true, exportDigestValid: mode !== "invalid", semanticsValid: true }), stderr: "" }; } };
  const reader = { git: async (...args) => ({ code: 0, stderr: "", stdout: args[0] === "show" ? "// synthetic candidate\n" : "e".repeat(40) }) };
  await associateEvidence({ evidence: path }, rt, root, report, request, reader);
  return { report, calls };
}

test("replayed observations stay advisory, partially covered and unproven", async () => {
  const { report, calls } = await associate();
  expect(report.conflicts).toEqual([]);
  expect(report.evidence.status).toBe("DEGRADED");
  expect(report.evidence.associatedObservationIds).toEqual(["detect"]);
  expect(report.evidence.uncoveredObligationIds).toEqual(["compat"]);
  expect(report.unprovenObligationIds).toEqual(["compat", "detect"]);
  expect(report.evidence.authenticity.status).toBe("UNAUTHENTICATED");
  expect(report.evidence.environment.isolation.level).toBe("UNSANDBOXED");
  expect(report.execution).toBe("not-run");
  expect(report.authority).toBe("none");
  expect(calls).toHaveLength(1);
  expect(calls[0][0].slice(-3)).toEqual(["export-replay", "-", "--json"]);
  expect(JSON.parse(calls[0][4])).toEqual(evidence);
});

test("a foreign request, revision, obligation or candidate cannot be rebound", async () => {
  const variants = [
    [input => { input.consumerRequest.reference = "foreign"; }, "WORKFLOW_EVIDENCE_REQUEST_MISMATCH"],
    [input => { input.scope.worlds[0].git.commit = "f".repeat(40); }, "WORKFLOW_EVIDENCE_GIT_MISMATCH"],
    [input => { input.consumerRequest.obligations[0].id = "foreign"; }, "WORKFLOW_EVIDENCE_OBLIGATION_MISMATCH"],
    [input => { input.result.candidates[0].digest = `sha256:${"f".repeat(64)}`; }, "WORKFLOW_EVIDENCE_CANDIDATE_MISMATCH"],
  ];
  for (const [mutate, code] of variants) {
    const input = structuredClone(evidence); mutate(input);
    const { report } = await associate(input);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0].code).toBe(code);
    expect(report.unprovenObligationIds).toEqual(["compat", "detect"]);
    expect(report.evidence).toBeUndefined();
  }
});

test("provider absence, invalid replay and operational failure never become detection", async () => {
  for (const [mode, code] of [["absent", "WORKFLOW_EVIDENCE_PROVIDER_UNAVAILABLE"], ["invalid", "WORKFLOW_EVIDENCE_REPLAY_INVALID"], ["crash", "WORKFLOW_EVIDENCE_REPLAY_UNAVAILABLE"]]) {
    const { report } = await associate(evidence, mode);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0].code).toBe(code);
    expect(report.evidence).toBeUndefined();
    expect(report.unprovenObligationIds).toEqual(["compat", "detect"]);
  }
});
