import { join } from "node:path";
import { canonical, compatibleRegression, hash, readRequest } from "./workflow.js";
import { PROOF_PINS } from "./proof-plugin.js";

export async function associateEvidence(options, rt, root, report, request, reader) {
  const refuse = (code, detail, exitCode = 4) => {
    report.ok = false; report.verdict = "BLOCKED"; report.exitCode = exitCode;
    report.conflicts.push({ code, detail });
  };
  let evidence;
  try { evidence = readRequest(rt.resolve(options.evidence), 8 * 1024 * 1024); }
  catch { return refuse("WORKFLOW_EVIDENCE_UNREADABLE", "Provide a UTF-8 export file of at most 8 MiB"); }
  const packagePath = join(root, "node_modules", "assertledger", "package.json");
  const entry = join(root, "node_modules", "assertledger", "dist", "cli.js");
  let version;
  try { version = JSON.parse(rt.readText(packagePath)).version; }
  catch { return refuse("WORKFLOW_EVIDENCE_PROVIDER_UNAVAILABLE", "Install the project-local AssertLedger 1.4.0 runtime or keep the obligation open", 3); }
  if (version !== PROOF_PINS.assertledger || !rt.exists(entry) || !rt.which("node")) return refuse("WORKFLOW_EVIDENCE_PROVIDER_UNAVAILABLE", "Replay requires project-local AssertLedger 1.4.0 and Node", 3);
  // Pass the captured object on stdin: replay and bindings inspect identical input,
  // without creating a file or trusting a subsequently modified export path.
  const replayResult = await rt.exec(["node", entry, "export-replay", "-", "--json"], root, 120_000, false, JSON.stringify(evidence));
  let replay;
  try { replay = JSON.parse(replayResult.stdout); } catch { /* operational failure stays unavailable */ }
  const rails = ["valid", "schemaValid", "sourceManifestValid", "exportDigestValid", "semanticsValid"];
  report.checks.push({ id: "assertledger-export-replay", status: replayResult.code === 0 ? "replayed" : replayResult.code === 4 ? "replay-invalid" : "replay-unavailable", exitCode: replayResult.code, result: replay ?? null, runtimeVersion: version });
  if (![0, 4].includes(replayResult.code) || !replay || Object.keys(replay).length !== rails.length
    || rails.some(key => typeof replay[key] !== "boolean")) return refuse("WORKFLOW_EVIDENCE_REPLAY_UNAVAILABLE", "Native export replay failed operationally; no detection is inferred", 3);
  if (replayResult.code !== 0 || rails.some(key => replay[key] !== true)) return refuse("WORKFLOW_EVIDENCE_REPLAY_INVALID", "The native provider rejected the schema, manifest, digest or semantic reconstruction");
  if (!compatibleRegression(request)) return refuse("WORKFLOW_EVIDENCE_SCOPE_UNSUPPORTED", "This adapter associates only a named node:test Git regression with JavaScript candidate and base-test paths");
  if (evidence.schemaVersion !== "1.0.0" || evidence.consumerRequest?.reference !== `sha256:${report.requestDigest}`
    || evidence.consumerRequest.profileId !== null) return refuse("WORKFLOW_EVIDENCE_REQUEST_MISMATCH", "The export does not bind this exact canonical request");
  if (!["assertledger", "testforge"].includes(evidence.authenticity?.declaredProducer?.name)
    || evidence.authenticity.declaredProducer.version !== version) return refuse("WORKFLOW_EVIDENCE_PRODUCER_MISMATCH", "The declared export producer differs from the pinned replay runtime");
  const declared = new Set(request.proofObligationIds);
  if (evidence.consumerRequest.obligations.some(item => !declared.has(item.id))) return refuse("WORKFLOW_EVIDENCE_OBLIGATION_MISMATCH", "The export requests an obligation outside this change request");
  const { git } = reader;
  const expected = { REFERENCE: [request.scope.head, "reference"], TARGET: [request.scope.base, "target"], NEUTRAL: [request.regression.neutral, "neutral"] };
  if (evidence.scope.gitRevisions !== "RECORDED" || evidence.scope.worlds.length !== 3) return refuse("WORKFLOW_EVIDENCE_GIT_MISMATCH", "All three Git worlds must have explicit recorded provenance");
  for (const [kind, [commit, role]] of Object.entries(expected)) {
    const matches = evidence.scope.worlds.filter(world => world.kind === kind);
    const tree = await git("rev-parse", "--verify", `${commit}^{tree}`);
    if (matches.length !== 1 || matches[0].git?.commit !== commit || matches[0].git?.role !== role
      || tree.code !== 0 || matches[0].git?.tree !== tree.stdout.trim()) return refuse("WORKFLOW_EVIDENCE_GIT_MISMATCH", "Recorded Git commits and trees must match before, after and neutral in this repository");
  }
  const content = await git("show", `${request.scope.head}:${request.regression.test}`);
  if (content.code !== 0) return refuse("WORKFLOW_EVIDENCE_CANDIDATE_UNAVAILABLE", "Cannot read the selected regression test from the exact committed candidate", 3);
  const candidateDigest = `sha256:${hash(JSON.stringify(canonical([{ path: request.regression.test, content: content.stdout }])) )}`;
  if (evidence.result.candidates.length !== 1 || evidence.result.candidates[0].digest !== candidateDigest) return refuse("WORKFLOW_EVIDENCE_CANDIDATE_MISMATCH", "The exported test candidate differs from the selected committed test");
  const observed = evidence.result.detection === "OBSERVED" && evidence.result.modality === "TEST_OBSERVED";
  const associated = observed ? evidence.controls.requested.obligations.filter(item => item.control === "REGRESSION_DETECTION" && item.coverage === "EXECUTED").map(item => item.id).sort() : [];
  const missing = request.proofObligationIds.filter(id => !associated.includes(id)).sort();
  report.evidence = { status: observed ? "DEGRADED" : "NOT_OBSERVED", associatedObservationIds: associated,
    uncoveredObligationIds: missing, requestReference: evidence.consumerRequest.reference,
    exportDigest: evidence.exportDigest, sourceArtifactDigest: evidence.sourceArtifactDigest,
    exportFile: rt.resolve(options.evidence), sourceManifest: "embedded-preserved", declaredProducer: evidence.authenticity.declaredProducer,
    result: evidence.result, authenticity: evidence.authenticity, environment: evidence.environment,
    confidence: evidence.confidence, cost: evidence.cost, limitations: evidence.limitations };
  report.limitations.push("EVIDENCE_ADVISORY_ONLY", "EVIDENCE_UNAUTHENTICATED", "EVIDENCE_EXECUTION_FRESHNESS_UNKNOWN", "EVIDENCE_WORLD_RELEVANCE_UNPROVEN");
  if (missing.length) report.limitations.push("EVIDENCE_PARTIAL_COVERAGE");
}
