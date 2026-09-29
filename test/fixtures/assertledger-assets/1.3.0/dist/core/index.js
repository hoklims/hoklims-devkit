import { parseAgenticBenchmarkArtifact, parseAgenticBenchmarkAcquisitionResult, parseAgenticBenchmarkRequest, parseAgenticCorpusAllocation, parseAgenticCorpusAllocationCommitment, parseAgenticCorpusAllocationReveal, parseAgenticCorpusAllocationRequest, parseAgenticCorpusExperimentArtifact, parseAgenticCorpusExperimentPlan, parseAgenticCorpusExperimentReplayRequest, parseAgenticCorpusExperimentReceipt, parseAgenticCorpusExperimentRequest, parseAgenticCorpusExperimentStructuredResult, parseAgenticCorpusTrustPolicy, parseAgenticProfileReport, parseAgenticProfileReportV2, parseAgenticProfileRequest, parseAgenticProfileRequestV2, parseEvidenceExport, parseEvidenceExportRequest, parseEvidenceProviderManifest, } from "../contracts/index.js";
const EVIDENCE_SCHEMA_VERSION = "1.0.0";
// Version 2.0.0 adds a decision-bound execution backend record; its absence stays a v1 manifest.
const EVIDENCE_SCHEMA_VERSION_V2 = "2.0.0";
const EVIDENCE_SCHEMA_VERSION_V3 = "3.0.0";
const EVIDENCE_POLICY_VERSION = "1.0.0";
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OBSERVATION_OUTCOMES = new Set([
    "PASS",
    "ASSERTION_FAILURE",
    "COLLECTION_FAILURE",
    "COMPILE_FAILURE",
    "PROCESS_CRASH",
    "TIMEOUT",
    "INFRA_ERROR",
    "NO_TEST_DISCOVERED",
]);
export class EvidenceValidationError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "EvidenceValidationError";
    }
}
function canonicalJson(value, ancestors) {
    if (value === null)
        return "null";
    if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("Canonical JSON requires finite numbers");
        return JSON.stringify(value);
    }
    if (typeof value === "undefined") {
        throw new TypeError("undefined is not a canonical JSON value");
    }
    if (typeof value !== "object") {
        throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
    }
    if (ancestors.has(value))
        throw new TypeError("Canonical JSON cannot contain cycles");
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const items = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!(index in value))
                    throw new TypeError("Canonical JSON arrays cannot contain holes");
                items.push(canonicalJson(value[index], ancestors));
            }
            return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Canonical JSON requires plain objects");
        }
        const record = value;
        const keys = Object.keys(record).sort(compareOrdinal);
        const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`);
        return `{${entries.join(",")}}`;
    }
    finally {
        ancestors.delete(value);
    }
}
export function canonicalize(value) {
    return canonicalJson(value, new Set());
}
function rotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
}
const SHA256_CONSTANTS = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const state = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 64; index += 1) {
            const previous15 = words[index - 15] ?? 0;
            const previous2 = words[index - 2] ?? 0;
            const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
            const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
            words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temporary1 = (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temporary2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temporary1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temporary1 + temporary2) >>> 0;
        }
        const next = [a, b, c, d, e, f, g, h];
        for (let index = 0; index < 8; index += 1) {
            state[index] = ((state[index] ?? 0) + (next[index] ?? 0)) >>> 0;
        }
    }
    return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}
export function sha256Canonical(value) {
    return `sha256:${sha256(canonicalize(value))}`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0)
        throw new TypeError(`${key} must be a non-empty string`);
    return value;
}
function boundedStringField(record, key, maximum) {
    const value = stringField(record, key);
    if (value.length > maximum)
        throw new TypeError(`${key} must not exceed ${maximum} characters`);
    return value;
}
function digestField(record, key) {
    const value = stringField(record, key);
    if (!SHA256_DIGEST_PATTERN.test(value))
        throw new TypeError(`${key} must be a SHA-256 digest`);
    return value;
}
function identifierField(record, key) {
    const value = stringField(record, key);
    if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
        throw new TypeError(`${key} must be a portable ASCII identifier`);
    }
    return value;
}
function integerField(record, key, minimum = 0) {
    const value = record[key];
    if (!Number.isSafeInteger(value) || value < minimum)
        throw new TypeError(`${key} must be an integer >= ${minimum}`);
    return value;
}
function compareOrdinal(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function jsonField(record, key) {
    const value = record[key];
    canonicalize(value);
    return JSON.parse(JSON.stringify(value));
}
function sortedUniqueStrings(record, key, maximumItems, maximumLength) {
    const value = record[key];
    if (!Array.isArray(value) ||
        value.length > maximumItems ||
        value.some((item) => typeof item !== "string" || item.length === 0 || item.length > maximumLength)) {
        throw new TypeError(`${key} exceeds its string-array bounds`);
    }
    return [...new Set(value)].sort(compareOrdinal);
}
function parseEvidenceContext(value, schemaVersion) {
    if (!isRecord(value))
        throw new TypeError("evidenceContext must be an object");
    if (!isRecord(value.engine))
        throw new TypeError("evidenceContext.engine must be an object");
    if (!isRecord(value.adapter))
        throw new TypeError("evidenceContext.adapter must be an object");
    if (!isRecord(value.execution)) {
        throw new TypeError("evidenceContext.execution must be an object");
    }
    const backendRequired = schemaVersion === EVIDENCE_SCHEMA_VERSION_V2 || schemaVersion === EVIDENCE_SCHEMA_VERSION_V3;
    if (backendRequired && !isRecord(value.execution.backend)) {
        throw new TypeError("evidenceContext.execution.backend must be an object");
    }
    if (!Array.isArray(value.worlds) || value.worlds.length === 0) {
        throw new TypeError("evidenceContext.worlds must be non-empty");
    }
    const worlds = value.worlds
        .map((raw) => {
        if (!isRecord(raw))
            throw new TypeError("evidenceContext world must be an object");
        return {
            id: identifierField(raw, "id"),
            provenance: boundedStringField(raw, "provenance", 1_024),
            digest: digestField(raw, "digest"),
        };
    })
        .sort((left, right) => compareOrdinal(left.id, right.id));
    if (new Set(worlds.map((world) => world.id)).size !== worlds.length) {
        throw new TypeError("Duplicate evidenceContext world id");
    }
    return {
        engine: {
            name: boundedStringField(value.engine, "name", 128),
            version: boundedStringField(value.engine, "version", 128),
        },
        adapter: {
            name: boundedStringField(value.adapter, "name", 128),
            version: boundedStringField(value.adapter, "version", 128),
            configuration: jsonField(value.adapter, "configuration"),
        },
        execution: {
            isolation: boundedStringField(value.execution, "isolation", 128),
            environmentAllowlist: sortedUniqueStrings(value.execution, "environmentAllowlist", 100, 128),
            budgets: jsonField(value.execution, "budgets"),
            candidateRoots: sortedUniqueStrings(value.execution, "candidateRoots", 100, 512),
            ...(backendRequired ? { backend: jsonField(value.execution, "backend") } : {}),
        },
        worlds,
    };
}
function parseInputUnchecked(input) {
    if (!isRecord(input))
        throw new TypeError("Evidence must be an object");
    const schemaVersion = stringField(input, "schemaVersion");
    if (schemaVersion !== EVIDENCE_SCHEMA_VERSION &&
        schemaVersion !== EVIDENCE_SCHEMA_VERSION_V2 &&
        schemaVersion !== EVIDENCE_SCHEMA_VERSION_V3) {
        throw new TypeError(`Unsupported schemaVersion: ${schemaVersion}`);
    }
    const policyValue = input.policy;
    if (!isRecord(policyValue))
        throw new TypeError("policy must be an object");
    const policyVersion = stringField(policyValue, "policyVersion");
    if (policyVersion !== EVIDENCE_POLICY_VERSION) {
        throw new TypeError(`Unsupported policyVersion: ${policyVersion}`);
    }
    const attempts = integerField(policyValue, "requiredAttempts", 1);
    if (attempts > 1_000)
        throw new TypeError("requiredAttempts must not exceed 1000");
    const minimum = integerField(policyValue, "minimumTargetWeightPermille", 1);
    if (minimum > 1_000)
        throw new TypeError("minimumTargetWeightPermille must not exceed 1000");
    const acceptedValue = policyValue.acceptedTargetOutcomes;
    if (!Array.isArray(acceptedValue) ||
        acceptedValue.length !== 1 ||
        acceptedValue[0] !== "ASSERTION_FAILURE") {
        throw new TypeError("acceptedTargetOutcomes must be exactly [ASSERTION_FAILURE]");
    }
    const policy = {
        policyVersion,
        requiredAttempts: attempts,
        minimumTargetWeightPermille: minimum,
        maximumSelectedCandidates: integerField(policyValue, "maximumSelectedCandidates", 1),
        acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    };
    if (policy.maximumSelectedCandidates > 1_000) {
        throw new TypeError("maximumSelectedCandidates must not exceed 1000");
    }
    if (!Array.isArray(input.worlds) || input.worlds.length === 0)
        throw new TypeError("worlds must be non-empty");
    const worlds = input.worlds
        .map((raw) => {
        if (!isRecord(raw))
            throw new TypeError("world must be an object");
        const kind = raw.kind;
        if (kind !== "REFERENCE" && kind !== "TARGET" && kind !== "NEUTRAL")
            throw new TypeError("Invalid world kind");
        if (typeof raw.required !== "boolean")
            throw new TypeError("world.required must be boolean");
        const world = {
            id: identifierField(raw, "id"),
            kind,
            required: raw.required,
            weight: integerField(raw, "weight"),
        };
        if (kind === "TARGET" && world.weight < 1) {
            throw new TypeError("TARGET world weight must be at least 1");
        }
        if (kind !== "TARGET" && world.weight !== 0) {
            throw new TypeError("Non-target world weight must be 0");
        }
        if (world.weight > 1_000_000)
            throw new TypeError("world weight must not exceed 1000000");
        return world;
    })
        .sort((left, right) => compareOrdinal(left.id, right.id));
    if (new Set(worlds.map((world) => world.id)).size !== worlds.length)
        throw new TypeError("Duplicate world id");
    for (const kind of ["REFERENCE", "TARGET", "NEUTRAL"]) {
        if (!worlds.some((world) => world.kind === kind && world.required)) {
            throw new TypeError(`At least one required ${kind} world is required`);
        }
    }
    const worldIds = new Set(worlds.map((world) => world.id));
    const evidenceContext = parseEvidenceContext(input.evidenceContext, schemaVersion);
    if (evidenceContext.worlds.length !== worlds.length ||
        evidenceContext.worlds.some((world) => !worldIds.has(world.id))) {
        throw new TypeError("evidenceContext worlds must exactly match decision worlds");
    }
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
        throw new TypeError("candidates must be non-empty");
    }
    const candidates = input.candidates
        .map((raw) => {
        if (!isRecord(raw))
            throw new TypeError("candidate must be an object");
        return {
            id: identifierField(raw, "id"),
            digest: digestField(raw, "digest"),
            sizeBytes: integerField(raw, "sizeBytes"),
        };
    })
        .sort((left, right) => compareOrdinal(left.id, right.id));
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
        throw new TypeError("Duplicate candidate id");
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    if (!Array.isArray(input.observations))
        throw new TypeError("observations must be an array");
    const observations = input.observations
        .map((raw) => {
        if (!isRecord(raw))
            throw new TypeError("observation must be an object");
        const candidateId = raw.candidateId;
        if (candidateId !== null &&
            (typeof candidateId !== "string" || !candidateIds.has(candidateId)))
            throw new TypeError("Unknown candidateId");
        const worldId = stringField(raw, "worldId");
        if (!worldIds.has(worldId))
            throw new TypeError("Unknown worldId");
        if (typeof raw.attributed !== "boolean")
            throw new TypeError("attributed must be boolean");
        const duration = raw.durationMs;
        if (duration !== undefined &&
            (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0))
            throw new TypeError("durationMs must be finite and non-negative");
        const exitCode = raw.exitCode;
        if (exitCode !== undefined &&
            exitCode !== null &&
            (!Number.isSafeInteger(exitCode) || exitCode < 0)) {
            throw new TypeError("exitCode must be null or a non-negative integer");
        }
        const stdoutDigest = raw.stdoutDigest === undefined ? undefined : digestField(raw, "stdoutDigest");
        const stderrDigest = raw.stderrDigest === undefined ? undefined : digestField(raw, "stderrDigest");
        const testsDiscovered = integerField(raw, "testsDiscovered");
        const candidateTestsDiscovered = integerField(raw, "candidateTestsDiscovered");
        if (candidateTestsDiscovered > testsDiscovered) {
            throw new TypeError("candidateTestsDiscovered must not exceed testsDiscovered");
        }
        const outcome = boundedStringField(raw, "outcome", 64);
        if (!OBSERVATION_OUTCOMES.has(outcome))
            throw new TypeError("Invalid observation outcome");
        return {
            runId: boundedStringField(raw, "runId", 512),
            candidateId,
            worldId,
            attempt: integerField(raw, "attempt", 1),
            outcome,
            testsDiscovered,
            candidateTestsDiscovered,
            attributed: raw.attributed,
            ...(duration === undefined ? {} : { durationMs: duration }),
            ...(exitCode === undefined ? {} : { exitCode: exitCode }),
            ...(stdoutDigest === undefined ? {} : { stdoutDigest }),
            ...(stderrDigest === undefined ? {} : { stderrDigest }),
        };
    })
        .sort(compareObservations);
    if (new Set(observations.map((item) => item.runId)).size !== observations.length)
        throw new TypeError("Duplicate runId");
    return {
        schemaVersion,
        repositoryDigest: digestField(input, "repositoryDigest"),
        evidenceContext,
        policy,
        worlds,
        candidates,
        observations,
    };
}
function parseInput(input) {
    try {
        return parseInputUnchecked(input);
    }
    catch (error) {
        if (error instanceof EvidenceValidationError)
            throw error;
        if (error instanceof TypeError) {
            throw new EvidenceValidationError(error.message, { cause: error });
        }
        throw error;
    }
}
function compareObservations(left, right) {
    return (compareOrdinal(left.candidateId ?? "", right.candidateId ?? "") ||
        compareOrdinal(left.worldId, right.worldId) ||
        left.attempt - right.attempt ||
        compareOrdinal(left.runId, right.runId));
}
const INCONCLUSIVE_OUTCOMES = new Set(["TIMEOUT", "INFRA_ERROR"]);
function runsFor(input, candidateId, worldId) {
    return input.observations.filter((run) => run.candidateId === candidateId && run.worldId === worldId);
}
function isComplete(runs, requiredAttempts) {
    if (runs.length !== requiredAttempts)
        return false;
    const attempts = new Set(runs.map((run) => run.attempt));
    if (attempts.size !== requiredAttempts)
        return false;
    for (let attempt = 1; attempt <= requiredAttempts; attempt += 1)
        if (!attempts.has(attempt))
            return false;
    return true;
}
function isCompleteStable(runs, requiredAttempts) {
    if (!isComplete(runs, requiredAttempts))
        return false;
    return runs.every((run) => run.outcome === runs[0]?.outcome);
}
function controlsAreValid(input) {
    return input.worlds.every((world) => {
        const runs = runsFor(input, null, world.id);
        return (isCompleteStable(runs, input.policy.requiredAttempts) &&
            runs.every((run) => run.outcome === "PASS" && run.candidateTestsDiscovered === 0 && !run.attributed));
    });
}
function assessCandidate(input, candidate) {
    const worldRuns = input.worlds.map((world) => ({
        world,
        runs: runsFor(input, candidate.id, world.id),
    }));
    const allRuns = worldRuns.flatMap(({ runs }) => runs).sort(compareObservations);
    const ids = (runs) => runs.map((run) => run.runId).sort(compareOrdinal);
    const notRun = (name) => ({
        name,
        status: "NOT_RUN",
        evidenceRunIds: [],
        reasonCodes: ["PREREQUISITE_GATE_FAILED"],
    });
    const gates = [];
    const complete = worldRuns.every(({ runs }) => isComplete(runs, input.policy.requiredAttempts));
    gates.push({
        name: "COMPLETENESS",
        status: complete ? "PASSED" : "FAILED",
        evidenceRunIds: ids(allRuns),
        reasonCodes: complete ? [] : ["CANDIDATE_EVIDENCE_INCOMPLETE"],
    });
    if (!complete) {
        gates.push(notRun("STABILITY"), notRun("DISCOVERY"), notRun("REFERENCE"), notRun("NEUTRAL"), notRun("TARGET_STRENGTH"));
        return {
            ...candidate,
            status: "INCONCLUSIVE",
            killedTargetIds: [],
            targetWeightKilled: 0,
            gates,
            reasonCodes: ["CANDIDATE_EVIDENCE_INCOMPLETE"],
        };
    }
    const stable = worldRuns.every(({ runs }) => isCompleteStable(runs, input.policy.requiredAttempts));
    gates.push({
        name: "STABILITY",
        status: stable ? "PASSED" : "FAILED",
        evidenceRunIds: ids(allRuns),
        reasonCodes: stable ? [] : ["OBSERVATIONS_DIVERGE"],
    });
    if (!stable) {
        gates.push(notRun("DISCOVERY"), notRun("REFERENCE"), notRun("NEUTRAL"), notRun("TARGET_STRENGTH"));
        return {
            ...candidate,
            status: "UNSTABLE",
            killedTargetIds: [],
            targetWeightKilled: 0,
            gates,
            reasonCodes: ["OBSERVATIONS_DIVERGE"],
        };
    }
    const undiscoveredRuns = allRuns.filter((run) => !(run.candidateTestsDiscovered >= 1 && run.attributed));
    const discoveryValid = undiscoveredRuns.length === 0;
    // A run that timed out or failed in infrastructure never reached a verdict: it can neither
    // prove nor disprove discovery. Only a completed run makes the candidate invalid here.
    const discoveryInconclusive = !discoveryValid && undiscoveredRuns.every((run) => INCONCLUSIVE_OUTCOMES.has(run.outcome));
    const discoveryReason = discoveryInconclusive
        ? "CANDIDATE_EXECUTION_INCONCLUSIVE"
        : "CANDIDATE_DISCOVERY_INVALID";
    gates.push({
        name: "DISCOVERY",
        status: discoveryValid ? "PASSED" : "FAILED",
        evidenceRunIds: ids(allRuns),
        reasonCodes: discoveryValid ? [] : [discoveryReason],
    });
    if (!discoveryValid) {
        gates.push(notRun("REFERENCE"), notRun("NEUTRAL"), notRun("TARGET_STRENGTH"));
        return {
            ...candidate,
            status: discoveryInconclusive ? "INCONCLUSIVE" : "INVALID",
            killedTargetIds: [],
            targetWeightKilled: 0,
            gates,
            reasonCodes: [discoveryReason],
        };
    }
    const referenceRuns = worldRuns
        .filter(({ world }) => world.kind === "REFERENCE")
        .flatMap(({ runs }) => runs);
    const referencePassed = referenceRuns.every((run) => run.outcome === "PASS");
    gates.push({
        name: "REFERENCE",
        status: referencePassed ? "PASSED" : "FAILED",
        evidenceRunIds: ids(referenceRuns),
        reasonCodes: referencePassed ? [] : ["REFERENCE_NOT_GREEN"],
    });
    const neutralRuns = worldRuns
        .filter(({ world }) => world.kind === "NEUTRAL")
        .flatMap(({ runs }) => runs);
    const neutralPassed = neutralRuns.every((run) => run.outcome === "PASS");
    gates.push({
        name: "NEUTRAL",
        status: neutralPassed ? "PASSED" : "FAILED",
        evidenceRunIds: ids(neutralRuns),
        reasonCodes: neutralPassed ? [] : ["NEUTRAL_NOT_GREEN"],
    });
    const killedWorlds = worldRuns
        .filter(({ world, runs }) => world.kind === "TARGET" &&
        runs.every((run) => run.attributed && run.outcome === "ASSERTION_FAILURE"))
        .map(({ world }) => world);
    const killedTargetIds = killedWorlds.map((world) => world.id).sort(compareOrdinal);
    const targetWeightKilled = killedWorlds.reduce((sum, world) => sum + world.weight, 0);
    const allTargets = input.worlds.filter((world) => world.kind === "TARGET");
    const totalWeight = allTargets.reduce((sum, world) => sum + world.weight, 0);
    const requiredKilled = allTargets
        .filter((world) => world.required)
        .every((world) => killedTargetIds.includes(world.id));
    const thresholdMet = totalWeight > 0 &&
        targetWeightKilled * 1_000 >= totalWeight * input.policy.minimumTargetWeightPermille;
    const targetPassed = requiredKilled && thresholdMet;
    const targetRuns = worldRuns
        .filter(({ world }) => world.kind === "TARGET")
        .flatMap(({ runs }) => runs);
    const targetExecutionInconclusive = targetRuns.some((run) => INCONCLUSIVE_OUTCOMES.has(run.outcome));
    gates.push({
        name: "TARGET_STRENGTH",
        status: targetPassed ? "PASSED" : "FAILED",
        evidenceRunIds: ids(targetRuns),
        reasonCodes: targetPassed
            ? []
            : [
                targetExecutionInconclusive
                    ? "CANDIDATE_EXECUTION_INCONCLUSIVE"
                    : "TARGET_STRENGTH_INSUFFICIENT",
            ],
    });
    const executionInconclusive = allRuns.some((run) => INCONCLUSIVE_OUTCOMES.has(run.outcome));
    const status = executionInconclusive
        ? "INCONCLUSIVE"
        : !referencePassed || !neutralPassed
            ? "INVALID"
            : targetPassed
                ? "ELIGIBLE"
                : "WEAK_ORACLE";
    const reasonCodes = executionInconclusive
        ? ["CANDIDATE_EXECUTION_INCONCLUSIVE"]
        : !referencePassed
            ? ["REFERENCE_NOT_GREEN"]
            : !neutralPassed
                ? ["NEUTRAL_NOT_GREEN"]
                : targetPassed
                    ? ["POLICY_SATISFIED"]
                    : ["TARGET_STRENGTH_INSUFFICIENT"];
    return {
        ...candidate,
        status,
        killedTargetIds,
        targetWeightKilled,
        gates,
        reasonCodes,
    };
}
export function selectCandidates(assessments, maximum) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || !Array.isArray(assessments))
        return [];
    const eligible = assessments.flatMap((raw) => {
        if (!isRecord(raw) ||
            raw.status !== "ELIGIBLE" ||
            typeof raw.id !== "string" ||
            typeof raw.digest !== "string" ||
            !Number.isSafeInteger(raw.sizeBytes) ||
            !Array.isArray(raw.killedTargetIds) ||
            raw.killedTargetIds.some((id) => typeof id !== "string"))
            return [];
        return [
            {
                id: raw.id,
                digest: raw.digest,
                sizeBytes: raw.sizeBytes,
                killedTargetIds: [...new Set(raw.killedTargetIds)].sort(compareOrdinal),
            },
        ];
    });
    const selected = [];
    const covered = new Set();
    const remaining = [...eligible];
    while (selected.length < maximum && remaining.length > 0) {
        remaining.sort((left, right) => {
            const leftMarginal = left.killedTargetIds.filter((id) => !covered.has(id)).length;
            const rightMarginal = right.killedTargetIds.filter((id) => !covered.has(id)).length;
            return (rightMarginal - leftMarginal ||
                left.sizeBytes - right.sizeBytes ||
                compareOrdinal(left.digest, right.digest) ||
                compareOrdinal(left.id, right.id));
        });
        const best = remaining.shift();
        if (!best || best.killedTargetIds.every((id) => covered.has(id)))
            break;
        selected.push(best.id);
        for (const id of best.killedTargetIds)
            covered.add(id);
    }
    return selected;
}
function digestProjection(manifest) {
    return {
        schemaVersion: manifest.schemaVersion,
        repositoryDigest: manifest.repositoryDigest,
        evidenceContext: manifest.evidenceContext,
        policy: manifest.policy,
        worlds: [...manifest.worlds].sort((a, b) => compareOrdinal(a.id, b.id)),
        candidates: [...manifest.candidates].sort((a, b) => compareOrdinal(a.id, b.id)),
        observations: [...manifest.observations]
            .sort(compareObservations)
            .map(({ durationMs: _durationMs, exitCode: _exitCode, stdoutDigest: _stdoutDigest, stderrDigest: _stderrDigest, ...run }) => run),
        decision: manifest.decision,
    };
}
function artifactProjection(manifest) {
    const { artifactDigest: _artifactDigest, ...artifact } = manifest;
    return artifact;
}
export function sealManifestArtifact(manifest) {
    return {
        ...manifest,
        artifactDigest: sha256Canonical(artifactProjection(manifest)),
    };
}
function finishManifest(base) {
    const decisionSealed = {
        ...base,
        decisionDigest: sha256Canonical(digestProjection(base)),
    };
    return sealManifestArtifact(decisionSealed);
}
export function decideEvidence(input) {
    let evidence;
    try {
        evidence = parseInput(input);
    }
    catch (error) {
        if (!(error instanceof EvidenceValidationError))
            throw error;
        return finishManifest({
            schemaVersion: "1.0.0",
            repositoryDigest: "invalid",
            evidenceContext: {
                engine: { name: "invalid", version: "invalid" },
                adapter: { name: "invalid", version: "invalid", configuration: {} },
                execution: {
                    isolation: "invalid",
                    environmentAllowlist: [],
                    budgets: {},
                    candidateRoots: [],
                },
                worlds: [],
            },
            policy: {
                policyVersion: "invalid",
                requiredAttempts: 1,
                minimumTargetWeightPermille: 1_000,
                maximumSelectedCandidates: 0,
                acceptedTargetOutcomes: [],
            },
            worlds: [],
            candidates: [],
            observations: [],
            decision: {
                status: "ENGINE_ERROR",
                selectedCandidateIds: [],
                reasonCodes: ["EVIDENCE_INPUT_INVALID"],
            },
        });
    }
    const candidates = evidence.candidates.map((candidate) => assessCandidate(evidence, candidate));
    const invalidControls = !controlsAreValid(evidence);
    const hasInconclusiveCandidate = candidates.some((candidate) => candidate.status === "UNSTABLE" || candidate.status === "INCONCLUSIVE");
    const selectedCandidateIds = invalidControls
        ? []
        : selectCandidates(candidates, evidence.policy.maximumSelectedCandidates);
    const status = invalidControls
        ? "INCONCLUSIVE"
        : selectedCandidateIds.length > 0
            ? "VERIFIED"
            : hasInconclusiveCandidate
                ? "INCONCLUSIVE"
                : "REJECTED";
    const reasonCodes = [
        ...(invalidControls ? ["CONTROL_EVIDENCE_INVALID"] : []),
        ...(!invalidControls && selectedCandidateIds.length > 0 ? ["POLICY_SATISFIED"] : []),
        ...(!invalidControls && selectedCandidateIds.length === 0 && hasInconclusiveCandidate
            ? ["CANDIDATE_EVIDENCE_INCONCLUSIVE"]
            : []),
        ...(!invalidControls && selectedCandidateIds.length === 0 && !hasInconclusiveCandidate
            ? ["NO_ELIGIBLE_CANDIDATE"]
            : []),
    ];
    return finishManifest({
        ...evidence,
        candidates,
        decision: { status, selectedCandidateIds, reasonCodes },
    });
}
export function verifyDecisionDigest(manifest) {
    if (!isRecord(manifest) || typeof manifest.decisionDigest !== "string")
        return { valid: false };
    try {
        const candidate = manifest;
        return { valid: candidate.decisionDigest === sha256Canonical(digestProjection(candidate)) };
    }
    catch {
        return { valid: false };
    }
}
export function verifyManifestIntegrity(manifest) {
    if (!isRecord(manifest)) {
        return { valid: false, decisionDigestValid: false, artifactDigestValid: false };
    }
    const decisionDigestValid = verifyDecisionDigest(manifest).valid;
    let artifactDigestValid = false;
    try {
        artifactDigestValid =
            typeof manifest.artifactDigest === "string" &&
                manifest.artifactDigest === sha256Canonical(artifactProjection(manifest));
    }
    catch {
        artifactDigestValid = false;
    }
    return {
        valid: decisionDigestValid && artifactDigestValid,
        decisionDigestValid,
        artifactDigestValid,
    };
}
function replayCandidateSemantics(candidates) {
    if (!Array.isArray(candidates))
        throw new TypeError("manifest.candidates must be an array");
    return candidates
        .map((raw) => {
        if (!isRecord(raw))
            throw new TypeError("manifest candidate must be an object");
        return {
            id: stringField(raw, "id"),
            digest: stringField(raw, "digest"),
            sizeBytes: integerField(raw, "sizeBytes"),
            status: stringField(raw, "status"),
            killedTargetIds: jsonField(raw, "killedTargetIds"),
            targetWeightKilled: integerField(raw, "targetWeightKilled"),
            gates: jsonField(raw, "gates"),
            reasonCodes: jsonField(raw, "reasonCodes"),
        };
    })
        .sort((left, right) => compareOrdinal(left.id, right.id));
}
export function replayEvidenceManifest(manifest) {
    const invalid = {
        valid: false,
        decisionDigestValid: false,
        artifactDigestValid: false,
        decisionSemanticsValid: false,
    };
    if (!isRecord(manifest))
        return invalid;
    const integrity = verifyManifestIntegrity(manifest);
    try {
        if (!isRecord(manifest.evidenceContext) ||
            !isRecord(manifest.policy) ||
            !Array.isArray(manifest.worlds) ||
            !Array.isArray(manifest.candidates) ||
            !Array.isArray(manifest.observations) ||
            !isRecord(manifest.decision)) {
            throw new TypeError("Manifest does not contain replayable evidence");
        }
        const candidates = manifest.candidates.map((raw) => {
            if (!isRecord(raw))
                throw new TypeError("manifest candidate must be an object");
            return {
                id: stringField(raw, "id"),
                digest: stringField(raw, "digest"),
                sizeBytes: integerField(raw, "sizeBytes"),
            };
        });
        const replayed = decideEvidence({
            schemaVersion: manifest.schemaVersion,
            repositoryDigest: manifest.repositoryDigest,
            evidenceContext: manifest.evidenceContext,
            policy: manifest.policy,
            worlds: manifest.worlds,
            candidates,
            observations: manifest.observations,
        });
        const decisionSemanticsValid = replayed.decision.status !== "ENGINE_ERROR" &&
            replayed.decisionDigest === manifest.decisionDigest &&
            canonicalize({
                candidates: replayCandidateSemantics(replayed.candidates),
                decision: replayed.decision,
            }) ===
                canonicalize({
                    candidates: replayCandidateSemantics(manifest.candidates),
                    decision: manifest.decision,
                });
        return {
            valid: integrity.decisionDigestValid && integrity.artifactDigestValid && decisionSemanticsValid,
            decisionDigestValid: integrity.decisionDigestValid,
            artifactDigestValid: integrity.artifactDigestValid,
            decisionSemanticsValid,
        };
    }
    catch {
        return {
            ...invalid,
            decisionDigestValid: integrity.decisionDigestValid,
            artifactDigestValid: integrity.artifactDigestValid,
        };
    }
}
function nearestRank(sorted, percentile) {
    if (sorted.length === 0)
        return null;
    return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}
function agenticReportProjection(report) {
    const { reportDigest: _reportDigest, ...projection } = report;
    return projection;
}
export function createAgenticProfile(request) {
    request = parseAgenticProfileRequest(request);
    if (!replayEvidenceManifest(request.manifest).valid) {
        throw new EvidenceValidationError("AGENTIC_PROFILE_SOURCE_INVALID");
    }
    const targetWorlds = request.manifest.worlds.filter((world) => world.kind === "TARGET");
    const referenceIds = new Set(request.manifest.worlds.filter((world) => world.kind === "REFERENCE").map((world) => world.id));
    const targetWeights = new Map(targetWorlds.map((world) => [world.id, world.weight]));
    const totalTargetWeight = targetWorlds.reduce((total, world) => total + world.weight, 0);
    const requiredTargetIds = new Set(targetWorlds.filter((world) => world.required).map((world) => world.id));
    const selected = new Set(request.manifest.decision.selectedCandidateIds);
    const marginalWeight = new Map();
    const coveredTargets = new Set();
    for (const id of request.manifest.decision.selectedCandidateIds) {
        const candidate = request.manifest.candidates.find((item) => item.id === id);
        let weight = 0;
        for (const targetId of candidate?.killedTargetIds ?? []) {
            if (!coveredTargets.has(targetId))
                weight += targetWeights.get(targetId) ?? 0;
            coveredTargets.add(targetId);
        }
        marginalWeight.set(id, weight);
    }
    const candidates = request.manifest.candidates
        .map((candidate) => {
        const observations = request.manifest.observations.filter((observation) => observation.candidateId === candidate.id);
        const referenceDurations = observations
            .filter((observation) => referenceIds.has(observation.worldId) && typeof observation.durationMs === "number")
            .map((observation) => observation.durationMs)
            .sort((left, right) => left - right);
        const totalCandidateDurationMs = observations.reduce((total, observation) => total + (observation.durationMs ?? 0), 0);
        const p95Ms = nearestRank(referenceDurations, 0.95);
        const evidenceQualified = request.manifest.decision.status === "VERIFIED" &&
            selected.has(candidate.id) &&
            candidate.status === "ELIGIBLE";
        const timingSufficient = referenceDurations.length >= request.policy.minimumTimingSamples;
        const satisfiedLaneIds = evidenceQualified && timingSufficient && p95Ms !== null
            ? request.policy.lanes
                .filter((lane) => p95Ms <= lane.maximumReferenceP95Ms)
                .map((lane) => lane.id)
            : [];
        const classification = !evidenceQualified
            ? "NOT_QUALIFIED"
            : !timingSufficient
                ? "INSUFFICIENT_TIMING_EVIDENCE"
                : satisfiedLaneIds.length === 0
                    ? "BUDGET_MISSED"
                    : "QUALIFIED";
        return {
            id: candidate.id,
            evidenceStatus: candidate.status,
            classification,
            satisfiedLaneIds,
            bestLaneId: satisfiedLaneIds[0] ?? null,
            targetWeightKilled: candidate.targetWeightKilled,
            totalTargetWeight,
            targetWeightPermille: totalTargetWeight === 0
                ? 0
                : Math.floor((candidate.targetWeightKilled * 1_000) / totalTargetWeight),
            requiredTargetsKilled: candidate.killedTargetIds.filter((id) => requiredTargetIds.has(id))
                .length,
            requiredTargetsTotal: requiredTargetIds.size,
            killedTargetIds: [...candidate.killedTargetIds].sort(compareOrdinal),
            marginalTargetWeight: marginalWeight.get(candidate.id) ?? 0,
            consistency: {
                claim: candidate.gates.find((gate) => gate.name === "STABILITY")?.status === "PASSED"
                    ? "OBSERVED_CONSISTENT"
                    : "OBSERVED_INCONSISTENT",
                attempts: request.manifest.policy.requiredAttempts,
            },
            latency: {
                kind: "RECORDED_REFERENCE_WALL_TIME",
                samples: referenceDurations.length,
                minimumMs: referenceDurations[0] ?? null,
                p50Ms: nearestRank(referenceDurations, 0.5),
                p95Ms,
                maximumMs: referenceDurations.at(-1) ?? null,
                totalCandidateDurationMs,
            },
            paretoFrontier: false,
            sizeBytes: candidate.sizeBytes,
            digest: candidate.digest,
        };
    })
        .sort((left, right) => compareOrdinal(left.id, right.id));
    for (const candidate of candidates) {
        if ((candidate.classification !== "QUALIFIED" && candidate.classification !== "BUDGET_MISSED") ||
            candidate.latency.p95Ms === null) {
            continue;
        }
        const candidateP95Ms = candidate.latency.p95Ms;
        candidate.paretoFrontier = !candidates.some((other) => {
            const otherP95Ms = other.latency.p95Ms;
            return (other.id !== candidate.id &&
                (other.classification === "QUALIFIED" || other.classification === "BUDGET_MISSED") &&
                otherP95Ms !== null &&
                other.targetWeightKilled >= candidate.targetWeightKilled &&
                other.requiredTargetsKilled >= candidate.requiredTargetsKilled &&
                otherP95Ms <= candidateP95Ms &&
                other.latency.totalCandidateDurationMs <= candidate.latency.totalCandidateDurationMs &&
                other.sizeBytes <= candidate.sizeBytes &&
                (other.targetWeightKilled > candidate.targetWeightKilled ||
                    other.requiredTargetsKilled > candidate.requiredTargetsKilled ||
                    otherP95Ms < candidateP95Ms ||
                    other.latency.totalCandidateDurationMs < candidate.latency.totalCandidateDurationMs ||
                    other.sizeBytes < candidate.sizeBytes));
        });
    }
    const portfolios = request.policy.lanes.map((lane) => {
        const selectedCandidateIds = [];
        const selectedTargets = new Set();
        let totalReferenceP95Ms = 0;
        while (true) {
            const remainingBudget = lane.maximumReferenceP95Ms - totalReferenceP95Ms;
            const choices = candidates
                .filter((candidate) => candidate.classification === "QUALIFIED" &&
                candidate.satisfiedLaneIds.includes(lane.id) &&
                !selectedCandidateIds.includes(candidate.id) &&
                candidate.latency.p95Ms !== null &&
                candidate.latency.p95Ms <= remainingBudget)
                .map((candidate) => ({
                candidate,
                marginalWeight: candidate.killedTargetIds.reduce((weight, targetId) => weight + (selectedTargets.has(targetId) ? 0 : (targetWeights.get(targetId) ?? 0)), 0),
            }))
                .filter((choice) => choice.marginalWeight > 0)
                .sort((left, right) => {
                const leftCost = left.candidate.latency.p95Ms;
                const rightCost = right.candidate.latency.p95Ms;
                if (leftCost === 0 || rightCost === 0) {
                    if (leftCost === 0 && rightCost !== 0)
                        return -1;
                    if (rightCost === 0 && leftCost !== 0)
                        return 1;
                }
                else {
                    const leftRatio = left.marginalWeight * rightCost;
                    const rightRatio = right.marginalWeight * leftCost;
                    if (leftRatio !== rightRatio)
                        return leftRatio > rightRatio ? -1 : 1;
                }
                if (left.marginalWeight !== right.marginalWeight) {
                    return right.marginalWeight - left.marginalWeight;
                }
                if (leftCost !== rightCost)
                    return leftCost - rightCost;
                if (left.candidate.sizeBytes !== right.candidate.sizeBytes) {
                    return left.candidate.sizeBytes - right.candidate.sizeBytes;
                }
                const digestOrder = compareOrdinal(left.candidate.digest, right.candidate.digest);
                return digestOrder !== 0
                    ? digestOrder
                    : compareOrdinal(left.candidate.id, right.candidate.id);
            });
            const choice = choices[0];
            if (choice === undefined)
                break;
            selectedCandidateIds.push(choice.candidate.id);
            totalReferenceP95Ms += choice.candidate.latency.p95Ms;
            for (const targetId of choice.candidate.killedTargetIds)
                selectedTargets.add(targetId);
        }
        const targetWeight = [...selectedTargets].reduce((weight, targetId) => weight + (targetWeights.get(targetId) ?? 0), 0);
        return {
            laneId: lane.id,
            budgetMs: lane.maximumReferenceP95Ms,
            selectedCandidateIds,
            totalReferenceP95Ms,
            targetWeight,
            targetWeightPermille: totalTargetWeight === 0 ? 0 : Math.floor((targetWeight * 1_000) / totalTargetWeight),
            requiredTargetsKilled: [...selectedTargets].filter((id) => requiredTargetIds.has(id)).length,
            requiredTargetsTotal: requiredTargetIds.size,
        };
    });
    const publicCandidates = candidates.map(({ sizeBytes: _sizeBytes, digest: _digest, ...candidate }) => candidate);
    const qualifiedCandidateIds = publicCandidates
        .filter((candidate) => candidate.classification === "QUALIFIED")
        .map((candidate) => candidate.id);
    const status = qualifiedCandidateIds.length > 0
        ? "QUALIFIED"
        : publicCandidates.some((candidate) => candidate.classification === "INSUFFICIENT_TIMING_EVIDENCE")
            ? "INSUFFICIENT_TIMING_EVIDENCE"
            : publicCandidates.some((candidate) => candidate.classification === "BUDGET_MISSED")
                ? "BUDGET_MISSED"
                : "NOT_QUALIFIED";
    const base = {
        schemaVersion: "1.0.0",
        sourceManifest: request.manifest,
        sourceArtifactDigest: request.manifest.artifactDigest,
        policy: request.policy,
        policyDigest: sha256Canonical(request.policy),
        status,
        candidates: publicCandidates,
        portfolios,
        qualifiedCandidateIds,
        limitations: [
            "Profile strength is limited to the declared worlds and recorded attempts.",
            "RECORDED_REFERENCE_WALL_TIME is local operational evidence, not a portable cold/warm benchmark.",
            "Observed consistency does not prove permanent absence of flakiness.",
        ],
    };
    return { ...base, reportDigest: sha256Canonical(base) };
}
export function replayAgenticProfile(value) {
    const invalid = {
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        policyDigestValid: false,
        reportDigestValid: false,
        semanticsValid: false,
    };
    let report;
    try {
        report = parseAgenticProfileReport(value);
    }
    catch {
        return invalid;
    }
    const sourceManifestValid = replayEvidenceManifest(report.sourceManifest).valid;
    const policyDigestValid = report.policyDigest === sha256Canonical(report.policy);
    const reportDigestValid = report.reportDigest === sha256Canonical(agenticReportProjection(report));
    let semanticsValid = false;
    try {
        semanticsValid =
            canonicalize(report) ===
                canonicalize(createAgenticProfile({
                    schemaVersion: "1.0.0",
                    manifest: report.sourceManifest,
                    policy: report.policy,
                }));
    }
    catch {
        semanticsValid = false;
    }
    return {
        valid: sourceManifestValid && policyDigestValid && reportDigestValid && semanticsValid,
        schemaValid: true,
        sourceManifestValid,
        policyDigestValid,
        reportDigestValid,
        semanticsValid,
    };
}
const EVIDENCE_EXPORT_COST_ASSUMPTIONS = [
    "One candidate-free control run per world and attempt precedes the candidate runs.",
    "Each run is one process execution bounded by the campaign timeout.",
];
export function createEvidenceProviderManifest(identity) {
    const base = {
        schemaVersion: "1.0.0",
        provider: {
            name: "assertledger",
            version: identity.version,
            sourceRevision: identity.sourceRevision,
        },
        scope: "Qualification of regression tests recorded in AssertLedger evidence manifest v1: candidate-free controls, reference, target, and neutral worlds, repeated attempts, deterministic gates, and replayable digests.",
        formats: {
            accepts: [
                {
                    schemaId: "https://testforge.dev/schemas/evidence-export-request.v1.json",
                    schemaVersion: "1.0.0",
                },
                {
                    schemaId: "https://testforge.dev/schemas/evidence-manifest.v1.json",
                    schemaVersion: "1.0.0",
                },
            ],
            emits: [
                {
                    schemaId: "https://testforge.dev/schemas/evidence-export.v1.json",
                    schemaVersion: "1.0.0",
                },
                {
                    schemaId: "https://testforge.dev/schemas/evidence-export-replay-result.v1.json",
                    schemaVersion: "1.0.0",
                },
            ],
        },
        capabilities: [
            {
                id: "CONTROL_WITHOUT_CANDIDATE",
                status: "SUPPORTED",
                modality: "TEST_OBSERVED",
                description: "Every world runs without a candidate first; controls must pass without candidate attribution.",
            },
            {
                id: "REFERENCE_PASS",
                status: "SUPPORTED",
                modality: "TEST_OBSERVED",
                description: "Candidates must pass every reference world.",
            },
            {
                id: "REGRESSION_DETECTION",
                status: "SUPPORTED",
                modality: "TEST_OBSERVED",
                description: "Only an attributed ASSERTION_FAILURE on a target world is detection; compilation, collection, crash, timeout, infrastructure, and no-test outcomes never are.",
            },
            {
                id: "NEUTRAL_PASS",
                status: "SUPPORTED",
                modality: "TEST_OBSERVED",
                description: "Candidates must pass every neutral world.",
            },
            {
                id: "STABILITY_REPETITION",
                status: "SUPPORTED",
                modality: "TEST_OBSERVED",
                description: "Normalized outcomes must agree across the recorded attempts.",
            },
            {
                id: "GIT_REVISION_PROVENANCE",
                status: "SUPPORTED_WHEN_RECORDED",
                modality: "RECORDED_METADATA",
                description: "Git commits and trees are exported only when committed Git regression qualification recorded them.",
            },
            {
                id: "EXECUTION_FRESHNESS",
                status: "UNSUPPORTED",
                modality: "NONE",
                description: "Evidence manifest v1 does not record whether observations were freshly executed or reused.",
            },
            {
                id: "PRODUCER_AUTHENTICATION",
                status: "UNSUPPORTED",
                modality: "NONE",
                description: "Exports are unsigned; digests check integrity, not producer identity.",
            },
            {
                id: "SANDBOXED_EXECUTION",
                status: "UNSUPPORTED",
                modality: "NONE",
                description: "trusted-local execution is explicitly UNSANDBOXED.",
            },
        ],
        adapters: identity.adapters,
        cost: {
            unit: "PROCESS_EXECUTIONS",
            estimate: "(candidates + 1) * worlds * requiredAttempts",
            assumptions: [
                ...EVIDENCE_EXPORT_COST_ASSUMPTIONS,
                "Wall time is observed per recorded run and is never estimated.",
            ],
        },
        limits: [
            "An announced capability does not prove that a control ran; only the recorded observations of an exported manifest do.",
            "Exports cover only the recorded worlds, candidates, and attempts and do not generalize to unexecuted states.",
            "Evidence is unauthenticated and trusted-local execution is unsandboxed.",
            "Consumers decide whether to admit, degrade, or ignore evidence; that decision never changes AssertLedger results.",
        ],
    };
    return parseEvidenceProviderManifest({ ...base, manifestDigest: sha256Canonical(base) });
}
function recordedGitRevision(provenance) {
    let value;
    try {
        value = JSON.parse(provenance);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || canonicalize(value) !== provenance)
        return null;
    if (Object.keys(value).sort(compareOrdinal).join(",") !==
        "commit,format,objectFormat,projection,reason,role,tree")
        return null;
    const { commit, format, objectFormat, projection, reason, role, tree } = value;
    const length = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
    const objectId = new RegExp(`^[a-f0-9]{${length}}$`);
    if (length === 0 ||
        format !== "assertledger-git-regression/1" ||
        (role !== "reference" && role !== "target" && role !== "neutral") ||
        typeof commit !== "string" ||
        !objectId.test(commit) ||
        typeof tree !== "string" ||
        !objectId.test(tree) ||
        typeof projection !== "string" ||
        typeof reason !== "string")
        return null;
    return { role, commit, tree, objectFormat: objectFormat };
}
function recordedFramework(manifest) {
    const configuration = manifest.evidenceContext.adapter.configuration;
    if (manifest.adapter.kind !== "node-test" ||
        !isRecord(configuration) ||
        configuration.kind !== "node-test" ||
        !isRecord(configuration.profile))
        return { status: "UNKNOWN" };
    const { profileId, profileVersion, official } = configuration.profile;
    const boundedText = (text) => typeof text === "string" && text.length > 0 && text.length <= 128;
    if (!boundedText(profileId) || !boundedText(profileVersion) || typeof official !== "boolean")
        return { status: "UNKNOWN" };
    return {
        status: "RECORDED",
        profileId,
        profileVersion,
        official,
        nodeVersion: boundedText(configuration.nodeVersion) ? configuration.nodeVersion : null,
        executableDigest: typeof configuration.executableDigest === "string" &&
            /^sha256:[a-f0-9]{64}$/.test(configuration.executableDigest)
            ? configuration.executableDigest
            : null,
    };
}
function exportedWorld(manifest, candidateId, world, detectionEstablished) {
    const runs = manifest.observations.filter((observation) => observation.candidateId === candidateId && observation.worldId === world.id);
    const complete = isComplete(runs, manifest.policy.requiredAttempts);
    const first = runs[0];
    const outcome = !complete || first === undefined
        ? "MISSING"
        : runs.every((run) => run.outcome === first.outcome)
            ? first.outcome
            : "DIVERGENT";
    const attributed = complete && runs.every((run) => run.attributed && run.candidateTestsDiscovered >= 1);
    const signal = attributed && outcome === "ASSERTION_FAILURE"
        ? "RED"
        : attributed && outcome === "PASS"
            ? "GREEN"
            : "NONE";
    const detection = world.kind !== "TARGET"
        ? "NOT_APPLICABLE"
        : !detectionEstablished
            ? "NOT_ESTABLISHED"
            : signal === "RED"
                ? "OBSERVED"
                : signal === "GREEN"
                    ? "NOT_OBSERVED"
                    : "NOT_ESTABLISHED";
    return {
        worldId: world.id,
        kind: world.kind,
        required: world.required,
        weight: world.weight,
        outcome,
        attempts: runs.length,
        signal,
        detection,
    };
}
export function createEvidenceExport(request) {
    request = parseEvidenceExportRequest(request);
    const manifest = request.manifest;
    if (!replayEvidenceManifest(manifest).valid) {
        throw new EvidenceValidationError("EVIDENCE_EXPORT_SOURCE_INVALID");
    }
    const worlds = [...manifest.worlds].sort((left, right) => compareOrdinal(left.id, right.id));
    const worldKinds = new Map(manifest.worlds.map((world) => [world.id, world.kind]));
    const controlsValid = manifest.decision.status !== "ENGINE_ERROR" &&
        !manifest.decision.reasonCodes.includes("CONTROL_EVIDENCE_INVALID");
    const selected = new Set(manifest.decision.selectedCandidateIds);
    const sortedCandidates = [...manifest.candidates].sort((left, right) => compareOrdinal(left.id, right.id));
    const candidates = sortedCandidates.map((candidate) => {
        // Detection is only meaningful once controls, discovery, reference, and neutral evidence held.
        const detectionEstablished = controlsValid && (candidate.status === "ELIGIBLE" || candidate.status === "WEAK_ORACLE");
        return {
            id: candidate.id,
            digest: candidate.digest,
            status: candidate.status,
            selected: selected.has(candidate.id),
            reasonCodes: [...candidate.reasonCodes],
            worlds: worlds.map((world) => exportedWorld(manifest, candidate.id, world, detectionEstablished)),
        };
    });
    const statuses = new Set(candidates.map((candidate) => candidate.status));
    const targetDetections = candidates.flatMap((candidate) => candidate.worlds.filter((world) => world.kind === "TARGET").map((world) => world.detection));
    const [detection, reasonCode] = manifest.decision.status === "VERIFIED"
        ? ["OBSERVED", "REGRESSION_ASSERTION_OBSERVED"]
        : manifest.decision.status === "ENGINE_ERROR"
            ? ["NOT_ESTABLISHED", "ENGINE_ERROR"]
            : !controlsValid
                ? ["NOT_ESTABLISHED", "CONTROL_EVIDENCE_INVALID"]
                : statuses.has("UNSTABLE") || statuses.has("INCONCLUSIVE")
                    ? ["NOT_ESTABLISHED", "CANDIDATE_EVIDENCE_INCONCLUSIVE"]
                    : statuses.has("INVALID")
                        ? ["NOT_ESTABLISHED", "CANDIDATE_EVIDENCE_INVALID"]
                        : targetDetections.includes("NOT_ESTABLISHED")
                            ? ["NOT_ESTABLISHED", "OPERATIONAL_OUTCOME_NOT_DETECTION"]
                            : targetDetections.includes("NOT_OBSERVED")
                                ? ["NOT_OBSERVED", "TARGET_PASSED_WITHOUT_DETECTION"]
                                : ["NOT_ESTABLISHED", "TARGET_STRENGTH_INSUFFICIENT"];
    const contextWorlds = new Map(manifest.evidenceContext.worlds.map((world) => [world.id, world]));
    const scopeWorlds = worlds.map((world) => {
        const context = contextWorlds.get(world.id);
        if (context === undefined)
            throw new EvidenceValidationError("EVIDENCE_EXPORT_SOURCE_INVALID");
        return {
            id: world.id,
            kind: world.kind,
            required: world.required,
            weight: world.weight,
            digest: context.digest,
            declaredProvenance: context.provenance,
            git: recordedGitRevision(context.provenance),
        };
    });
    const recordedGit = scopeWorlds.filter((world) => world.git !== null).length;
    const candidateRuns = manifest.observations.filter((observation) => observation.candidateId !== null);
    const candidateRunsIn = (kind) => candidateRuns.filter((observation) => worldKinds.get(observation.worldId) === kind).length;
    const executed = [
        ["CONTROL_WITHOUT_CANDIDATE", manifest.observations.length - candidateRuns.length],
        ["REFERENCE_PASS", candidateRunsIn("REFERENCE")],
        ["REGRESSION_DETECTION", candidateRunsIn("TARGET")],
        ["NEUTRAL_PASS", candidateRunsIn("NEUTRAL")],
        [
            "STABILITY_REPETITION",
            manifest.observations.filter((observation) => observation.attempt >= 2).length,
        ],
    ].map(([control, observations]) => ({
        control,
        status: observations > 0 ? "EXECUTED" : "NOT_EXECUTED",
        observations,
    }));
    const executedStatus = new Map(executed.map((control) => [control.control, control.status]));
    const consumerRequest = request.consumerRequest === null
        ? null
        : {
            reference: request.consumerRequest.reference,
            profileId: request.consumerRequest.profileId,
            obligations: [...request.consumerRequest.obligations]
                .sort((left, right) => compareOrdinal(left.id, right.id))
                .map(({ id, control }) => ({ id, control })),
        };
    let requested = { status: "NOT_SUPPLIED" };
    if (consumerRequest !== null) {
        // Only executable controls can be covered; anything else stays UNSUPPORTED, never inferred.
        const obligations = consumerRequest.obligations.map((obligation) => ({
            ...obligation,
            coverage: executedStatus.get(obligation.control) ?? "UNSUPPORTED",
        }));
        const covered = obligations.filter((obligation) => obligation.coverage === "EXECUTED").length;
        requested = {
            status: obligations.length === 0
                ? "NO_OBLIGATIONS"
                : covered === obligations.length
                    ? "COVERED"
                    : covered === 0
                        ? "NOT_COVERED"
                        : "PARTIAL",
            obligations,
        };
    }
    const timed = manifest.observations.filter((observation) => observation.durationMs !== undefined);
    const recordedWallTimeMs = timed.length === 0
        ? null
        : timed.reduce((total, observation) => total + (observation.durationMs ?? 0), 0);
    const base = {
        schemaVersion: "1.0.0",
        sourceManifest: manifest,
        sourceArtifactDigest: manifest.artifactDigest,
        consumerRequest,
        result: {
            detection,
            modality: detection === "NOT_ESTABLISHED" ? "NONE" : "TEST_OBSERVED",
            reasonCode,
            decision: {
                status: manifest.decision.status,
                selectedCandidateIds: [...manifest.decision.selectedCandidateIds],
                reasonCodes: [...manifest.decision.reasonCodes],
            },
            candidates,
        },
        integrity: {
            sourceReplay: "VALID",
            verifiedRails: ["SCHEMA", "DECISION_DIGEST", "ARTIFACT_DIGEST", "DECISION_SEMANTICS"],
            bindings: {
                artifactDigest: manifest.artifactDigest,
                decisionDigest: manifest.decisionDigest,
                repositoryDigest: manifest.repositoryDigest,
                policyDigest: sha256Canonical(manifest.policy),
                worldDigests: scopeWorlds.map((world) => ({ worldId: world.id, digest: world.digest })),
            },
        },
        authenticity: {
            status: "UNAUTHENTICATED",
            attestation: "NONE",
            declaredProducer: {
                name: manifest.evidenceContext.engine.name,
                version: manifest.evidenceContext.engine.version,
            },
        },
        environment: {
            isolation: { kind: manifest.isolation.kind, level: manifest.isolation.level },
            environmentAllowlist: [...manifest.evidenceContext.execution.environmentAllowlist],
            adapter: {
                kind: manifest.adapter.kind,
                name: manifest.evidenceContext.adapter.name,
                version: manifest.evidenceContext.adapter.version,
                framework: recordedFramework(manifest),
            },
        },
        confidence: {
            level: "REPLAY_CONSISTENT_UNAUTHENTICATED",
            established: [
                "SOURCE_SCHEMA_VALID",
                "DECISION_DIGEST_RECOMPUTED",
                "ARTIFACT_DIGEST_RECOMPUTED",
                "DECISION_RECOMPUTED_FROM_RECORDED_OBSERVATIONS",
            ],
            notEstablished: [
                "PRODUCER_AUTHENTICITY",
                "OBSERVATION_TRUTHFULNESS",
                "EXECUTION_ISOLATION",
                "EXECUTION_FRESHNESS",
                "WORLD_SEMANTIC_RELEVANCE",
            ],
        },
        scope: {
            requiredAttempts: manifest.policy.requiredAttempts,
            candidates: manifest.candidates.length,
            observations: manifest.observations.length,
            gitRevisions: recordedGit === 0
                ? "NOT_RECORDED"
                : recordedGit === scopeWorlds.length
                    ? "RECORDED"
                    : "PARTIAL",
            worlds: scopeWorlds,
        },
        controls: {
            executed,
            requested,
            omittedGates: sortedCandidates.flatMap((candidate) => candidate.gates
                .filter((gate) => gate.status === "NOT_RUN")
                .map((gate) => ({
                candidateId: candidate.id,
                gate: gate.name,
                reasonCodes: [...gate.reasonCodes],
            }))),
        },
        profile: consumerRequest?.profileId == null
            ? { status: "NOT_REQUESTED" }
            : { status: "UNKNOWN_PROFILE", requestedProfileId: consumerRequest.profileId },
        policy: {
            policyVersion: manifest.policy.policyVersion,
            digest: sha256Canonical(manifest.policy),
        },
        cost: {
            estimated: {
                unit: "PROCESS_EXECUTIONS",
                value: (manifest.candidates.length + 1) *
                    manifest.worlds.length *
                    manifest.policy.requiredAttempts,
                basis: "RECORDED_CAMPAIGN_SHAPE",
                assumptions: [...EVIDENCE_EXPORT_COST_ASSUMPTIONS],
            },
            observed: {
                unit: "PROCESS_EXECUTIONS",
                executions: manifest.observations.length,
                recordedWallTimeMs,
                wallTimeCoverage: timed.length === 0
                    ? "NOT_RECORDED"
                    : timed.length === manifest.observations.length
                        ? "COMPLETE"
                        : "PARTIAL",
            },
            execution: { freshness: "UNKNOWN", cache: "NOT_RECORDED" },
        },
        limitations: [
            "The export restates replay-valid recorded evidence; it does not rerun tests or authenticate the producer.",
            "Detection covers only the recorded target worlds and attempts.",
            "Consumers decide admissibility; rejecting or ignoring an export does not change AssertLedger results.",
        ],
    };
    return { ...base, exportDigest: sha256Canonical(base) };
}
function evidenceExportProjection(value) {
    const { exportDigest: _exportDigest, ...projection } = value;
    return projection;
}
export function replayEvidenceExport(value) {
    const invalid = {
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        exportDigestValid: false,
        semanticsValid: false,
    };
    let evidenceExport;
    try {
        evidenceExport = parseEvidenceExport(value);
    }
    catch {
        return invalid;
    }
    const sourceManifestValid = replayEvidenceManifest(evidenceExport.sourceManifest).valid;
    const exportDigestValid = evidenceExport.exportDigest === sha256Canonical(evidenceExportProjection(evidenceExport));
    let semanticsValid = false;
    try {
        semanticsValid =
            canonicalize(evidenceExport) ===
                canonicalize(createEvidenceExport({
                    schemaVersion: "1.0.0",
                    manifest: evidenceExport.sourceManifest,
                    consumerRequest: evidenceExport.consumerRequest,
                }));
    }
    catch {
        semanticsValid = false;
    }
    return {
        valid: sourceManifestValid && exportDigestValid && semanticsValid,
        schemaValid: true,
        sourceManifestValid,
        exportDigestValid,
        semanticsValid,
    };
}
const BENCHMARK_PHASES = ["PREPARATION", "STARTUP", "COMPILE_OR_COLLECTION", "EXECUTION"];
function benchmarkSourceBindingValid(request) {
    if (request.sourceManifest.decision.status !== "VERIFIED")
        return false;
    const referenceWorld = request.sourceManifest.worlds.find((world) => world.id === request.referenceWorldId);
    if (referenceWorld?.kind !== "REFERENCE" || !referenceWorld.required)
        return false;
    const contextWorld = request.sourceManifest.evidenceContext.worlds.find((world) => world.id === request.referenceWorldId);
    if (contextWorld === undefined)
        return false;
    return request.sourceManifest.decision.selectedCandidateIds.every((id) => {
        const candidate = request.sourceManifest.candidates.find((item) => item.id === id);
        return candidate?.status === "ELIGIBLE";
    });
}
function benchmarkComparisonScopeProjection(request) {
    const referenceWorld = request.sourceManifest.evidenceContext.worlds.find((world) => world.id === request.referenceWorldId);
    if (referenceWorld === undefined) {
        throw new EvidenceValidationError("AGENTIC_BENCHMARK_REFERENCE_WORLD_INVALID");
    }
    return {
        environmentId: request.fingerprint.environmentId,
        fingerprintDigest: sha256Canonical(request.fingerprint),
        protocolDigest: sha256Canonical(request.protocol),
        sourceDecisionDigest: request.sourceManifest.decisionDigest,
        referenceWorldId: request.referenceWorldId,
        referenceWorldDigest: referenceWorld.digest,
    };
}
function compareBenchmarkRuns(left, right) {
    const candidateOrder = compareOrdinal(left.candidateId, right.candidateId);
    if (candidateOrder !== 0)
        return candidateOrder;
    const regimeOrder = (left.regime === "COLD" ? 0 : 1) - (right.regime === "COLD" ? 0 : 1);
    if (regimeOrder !== 0)
        return regimeOrder;
    const roleOrder = (left.role === "WARMUP" ? 0 : 1) - (right.role === "WARMUP" ? 0 : 1);
    return roleOrder !== 0 ? roleOrder : left.ordinal - right.ordinal;
}
function benchmarkQuantiles(values) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((left, right) => left - right);
    return {
        minimumUs: sorted[0],
        p50Us: nearestRank(sorted, 0.5),
        p95Us: nearestRank(sorted, 0.95),
        maximumUs: sorted.at(-1),
    };
}
function benchmarkSummaries(request) {
    const selected = request.sourceManifest.decision.selectedCandidateIds
        .map((id) => request.sourceManifest.candidates.find((candidate) => candidate.id === id))
        .filter((candidate) => candidate !== undefined)
        .sort((left, right) => compareOrdinal(left.id, right.id));
    return selected.flatMap((candidate) => ["COLD", "WARM"].map((regime) => {
        const runs = request.runs.filter((run) => run.candidateId === candidate.id && run.regime === regime);
        const measurements = runs.filter((run) => run.role === "MEASUREMENT");
        const accepted = measurements.filter((run) => run.status === "COMPLETE");
        const failed = runs.filter((run) => run.status === "INCOMPLETE").length;
        const planned = regime === "COLD" ? request.policy.coldMeasuredSamples : request.policy.warmMeasuredSamples;
        const status = failed > 0
            ? "OBSERVED_RUN_FAILURE"
            : accepted.length < request.policy.minimumMeasuredSamplesPerRegime
                ? "INSUFFICIENT_SAMPLES"
                : "MEASURED";
        const cpuValues = accepted.flatMap((run) => run.cpuTimeUs === undefined ? [] : [run.cpuTimeUs]);
        const cpuAvailability = cpuValues.length === 0
            ? "UNAVAILABLE"
            : cpuValues.length === accepted.length
                ? "COMPLETE"
                : "PARTIAL";
        const phaseValues = Object.fromEntries(BENCHMARK_PHASES.map((phase) => [
            phase,
            benchmarkQuantiles(accepted.map((run) => run.phases.find((timing) => timing.phase === phase)?.durationUs)),
        ]));
        return {
            candidateId: candidate.id,
            candidateDigest: candidate.digest,
            regime,
            status,
            counters: {
                planned,
                recorded: measurements.length,
                accepted: accepted.length,
                failed,
                warmup: runs.filter((run) => run.role === "WARMUP").length,
            },
            wall: {
                total: benchmarkQuantiles(accepted.map((run) => run.totalUs)),
                phases: {
                    PREPARATION: phaseValues.PREPARATION,
                    STARTUP: phaseValues.STARTUP,
                    COMPILE_OR_COLLECTION: phaseValues.COMPILE_OR_COLLECTION,
                    EXECUTION: phaseValues.EXECUTION,
                },
            },
            cpu: {
                availability: cpuAvailability,
                quantiles: cpuAvailability === "COMPLETE" ? benchmarkQuantiles(cpuValues) : null,
            },
        };
    }));
}
function benchmarkArtifactProjection(artifact) {
    const { artifactDigest: _artifactDigest, ...projection } = artifact;
    return projection;
}
export function createAgenticBenchmark(request) {
    request = parseAgenticBenchmarkRequest(request);
    if (!replayEvidenceManifest(request.sourceManifest).valid) {
        throw new EvidenceValidationError("AGENTIC_BENCHMARK_SOURCE_INVALID");
    }
    if (!benchmarkSourceBindingValid(request)) {
        throw new EvidenceValidationError("AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID");
    }
    const runs = [...request.runs].sort(compareBenchmarkRuns);
    const normalizedRequest = { ...request, runs };
    const base = {
        schemaVersion: "1.0.0",
        sourceManifest: request.sourceManifest,
        sourceArtifactDigest: request.sourceManifest.artifactDigest,
        sourceDecisionDigest: request.sourceManifest.decisionDigest,
        referenceWorldId: request.referenceWorldId,
        policy: request.policy,
        protocol: request.protocol,
        fingerprint: request.fingerprint,
        policyDigest: sha256Canonical(request.policy),
        protocolDigest: sha256Canonical(request.protocol),
        fingerprintDigest: sha256Canonical(request.fingerprint),
        comparisonScopeDigest: sha256Canonical(benchmarkComparisonScopeProjection(request)),
        runs,
        summaries: benchmarkSummaries(normalizedRequest),
        limitations: [
            "UNSANDBOXED measurements are trusted-local operational evidence.",
            "Benchmark comparisons are valid only within the declared comparison scope.",
            "Observed timings do not alter the source TestForge VERIFIED decision.",
        ],
    };
    return { ...base, artifactDigest: sha256Canonical(base) };
}
export function replayAgenticBenchmark(value) {
    const invalid = {
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        sourceBindingValid: false,
        policyDigestValid: false,
        protocolDigestValid: false,
        fingerprintDigestValid: false,
        comparisonScopeDigestValid: false,
        artifactDigestValid: false,
        summarySemanticsValid: false,
    };
    let artifact;
    try {
        artifact = parseAgenticBenchmarkArtifact(value);
    }
    catch {
        return invalid;
    }
    const request = {
        schemaVersion: artifact.schemaVersion,
        sourceManifest: artifact.sourceManifest,
        referenceWorldId: artifact.referenceWorldId,
        policy: artifact.policy,
        protocol: artifact.protocol,
        fingerprint: artifact.fingerprint,
        runs: artifact.runs,
    };
    const sourceManifestValid = replayEvidenceManifest(artifact.sourceManifest).valid;
    const sourceBindingValid = benchmarkSourceBindingValid(request) &&
        artifact.sourceArtifactDigest === artifact.sourceManifest.artifactDigest &&
        artifact.sourceDecisionDigest === artifact.sourceManifest.decisionDigest;
    const policyDigestValid = artifact.policyDigest === sha256Canonical(artifact.policy);
    const protocolDigestValid = artifact.protocolDigest === sha256Canonical(artifact.protocol);
    const fingerprintDigestValid = artifact.fingerprintDigest === sha256Canonical(artifact.fingerprint);
    let comparisonScopeDigestValid = false;
    try {
        comparisonScopeDigestValid =
            artifact.comparisonScopeDigest ===
                sha256Canonical(benchmarkComparisonScopeProjection(request));
    }
    catch {
        comparisonScopeDigestValid = false;
    }
    const artifactDigestValid = artifact.artifactDigest === sha256Canonical(benchmarkArtifactProjection(artifact));
    let summarySemanticsValid = false;
    try {
        const expected = createAgenticBenchmark(request);
        summarySemanticsValid =
            canonicalize(artifact.runs) === canonicalize(expected.runs) &&
                canonicalize(artifact.summaries) === canonicalize(expected.summaries) &&
                canonicalize(artifact.limitations) === canonicalize(expected.limitations);
    }
    catch {
        summarySemanticsValid = false;
    }
    return {
        valid: sourceManifestValid &&
            sourceBindingValid &&
            policyDigestValid &&
            protocolDigestValid &&
            fingerprintDigestValid &&
            comparisonScopeDigestValid &&
            artifactDigestValid &&
            summarySemanticsValid,
        schemaValid: true,
        sourceManifestValid,
        sourceBindingValid,
        policyDigestValid,
        protocolDigestValid,
        fingerprintDigestValid,
        comparisonScopeDigestValid,
        artifactDigestValid,
        summarySemanticsValid,
    };
}
export function replayAgenticBenchmarkAcquisition(value) {
    const invalid = {
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        sourceBindingValid: false,
        artifactReplayValid: false,
        contextBindingValid: false,
        resultDigestValid: false,
        statusSemanticsValid: false,
    };
    let result;
    try {
        result = parseAgenticBenchmarkAcquisitionResult(value);
    }
    catch {
        return invalid;
    }
    const sourceReplay = replayEvidenceManifest(result.sourceManifest);
    const sourceManifestValid = sourceReplay.valid;
    const artifactReplayValid = result.benchmarkArtifact === null
        ? result.status === "SOURCE_NOT_VERIFIED"
        : replayAgenticBenchmark(result.benchmarkArtifact).valid;
    const sourceBindingValid = result.benchmarkArtifact === null
        ? result.status === "SOURCE_NOT_VERIFIED"
        : canonicalize(result.benchmarkArtifact.sourceManifest) ===
            canonicalize(result.sourceManifest) &&
            result.benchmarkArtifact.sourceArtifactDigest === result.sourceManifest.artifactDigest &&
            result.benchmarkArtifact.sourceDecisionDigest === result.sourceManifest.decisionDigest;
    const adapterConfiguration = result.sourceManifest.evidenceContext.adapter.configuration;
    const phaseAdapter = result.benchmarkArtifact?.fingerprint.tools.find((tool) => tool.role === "phase-adapter");
    let contextBindingValid = false;
    try {
        contextBindingValid =
            result.acquisitionContext.snapshotRepositoryDigest ===
                result.sourceManifest.repositoryDigest &&
                result.sourceManifest.worlds.some((world) => world.id === result.acquisitionContext.referenceWorldId &&
                    world.kind === "REFERENCE" &&
                    world.required) &&
                result.acquisitionContext.dependencyGraphDigest ===
                    sha256Canonical(result.acquisitionContext.dependencyFiles) &&
                isRecord(adapterConfiguration) &&
                adapterConfiguration.kind === "testforge-command" &&
                adapterConfiguration.executable === result.acquisitionContext.adapter.executable &&
                canonicalize(adapterConfiguration.arguments) ===
                    canonicalize(result.acquisitionContext.adapter.arguments) &&
                (result.benchmarkArtifact === null
                    ? false
                    : result.acquisitionContext.referenceWorldId ===
                        result.benchmarkArtifact.referenceWorldId &&
                        canonicalize(result.acquisitionContext.candidateIds) ===
                            canonicalize(result.sourceManifest.decision.selectedCandidateIds) &&
                        result.acquisitionContext.dependencyGraphDigest ===
                            result.benchmarkArtifact.fingerprint.dependencyGraphDigest &&
                        result.acquisitionContext.adapter.identityDigest ===
                            result.benchmarkArtifact.fingerprint.phaseReporterDigest &&
                        phaseAdapter !== undefined &&
                        phaseAdapter.digest === result.acquisitionContext.adapter.executableDigest &&
                        phaseAdapter.configurationDigest ===
                            sha256Canonical({
                                arguments: result.acquisitionContext.adapter.arguments,
                                identityFilePath: result.acquisitionContext.adapter.identityFilePath,
                                identityDigest: result.acquisitionContext.adapter.identityDigest,
                            }));
    }
    catch {
        contextBindingValid = false;
    }
    const { resultDigest: _resultDigest, ...projection } = result;
    const resultDigestValid = result.resultDigest === sha256Canonical(projection);
    let expectedStatus;
    if (sourceManifestValid && result.sourceManifest.decision.status !== "VERIFIED") {
        expectedStatus = "SOURCE_NOT_VERIFIED";
    }
    else if (sourceManifestValid && result.benchmarkArtifact !== null) {
        const statuses = result.benchmarkArtifact.summaries.map((summary) => summary.status);
        expectedStatus = statuses.some((status) => status === "OBSERVED_RUN_FAILURE")
            ? "OBSERVED_RUN_FAILURE"
            : statuses.some((status) => status === "INSUFFICIENT_SAMPLES")
                ? "INSUFFICIENT_SAMPLES"
                : "COMPLETE";
    }
    const expectedReasonCodes = expectedStatus === undefined
        ? undefined
        : [expectedStatus === "COMPLETE" ? "ACQUISITION_COMPLETE" : expectedStatus];
    const statusSemanticsValid = expectedStatus !== undefined &&
        expectedReasonCodes !== undefined &&
        expectedStatus === result.status &&
        canonicalize(result.reasonCodes) === canonicalize(expectedReasonCodes) &&
        (expectedStatus === "SOURCE_NOT_VERIFIED"
            ? result.benchmarkArtifact === null
            : result.benchmarkArtifact !== null);
    return {
        valid: sourceManifestValid &&
            sourceBindingValid &&
            artifactReplayValid &&
            contextBindingValid &&
            resultDigestValid &&
            statusSemanticsValid,
        schemaValid: true,
        sourceManifestValid,
        sourceBindingValid,
        artifactReplayValid,
        contextBindingValid,
        resultDigestValid,
        statusSemanticsValid,
    };
}
function agenticReportV2Projection(report) {
    const { reportDigest: _reportDigest, ...projection } = report;
    return projection;
}
function profileV2CandidateClassification(scopeMatches, benchmarkStatus, p95Us, request) {
    if (!scopeMatches)
        return "COMPARISON_SCOPE_MISMATCH";
    if (benchmarkStatus === "OBSERVED_RUN_FAILURE")
        return "OBSERVED_BENCHMARK_FAILURE";
    if (benchmarkStatus === "INSUFFICIENT_SAMPLES" || p95Us === null) {
        return "INSUFFICIENT_TIMING_EVIDENCE";
    }
    return request.policy.lanes.some((lane) => p95Us <= lane.maximumWarmTotalWallP95Us)
        ? "QUALIFIED"
        : "BUDGET_MISSED";
}
export function createAgenticProfileV2(request) {
    request = parseAgenticProfileRequestV2(request);
    const benchmarkReplay = replayAgenticBenchmark(request.benchmarkArtifact);
    if (!benchmarkReplay.valid) {
        throw new EvidenceValidationError("AGENTIC_PROFILE_V2_BENCHMARK_INVALID");
    }
    const benchmark = request.benchmarkArtifact;
    const manifest = benchmark.sourceManifest;
    const selectedIds = [...manifest.decision.selectedCandidateIds].sort(compareOrdinal);
    const selectedSet = new Set(selectedIds);
    const excludedEligibleCandidateIds = manifest.candidates
        .filter((candidate) => candidate.status === "ELIGIBLE" && !selectedSet.has(candidate.id))
        .map((candidate) => candidate.id)
        .sort(compareOrdinal);
    const targetWorlds = manifest.worlds.filter((world) => world.kind === "TARGET");
    const targetWeights = new Map(targetWorlds.map((world) => [world.id, world.weight]));
    const totalTargetWeight = targetWorlds.reduce((total, world) => total + world.weight, 0);
    const requiredTargetIds = new Set(targetWorlds.filter((world) => world.required).map((world) => world.id));
    const scopeMatches = request.policy.requiredComparisonScopeDigest === benchmark.comparisonScopeDigest;
    const warmSummaries = new Map(benchmark.summaries
        .filter((summary) => summary.regime === "WARM")
        .map((summary) => [summary.candidateId, summary]));
    const candidates = selectedIds.map((id) => {
        const source = manifest.candidates.find((candidate) => candidate.id === id);
        const summary = warmSummaries.get(id);
        if (source === undefined || source.status !== "ELIGIBLE" || summary === undefined) {
            throw new EvidenceValidationError("AGENTIC_PROFILE_V2_COHORT_INVALID");
        }
        const p95Us = summary.status === "MEASURED" ? (summary.wall.total?.p95Us ?? null) : null;
        return {
            id,
            candidateDigest: source.digest,
            evidenceStatus: "ELIGIBLE",
            classification: profileV2CandidateClassification(scopeMatches, summary.status, p95Us, request),
            status: summary.status,
            reasonCodes: [...source.reasonCodes],
            strength: {
                targetWeightKilled: source.targetWeightKilled,
                totalTargetWeight,
                targetWeightPermille: totalTargetWeight === 0
                    ? 0
                    : Math.floor((source.targetWeightKilled * 1_000) / totalTargetWeight),
                requiredTargetsKilled: source.killedTargetIds.filter((targetId) => requiredTargetIds.has(targetId)).length,
                requiredTargetsTotal: requiredTargetIds.size,
                killedTargetIds: [...source.killedTargetIds].sort(compareOrdinal),
            },
            consistency: {
                claim: source.gates.find((gate) => gate.name === "STABILITY")?.status === "PASSED"
                    ? "OBSERVED_CONSISTENT"
                    : "OBSERVED_INCONSISTENT",
                attempts: manifest.policy.requiredAttempts,
            },
            cost: {
                kind: "BENCHMARK_WARM_TOTAL_WALL_P95",
                acceptedSamples: summary.counters.accepted,
                p95Us,
            },
            paretoStatus: "NOT_EVALUATED",
            sizeBytes: source.sizeBytes,
        };
    });
    const anyWarmFailure = candidates.some((candidate) => candidate.status === "OBSERVED_RUN_FAILURE");
    const anyWarmInsufficient = candidates.some((candidate) => candidate.status === "INSUFFICIENT_SAMPLES" || candidate.cost.p95Us === null);
    const cohortEvaluable = scopeMatches && !anyWarmFailure && !anyWarmInsufficient;
    if (cohortEvaluable) {
        for (const candidate of candidates) {
            const candidateCost = candidate.cost.p95Us;
            candidate.paretoStatus = candidates.some((other) => {
                if (other.id === candidate.id || other.cost.p95Us === null)
                    return false;
                return (other.strength.targetWeightKilled >= candidate.strength.targetWeightKilled &&
                    other.strength.requiredTargetsKilled >= candidate.strength.requiredTargetsKilled &&
                    other.cost.p95Us <= candidateCost &&
                    (other.strength.targetWeightKilled > candidate.strength.targetWeightKilled ||
                        other.strength.requiredTargetsKilled > candidate.strength.requiredTargetsKilled ||
                        other.cost.p95Us < candidateCost));
            })
                ? "DOMINATED"
                : "ON_FRONTIER";
        }
    }
    const portfolios = cohortEvaluable
        ? request.policy.lanes.map((lane) => {
            const selectedCandidateIds = [];
            const selectedTargets = new Set();
            const steps = [];
            let cumulativeCostUs = 0;
            let cumulativeTargetWeight = 0;
            while (true) {
                const choices = candidates
                    .filter((candidate) => !selectedCandidateIds.includes(candidate.id) &&
                    candidate.cost.p95Us !== null &&
                    candidate.cost.p95Us <= lane.maximumWarmTotalWallP95Us - cumulativeCostUs)
                    .map((candidate) => {
                    const marginalTargetIds = candidate.strength.killedTargetIds.filter((targetId) => !selectedTargets.has(targetId));
                    return {
                        candidate,
                        marginalTargetIds,
                        marginalTargetWeight: marginalTargetIds.reduce((weight, targetId) => weight + (targetWeights.get(targetId) ?? 0), 0),
                    };
                })
                    .filter((choice) => choice.marginalTargetWeight > 0)
                    .sort((left, right) => {
                    const leftCost = left.candidate.cost.p95Us;
                    const rightCost = right.candidate.cost.p95Us;
                    if (leftCost === 0 || rightCost === 0) {
                        if (leftCost === 0 && rightCost !== 0)
                            return -1;
                        if (rightCost === 0 && leftCost !== 0)
                            return 1;
                    }
                    else {
                        const leftRatio = BigInt(left.marginalTargetWeight) * BigInt(rightCost);
                        const rightRatio = BigInt(right.marginalTargetWeight) * BigInt(leftCost);
                        if (leftRatio !== rightRatio)
                            return leftRatio > rightRatio ? -1 : 1;
                    }
                    if (left.marginalTargetWeight !== right.marginalTargetWeight) {
                        return right.marginalTargetWeight - left.marginalTargetWeight;
                    }
                    if (leftCost !== rightCost)
                        return leftCost - rightCost;
                    if (left.candidate.sizeBytes !== right.candidate.sizeBytes) {
                        return left.candidate.sizeBytes - right.candidate.sizeBytes;
                    }
                    const digestOrder = compareOrdinal(left.candidate.candidateDigest, right.candidate.candidateDigest);
                    return digestOrder !== 0
                        ? digestOrder
                        : compareOrdinal(left.candidate.id, right.candidate.id);
                });
                const choice = choices[0];
                if (choice === undefined)
                    break;
                const choiceCost = choice.candidate.cost.p95Us;
                selectedCandidateIds.push(choice.candidate.id);
                cumulativeCostUs += choiceCost;
                cumulativeTargetWeight += choice.marginalTargetWeight;
                for (const targetId of choice.marginalTargetIds)
                    selectedTargets.add(targetId);
                steps.push({
                    ordinal: steps.length + 1,
                    candidateId: choice.candidate.id,
                    marginalTargetIds: [...choice.marginalTargetIds].sort(compareOrdinal),
                    marginalTargetWeight: choice.marginalTargetWeight,
                    candidateWarmTotalWallP95Us: choiceCost,
                    cumulativeCostUs,
                    cumulativeTargetWeight,
                });
            }
            return {
                laneId: lane.id,
                maximumWarmTotalWallP95Us: lane.maximumWarmTotalWallP95Us,
                costModel: "SUM_OF_INDIVIDUAL_P95",
                selectedCandidateIds,
                steps,
                sumIndividualWarmTotalWallP95Us: cumulativeCostUs,
                targetWeight: cumulativeTargetWeight,
                targetWeightPermille: totalTargetWeight === 0
                    ? 0
                    : Math.floor((cumulativeTargetWeight * 1_000) / totalTargetWeight),
                requiredTargetsKilled: [...selectedTargets].filter((id) => requiredTargetIds.has(id))
                    .length,
                requiredTargetsTotal: requiredTargetIds.size,
            };
        })
        : [];
    const status = !scopeMatches
        ? "COMPARISON_SCOPE_MISMATCH"
        : anyWarmFailure
            ? "OBSERVED_BENCHMARK_FAILURE"
            : anyWarmInsufficient
                ? "INSUFFICIENT_TIMING_EVIDENCE"
                : portfolios.some((portfolio) => portfolio.selectedCandidateIds.length > 0)
                    ? "QUALIFIED"
                    : "BUDGET_MISSED";
    const publicCandidates = candidates.map(({ sizeBytes: _sizeBytes, ...candidate }) => candidate);
    const base = {
        schemaVersion: "2.0.0",
        benchmarkArtifact: benchmark,
        sourceBenchmarkArtifactDigest: benchmark.artifactDigest,
        comparisonScopeDigest: benchmark.comparisonScopeDigest,
        policy: request.policy,
        policyDigest: sha256Canonical(request.policy),
        status,
        candidateUniverse: {
            kind: "SOURCE_SELECTED_ELIGIBLE",
            candidateIds: selectedIds,
            excludedEligibleCandidateIds,
        },
        candidates: publicCandidates,
        portfolios,
        limitations: [
            "The optimized universe is limited to source-selected eligible candidates benchmarked by the source artifact.",
            "Portfolio cost is the sum of individual warm total wall p95 values, not a measured portfolio p95.",
            "The profile does not alter the source TestForge VERIFIED decision.",
        ],
    };
    return { ...base, reportDigest: sha256Canonical(base) };
}
export function replayAgenticProfileV2(value) {
    const invalid = {
        valid: false,
        schemaValid: false,
        sourceBenchmarkValid: false,
        sourceBindingValid: false,
        policyDigestValid: false,
        reportDigestValid: false,
        semanticsValid: false,
    };
    let report;
    try {
        report = parseAgenticProfileReportV2(value);
    }
    catch {
        return invalid;
    }
    const sourceBenchmarkValid = replayAgenticBenchmark(report.benchmarkArtifact).valid;
    const sourceBindingValid = report.sourceBenchmarkArtifactDigest === report.benchmarkArtifact.artifactDigest &&
        report.comparisonScopeDigest === report.benchmarkArtifact.comparisonScopeDigest;
    const policyDigestValid = report.policyDigest === sha256Canonical(report.policy);
    const reportDigestValid = report.reportDigest === sha256Canonical(agenticReportV2Projection(report));
    let semanticsValid = false;
    try {
        semanticsValid =
            canonicalize(report) ===
                canonicalize(createAgenticProfileV2({
                    schemaVersion: "2.0.0",
                    benchmarkArtifact: report.benchmarkArtifact,
                    policy: report.policy,
                }));
    }
    catch {
        semanticsValid = false;
    }
    return {
        valid: sourceBenchmarkValid &&
            sourceBindingValid &&
            policyDigestValid &&
            reportDigestValid &&
            semanticsValid,
        schemaValid: true,
        sourceBenchmarkValid,
        sourceBindingValid,
        policyDigestValid,
        reportDigestValid,
        semanticsValid,
    };
}
export const AGENTIC_CORPUS_ALLOCATION_ALGORITHM = "SHA256_ASCENDING_SPLIT_V1";
const AGENTIC_CORPUS_ALLOCATION_DOMAIN = "TESTFORGE_CORPUS_ALLOCATION_V1";
function corpusAllocationProjection(allocation) {
    const { allocationDigest: _allocationDigest, ...projection } = allocation;
    return projection;
}
export function agenticCorpusAllocationDigest(allocation) {
    return sha256Canonical(corpusAllocationProjection(allocation));
}
function corpusAllocationScore(seedDigest, caseId) {
    return `sha256:${sha256(`${AGENTIC_CORPUS_ALLOCATION_DOMAIN}\0${seedDigest}\0${caseId}`)}`;
}
export function createAgenticCorpusAllocation(request) {
    const parsed = parseAgenticCorpusAllocationRequest(request);
    const requestedStrata = [...parsed.strata].sort((left, right) => compareOrdinal(left.sourceId, right.sourceId) ||
        compareOrdinal(left.sourceIdentityDigest, right.sourceIdentityDigest));
    const scoredStrata = requestedStrata.map((stratum) => {
        const scored = [...stratum.caseIds]
            .map((caseId) => ({
            caseId,
            sourceId: stratum.sourceId,
            sourceIdentityDigest: stratum.sourceIdentityDigest,
            scoreDigest: corpusAllocationScore(parsed.seedDigest, caseId),
        }))
            .sort((left, right) => compareOrdinal(left.scoreDigest, right.scoreDigest) ||
            compareOrdinal(left.caseId, right.caseId));
        return {
            sourceId: stratum.sourceId,
            sourceIdentityDigest: stratum.sourceIdentityDigest,
            calibrationCount: stratum.calibrationCount,
            sourceCaseIds: [...stratum.caseIds].sort(compareOrdinal),
            calibrationCaseIds: scored.slice(0, stratum.calibrationCount).map(({ caseId }) => caseId),
            holdoutCaseIds: scored.slice(stratum.calibrationCount).map(({ caseId }) => caseId),
            scored,
        };
    });
    const calibrationSet = new Set(scoredStrata.flatMap((stratum) => stratum.calibrationCaseIds));
    const assignments = scoredStrata
        .flatMap((stratum) => stratum.scored)
        .sort((left, right) => compareOrdinal(left.scoreDigest, right.scoreDigest) ||
        compareOrdinal(left.caseId, right.caseId))
        .map((item) => ({
        ...item,
        partition: calibrationSet.has(item.caseId) ? "CALIBRATION" : "HOLDOUT",
    }));
    const sourceCaseIds = assignments.map(({ caseId }) => caseId).sort(compareOrdinal);
    const calibrationCaseIds = assignments
        .filter((item) => item.partition === "CALIBRATION")
        .map(({ caseId }) => caseId);
    const holdoutCaseIds = assignments
        .filter((item) => item.partition === "HOLDOUT")
        .map(({ caseId }) => caseId);
    const calibrationCount = scoredStrata.reduce((total, stratum) => total + stratum.calibrationCount, 0);
    const projection = {
        schemaVersion: "1.0.0",
        allocationId: parsed.allocationId,
        algorithm: AGENTIC_CORPUS_ALLOCATION_ALGORITHM,
        seedDigest: parsed.seedDigest,
        calibrationCount,
        sourceCaseIds,
        strata: scoredStrata.map(({ scored: _scored, ...stratum }) => stratum),
        calibrationCaseIds,
        holdoutCaseIds,
        assignments,
    };
    return parseAgenticCorpusAllocation({
        ...projection,
        allocationDigest: agenticCorpusAllocationDigest(projection),
    });
}
export function replayAgenticCorpusAllocation(allocation) {
    const invalid = {
        valid: false,
        schemaValid: false,
        allocationDigestValid: false,
        sourceCaseIdsValid: false,
        assignmentScoresValid: false,
        partitionSemanticsValid: false,
    };
    let parsed;
    try {
        parsed = parseAgenticCorpusAllocation(allocation);
    }
    catch {
        return invalid;
    }
    const expected = createAgenticCorpusAllocation({
        schemaVersion: parsed.schemaVersion,
        allocationId: parsed.allocationId,
        seedDigest: parsed.seedDigest,
        strata: parsed.strata.map((stratum) => ({
            sourceId: stratum.sourceId,
            sourceIdentityDigest: stratum.sourceIdentityDigest,
            calibrationCount: stratum.calibrationCount,
            caseIds: stratum.sourceCaseIds,
        })),
    });
    const allocationDigestValid = parsed.allocationDigest === agenticCorpusAllocationDigest(parsed);
    const sourceCaseIdsValid = canonicalize(parsed.sourceCaseIds) === canonicalize(expected.sourceCaseIds);
    const assignmentScoresValid = canonicalize(parsed.assignments.map(({ caseId, sourceId, sourceIdentityDigest, scoreDigest }) => ({
        caseId,
        sourceId,
        sourceIdentityDigest,
        scoreDigest,
    }))) ===
        canonicalize(expected.assignments.map(({ caseId, sourceId, sourceIdentityDigest, scoreDigest }) => ({
            caseId,
            sourceId,
            sourceIdentityDigest,
            scoreDigest,
        })));
    const partitionSemanticsValid = canonicalize(parsed.strata) === canonicalize(expected.strata) &&
        canonicalize(parsed.calibrationCaseIds) === canonicalize(expected.calibrationCaseIds) &&
        canonicalize(parsed.holdoutCaseIds) === canonicalize(expected.holdoutCaseIds) &&
        canonicalize(parsed.assignments.map(({ caseId, partition }) => ({ caseId, partition }))) ===
            canonicalize(expected.assignments.map(({ caseId, partition }) => ({ caseId, partition })));
    return {
        valid: allocationDigestValid &&
            sourceCaseIdsValid &&
            assignmentScoresValid &&
            partitionSemanticsValid,
        schemaValid: true,
        allocationDigestValid,
        sourceCaseIdsValid,
        assignmentScoresValid,
        partitionSemanticsValid,
    };
}
const AGENTIC_CORPUS_EXPERIMENT_PAYLOAD_SCHEMA_ID = "https://testforge.dev/payloads/agentic-corpus-experiment-h3.v1.json";
const ALLOCATION_SHARE_DOMAIN = "TESTFORGE_CORPUS_ALLOCATION_SHARE_V1";
const ALLOCATION_SEED_DOMAIN = "TESTFORGE_CORPUS_ALLOCATION_FINAL_SEED_V1";
function digestBytes(bytes) {
    return `sha256:${sha256(bytes)}`;
}
function concatenateBytes(parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}
function lengthPrefix(bytes) {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, bytes.length, false);
    return concatenateBytes([prefix, bytes]);
}
function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/u.test(value))
        return null;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const output = [];
    let buffer = 0;
    let bits = 0;
    for (const character of value) {
        const index = alphabet.indexOf(character);
        if (index < 0)
            return null;
        buffer = buffer * 64 + index;
        bits += 6;
        while (bits >= 8) {
            bits -= 8;
            output.push(Math.floor(buffer / 2 ** bits) & 0xff);
            buffer %= 2 ** bits;
        }
    }
    if (bits > 0 && buffer !== 0)
        return null;
    return new Uint8Array(output);
}
function allocationCommitmentSigningProjection(commitment) {
    return {
        schemaVersion: commitment.schemaVersion,
        commitmentVersion: commitment.commitmentVersion,
        commitmentId: commitment.commitmentId,
        allocationId: commitment.allocationId,
        trustPolicyDigest: commitment.trustPolicyDigest,
        caseSet: commitment.caseSet,
        strata: commitment.strata,
        signers: commitment.signers.map(({ signature: _signature, ...signer }) => signer),
    };
}
export function agenticCorpusAllocationCommitmentSigningBytes(commitment) {
    return new TextEncoder().encode(canonicalize(allocationCommitmentSigningProjection(commitment)));
}
export function agenticCorpusAllocationCommitmentDigest(commitment) {
    const { commitmentDigest: _digest, ...projection } = commitment;
    return sha256Canonical(projection);
}
export function agenticCorpusAllocationRevealDigest(reveal) {
    const { revealDigest: _digest, ...projection } = reveal;
    return sha256Canonical(projection);
}
export function agenticCorpusAllocationShareCommitmentDigest(keyId, secret) {
    const secretBytes = decodeBase64Url(secret);
    if (secretBytes?.length !== 32)
        throw new TypeError("ALLOCATION_SHARE_INVALID");
    return digestBytes(concatenateBytes([
        new TextEncoder().encode(ALLOCATION_SHARE_DOMAIN),
        lengthPrefix(new TextEncoder().encode(keyId)),
        lengthPrefix(secretBytes),
    ]));
}
export function agenticCorpusAllocationFinalSeedDigest(reveal) {
    const shares = [...reveal.shares].sort((left, right) => compareOrdinal(left.keyId, right.keyId));
    const secretBytes = shares.map((share) => decodeBase64Url(share.secret));
    if (secretBytes.some((bytes) => bytes?.length !== 32))
        throw new TypeError("ALLOCATION_SHARE_INVALID");
    return digestBytes(concatenateBytes([
        new TextEncoder().encode(ALLOCATION_SEED_DOMAIN),
        ...secretBytes.map((bytes) => lengthPrefix(bytes)),
    ]));
}
const INVALID_COMMITMENT_REPLAY = {
    valid: false,
    schemaValid: false,
    externalTrustAnchorValid: false,
    externalCommitmentAnchorValid: false,
    commitmentDigestValid: false,
    caseSetValid: false,
    commitmentSignaturesValid: false,
    principalsDistinct: false,
    revealValid: false,
    finalSeedDigestValid: false,
    allocationReplayValid: false,
    allocationBindingValid: false,
};
export function replayAgenticCorpusAllocationCommitment(input, dependencies) {
    let commitment;
    let reveal;
    let allocation;
    let trustPolicy;
    try {
        commitment = parseAgenticCorpusAllocationCommitment(input.commitment);
        reveal = parseAgenticCorpusAllocationReveal(input.reveal);
        allocation = parseAgenticCorpusAllocation(input.allocation);
        trustPolicy = parseAgenticCorpusTrustPolicy(input.trustPolicy);
    }
    catch {
        return INVALID_COMMITMENT_REPLAY;
    }
    const externalTrustAnchorValid = SHA256_DIGEST_PATTERN.test(input.expectedTrustPolicyDigest ?? "") &&
        trustPolicy.policyDigest === input.expectedTrustPolicyDigest &&
        commitment.trustPolicyDigest === input.expectedTrustPolicyDigest;
    const externalCommitmentAnchorValid = SHA256_DIGEST_PATTERN.test(input.expectedAllocationCommitmentDigest ?? "") &&
        commitment.commitmentDigest === input.expectedAllocationCommitmentDigest;
    const commitmentDigestValid = commitment.commitmentDigest === agenticCorpusAllocationCommitmentDigest(commitment);
    const sortedCaseSet = [...commitment.caseSet].sort((left, right) => compareOrdinal(left.caseId, right.caseId));
    const caseSetValid = canonicalize(commitment.caseSet) === canonicalize(sortedCaseSet) &&
        canonicalize(commitment.strata) ===
            canonicalize([...commitment.strata].sort((left, right) => compareOrdinal(left.sourceId, right.sourceId) ||
                compareOrdinal(left.sourceIdentityDigest, right.sourceIdentityDigest)));
    const signatureResult = dependencies?.verifySignatures(commitment, trustPolicy, input.expectedTrustPolicyDigest ?? "") ?? { valid: false, principalsDistinct: false };
    const revealByKey = new Map(reveal.shares.map((share) => [share.keyId, share]));
    const revealValid = reveal.commitmentDigest === commitment.commitmentDigest &&
        reveal.revealDigest === agenticCorpusAllocationRevealDigest(reveal) &&
        commitment.signers.every((signer) => {
            const share = revealByKey.get(signer.keyId);
            try {
                return (share !== undefined &&
                    signer.shareCommitmentDigest ===
                        agenticCorpusAllocationShareCommitmentDigest(signer.keyId, share.secret));
            }
            catch {
                return false;
            }
        });
    let expectedAllocation = null;
    let finalSeedDigestValid = false;
    try {
        const finalSeedDigest = agenticCorpusAllocationFinalSeedDigest(reveal);
        finalSeedDigestValid = allocation.seedDigest === finalSeedDigest;
        expectedAllocation = createAgenticCorpusAllocation({
            schemaVersion: "1.0.0",
            allocationId: commitment.allocationId,
            seedDigest: finalSeedDigest,
            strata: commitment.strata.map((stratum) => ({
                ...stratum,
                caseIds: commitment.caseSet
                    .filter((item) => item.sourceId === stratum.sourceId &&
                    item.sourceIdentityDigest === stratum.sourceIdentityDigest)
                    .map((item) => item.caseId),
            })),
        });
    }
    catch {
        expectedAllocation = null;
    }
    const allocationReplayValid = replayAgenticCorpusAllocation(allocation).valid;
    const allocationBindingValid = expectedAllocation !== null && canonicalize(allocation) === canonicalize(expectedAllocation);
    const rails = {
        schemaValid: true,
        externalTrustAnchorValid,
        externalCommitmentAnchorValid,
        commitmentDigestValid,
        caseSetValid,
        commitmentSignaturesValid: signatureResult.valid,
        principalsDistinct: signatureResult.principalsDistinct,
        revealValid,
        finalSeedDigestValid,
        allocationReplayValid,
        allocationBindingValid,
    };
    return { valid: Object.values(rails).every(Boolean), ...rails };
}
export function agenticCorpusExperimentPlanDigest(plan) {
    const { planDigest: _digest, ...projection } = plan;
    return sha256Canonical(projection);
}
export function agenticCorpusExperimentCommandDigest(command) {
    return sha256Canonical(command);
}
export function agenticCorpusExperimentSelectedSuiteDigest(candidates) {
    return sha256Canonical({
        domain: "TESTFORGE_H3_SELECTED_SUITE_V1",
        candidates: [...candidates].sort((left, right) => compareOrdinal(left.candidateId, right.candidateId) ||
            compareOrdinal(left.candidateDigest, right.candidateDigest)),
    });
}
export function agenticCorpusExperimentCandidateSetDigest(candidates) {
    return sha256Canonical([...candidates].sort((left, right) => compareOrdinal(left.candidateId, right.candidateId) ||
        compareOrdinal(left.candidateDigest, right.candidateDigest)));
}
const INVALID_PLAN_REPLAY = {
    valid: false,
    schemaValid: false,
    externalPlanAnchorValid: false,
    planDigestValid: false,
    allocationBindingValid: false,
    subjectSetValid: false,
    armsValid: false,
    commandsValid: false,
    scheduleValid: false,
    budgetValid: false,
};
function exactStringSet(left, right) {
    return (canonicalize([...new Set(left)].sort(compareOrdinal)) ===
        canonicalize([...new Set(right)].sort(compareOrdinal)));
}
export function replayAgenticCorpusExperimentPlan(value, expectedExperimentPlanDigest, context = {}) {
    let plan;
    try {
        plan = parseAgenticCorpusExperimentPlan(value);
    }
    catch {
        return INVALID_PLAN_REPLAY;
    }
    const externalPlanAnchorValid = SHA256_DIGEST_PATTERN.test(expectedExperimentPlanDigest) &&
        plan.planDigest === expectedExperimentPlanDigest;
    const planDigestValid = plan.planDigest === agenticCorpusExperimentPlanDigest(plan);
    const allocationBindingValid = context.allocation !== undefined &&
        context.commitment !== undefined &&
        plan.trustPolicyDigest === context.expectedTrustPolicyDigest &&
        plan.allocationCommitmentDigest === context.expectedAllocationCommitmentDigest &&
        plan.allocationDigest === context.allocation.allocationDigest;
    const holdoutIds = context.allocation?.holdoutCaseIds ?? [];
    const commitmentByCase = new Map(context.commitment?.caseSet.map((item) => [item.caseId, item]));
    const subjectSetValid = exactStringSet(plan.subjects.map((item) => item.caseId), holdoutIds) &&
        plan.subjects.every((subject) => {
            const committed = commitmentByCase.get(subject.caseId);
            return (committed !== undefined &&
                subject.caseDigest === committed.caseDigest &&
                subject.provenanceDigest === committed.provenanceDigest &&
                subject.sourceId === committed.sourceId &&
                subject.sourceIdentityDigest === committed.sourceIdentityDigest);
        });
    const armsValid = canonicalize([...plan.arms.baseline.candidateUniverse].sort((left, right) => compareOrdinal(left.candidateId, right.candidateId))) ===
        canonicalize([...plan.arms.profile.candidateUniverse].sort((left, right) => compareOrdinal(left.candidateId, right.candidateId))) &&
        [plan.arms.baseline, plan.arms.profile].every((arm) => new Set(arm.candidateUniverse.map((candidate) => candidate.candidateId)).size ===
            arm.candidateUniverse.length &&
            new Set(arm.selectedCandidates.map((candidate) => candidate.candidateId)).size ===
                arm.selectedCandidates.length &&
            arm.selectedSuiteDigest ===
                agenticCorpusExperimentSelectedSuiteDigest(arm.selectedCandidates));
    const adapterIds = new Set(plan.adapters.map((item) => item.adapterId));
    const commandById = new Map(plan.commands.map((item) => [item.commandId, item]));
    const commandsValid = commandById.size === plan.commands.length &&
        plan.commands.every((command) => {
            const arm = command.arm === "BASELINE" ? plan.arms.baseline : plan.arms.profile;
            return (adapterIds.has(command.adapterId) &&
                (command.subjectState === "REQUIRED_SUITE" ||
                    command.testSuiteDigest === arm.selectedSuiteDigest));
        });
    const scheduleKeys = plan.schedule.map((item) => `${item.caseId}\0${item.arm}\0${item.attemptOrdinal}\0${item.subjectState}`);
    const expectedKeys = plan.subjects.flatMap((subject) => ["BASELINE", "PROFILE"].flatMap((arm) => Array.from({ length: plan.protocol.minimumStableAttempts }, (_, index) => index + 1).flatMap((attemptOrdinal) => ["BUGGY", "FIXED", "REQUIRED_SUITE"].map((subjectState) => `${subject.caseId}\0${arm}\0${attemptOrdinal}\0${subjectState}`))));
    const scheduleValid = new Set(scheduleKeys).size === scheduleKeys.length &&
        exactStringSet(scheduleKeys, expectedKeys) &&
        plan.schedule.every((entry) => commandById.get(entry.commandId)?.subjectState === entry.subjectState &&
            commandById.get(entry.commandId)?.arm === entry.arm);
    const baselineCount = plan.schedule.filter((item) => item.arm === "BASELINE").length;
    const profileCount = plan.schedule.filter((item) => item.arm === "PROFILE").length;
    const plannedTimeout = (arm) => plan.schedule
        .filter((item) => item.arm === arm)
        .reduce((total, item) => total + (commandById.get(item.commandId)?.timeoutMs ?? 0), 0);
    const baselinePlannedTimeoutMs = plannedTimeout("BASELINE");
    const profilePlannedTimeoutMs = plannedTimeout("PROFILE");
    const budgetValid = plan.budget.unit === "PLANNED_PROCESS_EXECUTION" &&
        plan.budget.baselinePlannedProcessExecutions === baselineCount &&
        plan.budget.profilePlannedProcessExecutions === profileCount &&
        plan.budget.equalPlannedProcessExecutions === (baselineCount === profileCount) &&
        plan.budget.equalPlannedProcessExecutions &&
        Number.isSafeInteger(baselinePlannedTimeoutMs) &&
        Number.isSafeInteger(profilePlannedTimeoutMs) &&
        plan.budget.baselinePlannedTimeoutMs === baselinePlannedTimeoutMs &&
        plan.budget.profilePlannedTimeoutMs === profilePlannedTimeoutMs &&
        plan.budget.equalPlannedTimeoutBudget ===
            (baselinePlannedTimeoutMs === profilePlannedTimeoutMs) &&
        plan.budget.equalPlannedTimeoutBudget;
    const rails = {
        schemaValid: true,
        externalPlanAnchorValid,
        planDigestValid,
        allocationBindingValid,
        subjectSetValid,
        armsValid,
        commandsValid,
        scheduleValid,
        budgetValid,
    };
    return { valid: Object.values(rails).every(Boolean), ...rails };
}
export function resolveAgenticCorpusExperimentEvidence(requiredDigests, contents) {
    const missingDigests = [];
    const mismatchedDigests = [];
    for (const digest of [...new Set(requiredDigests)].sort(compareOrdinal)) {
        const content = contents.get(digest);
        if (content === undefined)
            missingDigests.push(digest);
        else if (digestBytes(typeof content === "string" ? new TextEncoder().encode(content) : content) !==
            digest) {
            mismatchedDigests.push(digest);
        }
    }
    return {
        valid: missingDigests.length === 0 && mismatchedDigests.length === 0,
        missingDigests,
        mismatchedDigests,
    };
}
function classifyExperimentAttempt(attempt) {
    if (attempt.buggy.outcome === "ASSERTION_FAILURE" &&
        attempt.buggy.attributed &&
        attempt.fixed.outcome === "PASS" &&
        attempt.requiredSuite.outcome === "PASS")
        return "DETECTED";
    if (attempt.buggy.outcome === "PASS" &&
        attempt.fixed.outcome === "PASS" &&
        attempt.requiredSuite.outcome === "PASS")
        return "NOT_DETECTED";
    return "INSUFFICIENT";
}
function classifyExperimentArm(attempts, minimum) {
    if (attempts.length !== minimum ||
        attempts.some((attempt, index) => attempt.ordinal !== index + 1)) {
        return "INSUFFICIENT";
    }
    const outcomes = attempts.map(classifyExperimentAttempt);
    if (outcomes.every((item) => item === "DETECTED"))
        return "DETECTED";
    if (outcomes.every((item) => item === "NOT_DETECTED"))
        return "NOT_DETECTED";
    return "INSUFFICIENT";
}
function deriveExperimentResult(payload, plan) {
    const protocol = plan.protocol;
    const baselineDetectedCaseIds = [];
    const profileDetectedCaseIds = [];
    const insufficientCaseIds = [];
    for (const item of payload.cases) {
        const baseline = classifyExperimentArm(item.baselineAttempts, protocol.minimumStableAttempts);
        const profile = classifyExperimentArm(item.profileAttempts, protocol.minimumStableAttempts);
        if (baseline === "DETECTED")
            baselineDetectedCaseIds.push(item.caseId);
        if (profile === "DETECTED")
            profileDetectedCaseIds.push(item.caseId);
        if (baseline === "INSUFFICIENT" || profile === "INSUFFICIENT")
            insufficientCaseIds.push(item.caseId);
    }
    baselineDetectedCaseIds.sort(compareOrdinal);
    profileDetectedCaseIds.sort(compareOrdinal);
    insufficientCaseIds.sort(compareOrdinal);
    const evaluatedCaseIds = payload.cases.map((item) => item.caseId).sort(compareOrdinal);
    const aggregateNonInferior = insufficientCaseIds.length === 0 &&
        profileDetectedCaseIds.length + protocol.maximumDetectionDeficitCases >=
            baselineDetectedCaseIds.length;
    const subjectsBySource = new Map();
    for (const subject of plan.subjects) {
        const key = `${subject.sourceId}\0${subject.sourceIdentityDigest}`;
        const stratum = subjectsBySource.get(key) ?? {
            sourceId: subject.sourceId,
            sourceIdentityDigest: subject.sourceIdentityDigest,
            caseIds: [],
        };
        stratum.caseIds.push(subject.caseId);
        subjectsBySource.set(key, stratum);
    }
    const sourceResults = [...subjectsBySource.values()]
        .sort((left, right) => compareOrdinal(left.sourceId, right.sourceId) ||
        compareOrdinal(left.sourceIdentityDigest, right.sourceIdentityDigest))
        .map((stratum) => {
        const caseIds = stratum.caseIds.sort(compareOrdinal);
        const baselineDetectedCount = caseIds.filter((caseId) => baselineDetectedCaseIds.includes(caseId)).length;
        const profileDetectedCount = caseIds.filter((caseId) => profileDetectedCaseIds.includes(caseId)).length;
        const hasInsufficient = caseIds.some((caseId) => insufficientCaseIds.includes(caseId));
        return {
            sourceId: stratum.sourceId,
            sourceIdentityDigest: stratum.sourceIdentityDigest,
            evaluatedCaseIds: caseIds,
            baselineDetectedCount,
            profileDetectedCount,
            nonInferior: !hasInsufficient &&
                profileDetectedCount + protocol.maximumDetectionDeficitCases >= baselineDetectedCount,
        };
    });
    const nonInferior = aggregateNonInferior && sourceResults.every((source) => source.nonInferior);
    return {
        status: insufficientCaseIds.length > 0 ? "INSUFFICIENT" : nonInferior ? "SUPPORTED" : "NOT_SUPPORTED",
        evaluatedCaseIds,
        baselineDetectedCaseIds,
        profileDetectedCaseIds,
        insufficientCaseIds,
        baselineDetectedCount: baselineDetectedCaseIds.length,
        profileDetectedCount: profileDetectedCaseIds.length,
        maximumDetectionDeficitCases: protocol.maximumDetectionDeficitCases,
        nonInferior,
        sourceResults,
    };
}
function normalizeExperimentRequest(request) {
    return {
        ...request,
        evidenceBindings: [...request.evidenceBindings].sort((left, right) => compareOrdinal(left.runId, right.runId)),
        payload: {
            cases: request.payload.cases
                .map((item) => ({
                caseId: item.caseId,
                baselineAttempts: [...item.baselineAttempts].sort((left, right) => left.ordinal - right.ordinal),
                profileAttempts: [...item.profileAttempts].sort((left, right) => left.ordinal - right.ordinal),
            }))
                .sort((left, right) => compareOrdinal(left.caseId, right.caseId)),
        },
        limitations: [...request.limitations].sort(compareOrdinal),
    };
}
function experimentArtifactProjection(artifact) {
    const { artifactDigest: _digest, ...projection } = artifact;
    return projection;
}
export function agenticCorpusExperimentArtifactDigest(artifact) {
    return sha256Canonical(experimentArtifactProjection(artifact));
}
export function createAgenticCorpusExperimentArtifact(value, plan) {
    const request = normalizeExperimentRequest(parseAgenticCorpusExperimentRequest(value));
    const projection = {
        ...request,
        candidateSetDigest: agenticCorpusExperimentCandidateSetDigest(plan.arms.baseline.candidateUniverse),
        evidenceSetDigest: sha256Canonical(request.evidenceBindings),
        payloadDigest: sha256Canonical(request.payload),
        result: deriveExperimentResult(request.payload, plan),
    };
    return parseAgenticCorpusExperimentArtifact({
        ...projection,
        artifactDigest: agenticCorpusExperimentArtifactDigest(projection),
    });
}
function receiptDigest(receipt) {
    const { receiptDigest: _digest, ...projection } = receipt;
    return sha256Canonical(projection);
}
function parseCanonicalJsonBytes(bytes) {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const parsed = JSON.parse(text);
        return `${canonicalize(parsed)}\n` === text ? parsed : null;
    }
    catch {
        return null;
    }
}
const INVALID_EXPERIMENT_REPLAY = {
    valid: false,
    schemaValid: false,
    artifactDigestValid: false,
    externalTrustAnchorValid: false,
    externalCommitmentAnchorValid: false,
    commitmentRevealValid: false,
    allocationReplayValid: false,
    allocationBindingValid: false,
    externalPlanAnchorValid: false,
    planDigestValid: false,
    planSemanticsValid: false,
    subjectDigestsValid: false,
    provenanceReplayValid: false,
    scheduleValid: false,
    budgetValid: false,
    evidenceSetDigestValid: false,
    receiptBindingsValid: false,
    candidateEvidenceValid: false,
    outputBytesResolved: false,
    structuredResultsValid: false,
    payloadSupported: false,
    payloadDigestValid: false,
    observationSemanticsValid: false,
    resultSemanticsValid: false,
};
export function replayAgenticCorpusExperimentArtifact(value, dependencies) {
    let replayRequest;
    let trustPolicy;
    let commitment;
    let allocation;
    let plan;
    if (dependencies === undefined)
        return INVALID_EXPERIMENT_REPLAY;
    try {
        replayRequest = parseAgenticCorpusExperimentReplayRequest(value);
        trustPolicy = parseAgenticCorpusTrustPolicy(dependencies.trustPolicy);
        commitment = parseAgenticCorpusAllocationCommitment(dependencies.allocationCommitment);
        allocation = parseAgenticCorpusAllocation(dependencies.allocation);
        plan = parseAgenticCorpusExperimentPlan(dependencies.experimentPlan);
    }
    catch {
        return INVALID_EXPERIMENT_REPLAY;
    }
    const { artifact } = replayRequest;
    const artifactDigestValid = artifact.artifactDigest === agenticCorpusExperimentArtifactDigest(artifact);
    const commitmentReplay = replayAgenticCorpusAllocationCommitment({
        commitment,
        reveal: dependencies.allocationReveal,
        allocation,
        trustPolicy,
        expectedTrustPolicyDigest: dependencies.expectedTrustPolicyDigest,
        expectedAllocationCommitmentDigest: dependencies.expectedAllocationCommitmentDigest,
    }, { verifySignatures: dependencies.verifyCommitmentSignatures });
    const planReplay = replayAgenticCorpusExperimentPlan(plan, dependencies.expectedExperimentPlanDigest, {
        allocation,
        commitment,
        expectedTrustPolicyDigest: dependencies.expectedTrustPolicyDigest,
        expectedAllocationCommitmentDigest: dependencies.expectedAllocationCommitmentDigest,
    });
    const allocationBindingValid = artifact.allocationDigest === allocation.allocationDigest &&
        artifact.planDigest === plan.planDigest &&
        artifact.trustPolicyDigest === dependencies.expectedTrustPolicyDigest;
    const subjectEvidenceByCase = new Map(dependencies.subjectEvidence.map((item) => [
        item.caseDocument.caseId,
        item,
    ]));
    const subjectDigestsValid = plan.subjects.length === dependencies.subjectEvidence.length &&
        plan.subjects.every((subject) => {
            const evidence = subjectEvidenceByCase.get(subject.caseId);
            const caseDocument = evidence?.caseDocument;
            const provenance = evidence?.provenance;
            return (caseDocument !== undefined &&
                provenance !== undefined &&
                caseDocument.h1 === undefined &&
                caseDocument.h2 === undefined &&
                caseDocument.h3 === undefined &&
                caseDocument.h4 === undefined &&
                subject.caseDigest === sha256Canonical(caseDocument) &&
                subject.provenanceDigest === provenance.provenanceDigest &&
                subject.sourceId === provenance.source?.sourceId &&
                subject.sourceIdentityDigest === provenance.source?.sourceIdentityDigest);
        });
    const provenanceReplayValid = plan.subjects.every((subject) => {
        const evidence = subjectEvidenceByCase.get(subject.caseId);
        return (evidence !== undefined &&
            dependencies.replayProvenance(evidence.caseDocument, evidence.provenance, trustPolicy, dependencies.expectedTrustPolicyDigest).valid);
    });
    const scheduleRunIds = plan.schedule.map((item) => item.runId).sort(compareOrdinal);
    const bindingRunIds = artifact.evidenceBindings.map((item) => item.runId).sort(compareOrdinal);
    const payloadRunIds = artifact.payload.cases
        .flatMap((item) => [...item.baselineAttempts, ...item.profileAttempts].flatMap((attempt) => Object.values(attempt.runIds)))
        .sort(compareOrdinal);
    const scheduleValid = planReplay.scheduleValid &&
        exactStringSet(scheduleRunIds, bindingRunIds) &&
        exactStringSet(scheduleRunIds, payloadRunIds);
    const budgetValid = planReplay.budgetValid && artifact.evidenceBindings.length === plan.schedule.length;
    const evidenceSetDigestValid = artifact.evidenceSetDigest === sha256Canonical(artifact.evidenceBindings);
    const contentMap = dependencies.evidenceContents;
    const candidateUniverse = plan.arms.baseline.candidateUniverse;
    const candidateEvidenceValid = artifact.candidateSetDigest === agenticCorpusExperimentCandidateSetDigest(candidateUniverse) &&
        resolveAgenticCorpusExperimentEvidence(candidateUniverse.map((candidate) => candidate.candidateDigest), contentMap).valid;
    let receiptBindingsValid = true;
    let outputBytesResolved = true;
    let structuredResultsValid = true;
    const observations = new Map();
    const commandById = new Map(plan.commands.map((item) => [item.commandId, item]));
    const scheduleByRunId = new Map(plan.schedule.map((item) => [item.runId, item]));
    const subjectByCaseId = new Map(plan.subjects.map((item) => [item.caseId, item]));
    for (const binding of artifact.evidenceBindings) {
        const receiptContent = contentMap.get(binding.receiptContentDigest);
        const receiptBytes = typeof receiptContent === "string"
            ? new TextEncoder().encode(receiptContent)
            : receiptContent;
        if (receiptBytes === undefined || digestBytes(receiptBytes) !== binding.receiptContentDigest) {
            receiptBindingsValid = false;
            continue;
        }
        const parsedReceipt = parseCanonicalJsonBytes(receiptBytes);
        let receipt;
        try {
            receipt = parseAgenticCorpusExperimentReceipt(parsedReceipt);
        }
        catch {
            receiptBindingsValid = false;
            continue;
        }
        const schedule = scheduleByRunId.get(binding.runId);
        const command = commandById.get(receipt.commandId);
        const subject = subjectByCaseId.get(receipt.caseId);
        if (schedule === undefined || command === undefined || subject === undefined) {
            receiptBindingsValid = false;
            continue;
        }
        const expectedRepositoryDigest = receipt.subjectState === "BUGGY" ? subject.buggyRevisionDigest : subject.fixedRevisionDigest;
        const bindingValid = receipt.runId === binding.runId &&
            receipt.receiptDigest === binding.receiptDigest &&
            receipt.receiptDigest === receiptDigest(receipt) &&
            receipt.planDigest === plan.planDigest &&
            receipt.commandId === schedule.commandId &&
            receipt.commandDigest === agenticCorpusExperimentCommandDigest(command) &&
            receipt.caseId === schedule.caseId &&
            receipt.arm === schedule.arm &&
            receipt.attemptOrdinal === schedule.attemptOrdinal &&
            receipt.subjectState === schedule.subjectState &&
            receipt.subjectState === command.subjectState &&
            receipt.repositoryDigest === expectedRepositoryDigest &&
            receipt.testSuiteDigest === command.testSuiteDigest &&
            receipt.appliedTimeoutMs === command.timeoutMs &&
            (receipt.subjectState !== "REQUIRED_SUITE" ||
                receipt.testSuiteDigest === subject.requiredSuiteDigest);
        if (!bindingValid)
            receiptBindingsValid = false;
        const requiredOutputDigests = [
            receipt.process.stdoutDigest,
            receipt.process.stderrDigest,
            receipt.structuredResultDigest,
        ];
        const resolution = resolveAgenticCorpusExperimentEvidence(requiredOutputDigests, contentMap);
        if (!resolution.valid) {
            outputBytesResolved = false;
            continue;
        }
        const stdoutContent = contentMap.get(receipt.process.stdoutDigest);
        const stderrContent = contentMap.get(receipt.process.stderrDigest);
        const stdoutBytes = typeof stdoutContent === "string" ? new TextEncoder().encode(stdoutContent) : stdoutContent;
        const stderrBytes = typeof stderrContent === "string" ? new TextEncoder().encode(stderrContent) : stderrContent;
        if (stdoutBytes === undefined ||
            stderrBytes === undefined ||
            stdoutBytes.length > command.maxStdoutBytes ||
            stderrBytes.length > command.maxStderrBytes) {
            outputBytesResolved = false;
            continue;
        }
        const structuredContent = contentMap.get(receipt.structuredResultDigest);
        const structuredBytes = typeof structuredContent === "string"
            ? new TextEncoder().encode(structuredContent)
            : structuredContent;
        const parsedStructured = structuredBytes === undefined ? null : parseCanonicalJsonBytes(structuredBytes);
        try {
            const structured = parseAgenticCorpusExperimentStructuredResult(parsedStructured);
            const processConsistent = (() => {
                switch (structured.outcome) {
                    case "PASS":
                        return !receipt.process.timedOut && receipt.process.exitCode === 0;
                    case "PROCESS_CRASH":
                        return !receipt.process.timedOut && receipt.process.exitCode === null;
                    case "TIMEOUT":
                        return receipt.process.timedOut;
                    case "ASSERTION_FAILURE":
                    case "COMPILE_FAILURE":
                    case "COLLECTION_FAILURE":
                    case "INFRA_ERROR":
                    case "NO_TEST_DISCOVERED":
                        return (!receipt.process.timedOut &&
                            receipt.process.exitCode !== null &&
                            receipt.process.exitCode !== 0);
                }
            })();
            if (!processConsistent)
                structuredResultsValid = false;
            observations.set(binding.runId, {
                outcome: structured.outcome,
                attributed: structured.attributed,
            });
        }
        catch {
            structuredResultsValid = false;
        }
    }
    const derivedCases = plan.subjects
        .map((subject) => {
        const attemptsForArm = (arm) => Array.from({ length: plan.protocol.minimumStableAttempts }, (_, index) => {
            const ordinal = index + 1;
            const runFor = (state) => plan.schedule.find((entry) => entry.caseId === subject.caseId &&
                entry.arm === arm &&
                entry.attemptOrdinal === ordinal &&
                entry.subjectState === state)?.runId;
            const buggyRunId = runFor("BUGGY") ?? "";
            const fixedRunId = runFor("FIXED") ?? "";
            const suiteRunId = runFor("REQUIRED_SUITE") ?? "";
            return {
                ordinal,
                buggy: observations.get(buggyRunId) ?? {
                    outcome: "INFRA_ERROR",
                    attributed: false,
                },
                fixed: observations.get(fixedRunId) ?? {
                    outcome: "INFRA_ERROR",
                    attributed: false,
                },
                requiredSuite: observations.get(suiteRunId) ?? {
                    outcome: "INFRA_ERROR",
                    attributed: false,
                },
                runIds: { buggy: buggyRunId, fixed: fixedRunId, requiredSuite: suiteRunId },
            };
        });
        return {
            caseId: subject.caseId,
            baselineAttempts: attemptsForArm("BASELINE"),
            profileAttempts: attemptsForArm("PROFILE"),
        };
    })
        .sort((left, right) => compareOrdinal(left.caseId, right.caseId));
    const derivedPayload = { cases: derivedCases };
    const payloadSupported = artifact.payloadSchemaId === AGENTIC_CORPUS_EXPERIMENT_PAYLOAD_SCHEMA_ID;
    const payloadDigestValid = artifact.payloadDigest === sha256Canonical(artifact.payload);
    const observationSemanticsValid = canonicalize(artifact.payload) === canonicalize(derivedPayload);
    const expectedResult = deriveExperimentResult(derivedPayload, plan);
    const resultSemanticsValid = canonicalize(artifact.result) === canonicalize(expectedResult);
    const artifactPlanBindingValid = artifact.experimentId === plan.experimentId &&
        artifact.hypothesis === plan.hypothesis &&
        artifact.partition === plan.partition;
    const rails = {
        schemaValid: true,
        artifactDigestValid,
        externalTrustAnchorValid: commitmentReplay.externalTrustAnchorValid,
        externalCommitmentAnchorValid: commitmentReplay.externalCommitmentAnchorValid,
        commitmentRevealValid: commitmentReplay.valid,
        allocationReplayValid: commitmentReplay.allocationReplayValid,
        allocationBindingValid,
        externalPlanAnchorValid: planReplay.externalPlanAnchorValid,
        planDigestValid: planReplay.planDigestValid,
        planSemanticsValid: planReplay.valid && artifactPlanBindingValid,
        subjectDigestsValid,
        provenanceReplayValid,
        scheduleValid,
        budgetValid,
        evidenceSetDigestValid,
        receiptBindingsValid,
        candidateEvidenceValid,
        outputBytesResolved,
        structuredResultsValid,
        payloadSupported,
        payloadDigestValid,
        observationSemanticsValid,
        resultSemanticsValid,
    };
    return { valid: Object.values(rails).every(Boolean), ...rails };
}
function normalizeRelativePath(value) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
        throw new TypeError("Path must be a non-empty relative path");
    if (/^(?:[a-zA-Z]:|[\\/]{1,2})/.test(value) || value.includes(":"))
        throw new TypeError("Absolute paths and Windows ADS are forbidden");
    const normalized = value.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
        throw new TypeError("Path traversal or ambiguous segments are forbidden");
    for (const segment of segments) {
        if (segment.normalize("NFC") !== segment) {
            throw new TypeError("Ambiguous Unicode path segment must use NFC");
        }
        const hasControlCharacter = [...segment].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        });
        if (hasControlCharacter || /[<>"|?*]/u.test(segment)) {
            throw new TypeError("Control or Windows-forbidden filename character");
        }
        if (/[. ]$/u.test(segment))
            throw new TypeError("Ambiguous Windows path segment");
        if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
            throw new TypeError("Reserved Windows device name");
        }
    }
    return segments.join("/");
}
export function portablePathKey(path) {
    return normalizeRelativePath(path).toLowerCase().normalize("NFC");
}
export function assertSafeRelativePath(path, roots) {
    const normalized = normalizeRelativePath(path);
    if (!Array.isArray(roots) || roots.length === 0)
        throw new TypeError("At least one safe root is required");
    const normalizedRoots = roots.map((root) => {
        if (root === ".")
            return ".";
        if (typeof root !== "string")
            throw new TypeError("Safe roots must be strings");
        return normalizeRelativePath(root.replace(/[\\/]+$/, ""));
    });
    const pathKey = portablePathKey(normalized);
    if (!normalizedRoots.some((root) => {
        if (root === ".")
            return true;
        const rootKey = portablePathKey(root);
        return pathKey === rootKey || pathKey.startsWith(`${rootKey}/`);
    })) {
        throw new TypeError("Path is outside the allowed roots");
    }
    return normalized;
}
//# sourceMappingURL=index.js.map