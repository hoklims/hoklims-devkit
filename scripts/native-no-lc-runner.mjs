import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { validateNativeReport } from "./native-no-lc-contract.mjs";

export const NATIVE_LANE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "codex-semctx", host: "codex", withAssertLedger: false }),
  Object.freeze({ name: "claude-semctx", host: "claude", withAssertLedger: false }),
  Object.freeze({ name: "all-semctx", host: "all", withAssertLedger: false }),
  Object.freeze({ name: "all-assertledger", host: "all", withAssertLedger: true }),
]);

export const NATIVE_STAGE_IDS = Object.freeze([
  "create-lane", "setup-dry-run", "setup-apply", "doctor", "setup-repeat", "upgrade-noop", "assertledger-demo",
]);

const EXPECTED_RESULT_LANES = [
  ["codex-semctx", "codex", false],
  ["claude-semctx", "claude", false],
  ["all-semctx", "all", false],
  ["all-assertledger", "all", true],
];
const EXPECTED_RESULT_STAGES = [
  "create-lane", "setup-dry-run", "setup-apply", "doctor", "setup-repeat", "upgrade-noop", "assertledger-demo",
];

function exactLaneDefinitions(definitions) {
  return isDeepStrictEqual(definitions, NATIVE_LANE_DEFINITIONS);
}

export async function runNativeLaneMatrix({
  laneDefinitions = NATIVE_LANE_DEFINITIONS,
  createLane,
  executeDevkit,
  reportOptions,
  captureProtected,
  recordSnapshot = () => {},
  runAssertLedgerDemo,
}) {
  assert(exactLaneDefinitions(laneDefinitions), "native smoke requires the exact four owned lane definitions");
  for (const callback of [createLane, executeDevkit, reportOptions, captureProtected, recordSnapshot, runAssertLedgerDemo]) {
    assert.equal(typeof callback, "function", "native smoke runner dependency missing");
  }
  const results = [];
  for (const definition of laneDefinitions) {
    const stages = [];
    const lane = await createLane(definition);
    stages.push("create-lane");
    const execute = async (id, command, dryRun, unchanged) => {
      const before = unchanged ? captureProtected(lane) : null;
      const raw = await executeDevkit(lane, command, { dryRun });
      const report = validateNativeReport(raw, reportOptions(lane, command, dryRun));
      if (unchanged) {
        const after = captureProtected(lane);
        recordSnapshot({ lane, id, before, after });
        assert.deepEqual(after, before, `${lane.name} ${id} changed protected profile or repository`);
      }
      stages.push(id);
      return report;
    };
    const dryRun = await execute("setup-dry-run", "setup", true, true);
    const apply = await execute("setup-apply", "setup", false, false);
    const doctor = await execute("doctor", "doctor", false, true);
    const repeat = await execute("setup-repeat", "setup", false, true);
    const upgrade = await execute("upgrade-noop", "upgrade", false, true);
    if (lane.withAssertLedger) await runAssertLedgerDemo(lane);
    stages.push("assertledger-demo");
    assert.deepEqual(stages, NATIVE_STAGE_IDS, `${lane.name} native stage order changed`);
    results.push({ name: lane.name, host: lane.host, withAssertLedger: lane.withAssertLedger,
      stages, dryRun, apply, doctor, repeat, upgrade });
  }
  assert.deepEqual(results.map(({ name, host, withAssertLedger }) => ({ name, host, withAssertLedger })),
    NATIVE_LANE_DEFINITIONS, "native smoke lane results are incomplete");
  return results;
}

export function assertNativeSmokeResults(results) {
  assert.equal(results.length, 4, "native smoke must finish exactly four lanes");
  assert.deepEqual(results.map((lane) => [lane.name, lane.host, lane.withAssertLedger]),
    EXPECTED_RESULT_LANES, "native smoke result lane identities are incomplete");
  for (const lane of results) {
    assert.deepEqual(lane.stages, EXPECTED_RESULT_STAGES, `${lane.name} native result stages are incomplete`);
  }
  return results;
}

export async function runNativeSmokeOrchestration({ runMatrix, matrixOptions, finalize }) {
  assert.equal(typeof runMatrix, "function", "native smoke matrix entrypoint missing");
  assert.equal(typeof finalize, "function", "native smoke finalizer missing");
  const results = assertNativeSmokeResults(await runMatrix(matrixOptions));
  return finalize(results);
}

export function validateNativeSmokeEntrypointSource(source) {
  assert.equal(typeof source, "string", "native smoke source missing");
  assert.equal((source.match(/await runNativeSmokeOrchestration\(\{/gu) ?? []).length, 1,
    "native smoke must invoke its orchestration controller exactly once");
  assert.match(source, /runMatrix: runNativeLaneMatrix,[\s\S]*finalize: finalizeNativeSmokeResults,/u,
    "native smoke orchestration dependencies are disconnected");
  assert.equal((source.match(/writeFileSync\(path\.join\(evidenceRoot, "PASS"\)/gu) ?? []).length, 1,
    "native smoke must have exactly one PASS writer");
  assert(source.indexOf("function finalizeNativeSmokeResults") < source.indexOf("await runNativeSmokeOrchestration({"),
    "native smoke PASS finalizer must be controlled by orchestration");
  return true;
}
