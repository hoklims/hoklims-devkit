// Installation readiness does not authorize semantic or negative conclusions.
export function semctxReadiness(doctorResult, healthResult, version, root, realpath = value => value) {
  const doctor = doctorResult?.report ?? doctorResult;
  const health = healthResult?.report ?? healthResult;
  const doctorCode = doctorResult?.exitCode ?? doctorResult?.code;
  const healthCode = healthResult?.exitCode ?? healthResult?.code;
  const selected = Array.isArray(health?.candidates) ? health.candidates.filter(item => item?.selectionDecision === "selected") : [];
  const qualification = {
    status: health?.coverage?.status === "partial" || selected.some(item => item.negativeEvidenceEligible === false) ? "blocked" : "unknown",
    coverage: health?.coverage ?? null,
    nativeReasons: health?.reasonSummary ?? null,
    binding: health?.binding ?? null,
    freshness: health?.freshness ?? null,
    negativeEvidenceEligible: selected.length ? selected.every(item => item.negativeEvidenceEligible === true) : null,
    candidates: health?.candidates ?? null,
    evaluations: health?.evaluations ?? null,
  };
  const result = configuration => ({ configuration, semanticQualification: qualification });
  for (const candidate of [doctor?.repositoryRoot, health?.repositoryRoot]) {
    if (candidate === undefined) continue;
    try { if (typeof candidate !== "string" || realpath(candidate) !== root) return result("unknown"); }
    catch { return result("unknown"); }
  }
  const checks = ["cli", "workspace", "config", "index", "runtime"];
  if (![0, 1].includes(doctorCode) || ![0, 2, 3].includes(healthCode)
    || doctor?.version !== version || typeof doctor.healthy !== "boolean" || !Array.isArray(doctor.checks)
    || doctor.checks.some(check => typeof check?.name !== "string" || typeof check.ok !== "boolean")
    || !checks.every(name => doctor.checks.filter(check => check.name === name).length === 1
      && doctor.checks.find(check => check.name === name).ok !== undefined
      && typeof doctor.checks.find(check => check.name === name).ok === "boolean")
    || health?.schemaVersion !== 1 || health.kind !== "index_health"
    || !["complete", "partial", "insufficient"].includes(health.coverage?.status)
    || !Array.isArray(health.reasonSummary) || health.reasonSummary.some(reason => typeof reason !== "string")
    || !Array.isArray(health.candidates) || !Array.isArray(health.capabilities)
    || health.evaluations?.schemaVersion !== 1 || !Array.isArray(health.evaluations.decisions)) return result("unknown");
  const requiredGates = ["discoveryAndScope", "bindingAndIntegrity", "currentFreshness", "capabilityMatch", "negativeCompleteness", "taskRelativeAuthority"];
  if (selected.length && (!health.capabilities.length || !health.evaluations.decisions.length)
    || selected.some(candidate => ["candidateIdentity", "path", "language"].some(key => typeof candidate[key] !== "string" || !candidate[key]))
    || health.capabilities.some(capability => typeof capability?.language !== "string" || !capability.language
      || typeof capability.factKind !== "string" || !capability.factKind
      || typeof capability.completenessClaim !== "string" || !capability.completenessClaim
      || typeof capability.negativeEvidenceEligible !== "boolean")
    || health.evaluations.decisions.some(decision => typeof decision?.admissible !== "boolean"
      || !requiredGates.every(gate => ["passed", "failed"].includes(decision.gates?.[gate])))) return result("unknown");
  for (const decision of health.evaluations.decisions) {
    const candidate = selected.find(item => item.candidateIdentity === decision.candidateIdentity);
    const capability = health.capabilities.find(item => item.language === decision.scope?.language && item.factKind === decision.factKind);
    if (!candidate || !capability || decision.scope?.language !== candidate.language
      || !Array.isArray(decision.scope.selectedPaths) || !decision.scope.selectedPaths.includes(candidate.path)
      || (health.workspace?.repositoryId !== undefined && decision.scope.repositoryIdentity !== health.workspace.repositoryId)
      || (decision.gates.negativeCompleteness === "passed"
        ? candidate.negativeEvidenceEligible !== true || capability.negativeEvidenceEligible !== true || decision.admissible !== true
        : decision.admissible !== false || (candidate.negativeEvidenceEligible === true && capability.negativeEvidenceEligible === true))) return result("unknown");
  }
  if (selected.some(candidate => !health.evaluations.decisions.some(decision => decision.candidateIdentity === candidate.candidateIdentity))) return result("unknown");
  if (doctor.cliCompatibility !== undefined) {
    const cli = doctor.cliCompatibility;
    if (cli?.found !== true || cli.compatible !== true || cli.version !== version || cli.requiredVersion !== version
      || typeof cli.path !== "string" || !cli.path || cli.reason !== "CLI_VERSION_COMPATIBLE") return result("unknown");
  }
  const positiveChecks = doctor.checks.filter(check => check.name !== "index");
  const index = doctor.checks.find(check => check.name === "index");
  const coverage = health.coverage;
  if (!["candidates", "selected", "excluded", "analyzed", "unsupported", "failed", "disabled"].every(key =>
    Number.isSafeInteger(coverage[key]) && coverage[key] >= 0)
    || coverage.candidates !== health.candidates.length || coverage.selected !== selected.length
    || coverage.excluded !== health.candidates.filter(item => item.selectionDecision === "excluded").length
    || coverage.selected + coverage.excluded !== coverage.candidates
    || health.candidates.some(item => typeof item?.negativeEvidenceEligible !== "boolean"
      || !["selected", "excluded"].includes(item.selectionDecision))
    || ["analyzed", "unsupported", "failed", "disabled"].some(outcome =>
      coverage[outcome] !== selected.filter(item => item.analysisOutcome === outcome).length)) return result("unknown");
  if (positiveChecks.some(check => check.ok !== true) || health.binding?.status !== "valid"
    || health.freshness?.verdict !== "FRESH" || health.freshness.canRunHighRiskControl !== true
    || coverage.selected === 0 || coverage.analyzed !== coverage.selected
    || coverage.unsupported !== 0 || coverage.failed !== 0 || coverage.disabled !== 0
    || (health.workspace?.diagnostics?.length ?? 0) > 0
    || health.evaluations.decisions.some(decision => Object.entries(decision.gates ?? {}).some(([gate, status]) => gate !== "negativeCompleteness" && status !== "passed"))) return result("no");
  const complete = coverage.status === "complete" && healthCode === 0 && doctorCode === 0
    && doctor.healthy === true && index.ok === true && index.status === "healthy" && health.reasonSummary.length === 0;
  const positivePartial = coverage.status === "partial" && healthCode === 2 && doctorCode === 1
    && doctor.healthy === false && index.ok === false && index.status === "degraded"
    && health.reasonSummary.length > 0 && health.reasonSummary.every(reason => reason === "NEGATIVE_COMPLETENESS_MISSING");
  if (!complete && !positivePartial) return result("no");
  const decisions = health.evaluations?.decisions;
  if (complete && Array.isArray(health.capabilities) && health.capabilities.length > 0
    && coverage.selected > 0 && selected.length === coverage.selected
    && selected.every(item => item.analysisOutcome === "analyzed" && item.negativeEvidenceEligible === true)
    && Array.isArray(decisions) && decisions.length > 0
    && selected.every(candidate => health.capabilities.some(capability => capability.language === candidate.language
      && capability.negativeEvidenceEligible === true
      && typeof capability.completenessClaim === "string" && capability.completenessClaim.length > 0)
      && decisions.some(decision => typeof candidate.candidateIdentity === "string" && typeof candidate.path === "string"
        && decision.candidateIdentity === candidate.candidateIdentity
        && decision.scope?.language === candidate.language && Array.isArray(decision.scope.selectedPaths) && decision.scope.selectedPaths.includes(candidate.path)
        && decision.admissible === true && decision.gates?.negativeCompleteness === "passed"))
    && decisions.every(item => item.admissible === true && item.gates?.negativeCompleteness === "passed")) qualification.status = "certified";
  return result("yes");
}
