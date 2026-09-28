import assert from "node:assert/strict";
import path from "node:path";
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
const EXPECTED_REPORT_STAGES = [
  ["setup-dry-run", "setup", true, true],
  ["setup-apply", "setup", false, false],
  ["doctor", "doctor", false, true],
  ["setup-repeat", "setup", false, true],
  ["upgrade-noop", "upgrade", false, true],
];

function exactLaneDefinitions(definitions) {
  return isDeepStrictEqual(definitions, NATIVE_LANE_DEFINITIONS);
}

function validSnapshotPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !path.isAbsolute(value)
    && path.posix.normalize(value) === value && !value.split("/").some((part) => part === ".." || part === "");
}

function assertSnapshotInventory(snapshot, label) {
  assert(Array.isArray(snapshot?.repository) && Array.isArray(snapshot?.profile), `${label} scopes are incomplete`);
  for (const [scope, records] of Object.entries(snapshot)) {
    assert(records.length > 0, `${label} ${scope} inventory is empty`);
    assert.equal(new Set(records.map((record) => record?.path)).size, records.length, `${label} ${scope} paths are duplicated`);
    for (const record of records) {
      assert(validSnapshotPath(record?.path), `${label} ${scope} path is invalid`);
      assert(["directory", "file", "symlink", "other"].includes(record.kind), `${label} ${scope} kind is invalid`);
      if (record.kind === "file") {
        assert(Number.isInteger(record.mode) && Number.isInteger(record.bytes) && record.bytes >= 0
          && /^[a-f0-9]{64}$/u.test(record.sha256), `${label} ${scope} file record is invalid`);
      } else if (record.kind === "symlink") {
        assert.equal(typeof record.target, "string", `${label} ${scope} symlink target is invalid`);
      } else assert(Number.isInteger(record.mode), `${label} ${scope} mode is invalid`);
    }
    const root = records.find((record) => record.path === ".");
    assert(root?.kind === "directory" && Number.isInteger(root.mode)
      && typeof root.device === "string" && typeof root.inode === "string", `${label} ${scope} root is invalid`);
  }
  return snapshot;
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
    const evidence = [];
    const lane = await createLane(definition);
    stages.push("create-lane");
    const execute = async (id, command, dryRun, unchanged) => {
      const before = unchanged ? captureProtected(lane) : null;
      const raw = await executeDevkit(lane, command, { dryRun });
      const validation = reportOptions(lane, command, dryRun);
      const report = validateNativeReport(raw, validation);
      let after = null;
      if (unchanged) {
        after = captureProtected(lane);
        recordSnapshot({ lane, id, before, after });
        assert.deepEqual(after, before, `${lane.name} ${id} changed protected profile or repository`);
      }
      stages.push(id);
      evidence.push({ id, command, dryRun, report, validation,
        protectedSnapshot: unchanged ? { before, after } : null });
      return report;
    };
    const dryRun = await execute("setup-dry-run", "setup", true, true);
    const apply = await execute("setup-apply", "setup", false, false);
    const doctor = await execute("doctor", "doctor", false, true);
    const repeat = await execute("setup-repeat", "setup", false, true);
    const upgrade = await execute("upgrade-noop", "upgrade", false, true);
    const demo = lane.withAssertLedger
      ? { applicable: true, evidence: await runAssertLedgerDemo(lane) }
      : { applicable: false, status: "NOT_APPLICABLE" };
    stages.push("assertledger-demo");
    assert.deepEqual(stages, NATIVE_STAGE_IDS, `${lane.name} native stage order changed`);
    results.push({ name: lane.name, host: lane.host, withAssertLedger: lane.withAssertLedger, repository: lane.repository,
      stages, evidence, demo, dryRun, apply, doctor, repeat, upgrade });
  }
  assert.deepEqual(results.map(({ name, host, withAssertLedger }) => ({ name, host, withAssertLedger })),
    NATIVE_LANE_DEFINITIONS, "native smoke lane results are incomplete");
  return results;
}

export function assertNativeSmokeResults(results, context) {
  assert(context && path.isAbsolute(context.runRoot), "native smoke trusted run root is missing");
  assert.deepEqual(context.versions, { semctx: "0.3.7", assertledger: "1.3.0" },
    "native smoke trusted versions differ from the release contract");
  assert(context.trustedBaselines instanceof Map && typeof context.captureCurrent === "function",
    "native smoke trusted snapshot providers are missing");
  assert.equal(results.length, 4, "native smoke must finish exactly four lanes");
  assert.deepEqual(results.map((lane) => [lane.name, lane.host, lane.withAssertLedger]),
    EXPECTED_RESULT_LANES, "native smoke result lane identities are incomplete");
  for (const lane of results) {
    const expectedLane = EXPECTED_RESULT_LANES.find(([name]) => name === lane.name);
    const expectedRepository = path.join(context.runRoot, "lanes", lane.name, "repository");
    const trustedBaseline = assertSnapshotInventory(context.trustedBaselines.get(lane.name), `${lane.name} trusted baseline`);
    const trustedCurrent = assertSnapshotInventory(context.captureCurrent(lane.name), `${lane.name} trusted current`);
    assert.equal(lane.repository, expectedRepository, `${lane.name} repository identity is invalid`);
    assert.deepEqual(lane.stages, EXPECTED_RESULT_STAGES, `${lane.name} native result stages are incomplete`);
    assert.equal(lane.evidence?.length, 5, `${lane.name} native report evidence is incomplete`);
    for (let index = 0; index < EXPECTED_REPORT_STAGES.length; index += 1) {
      const item = lane.evidence[index];
      const [id, command, dryRun, readOnly] = EXPECTED_REPORT_STAGES[index];
      assert.equal(item.id, id, `${lane.name} native evidence id is invalid`);
      assert.equal(item.command, command, `${lane.name} native evidence command is invalid`);
      assert.equal(item.dryRun, dryRun, `${lane.name} native evidence dry-run flag is invalid`);
      validateNativeReport(item.report, {
        projectRoot: expectedRepository, command,
        hosts: expectedLane[1] === "all" ? ["codex", "claude"] : [expectedLane[1]],
        names: expectedLane[2] ? ["semctx", "assertledger"] : ["semctx"],
        versions: context.versions, dryRun,
      });
      assert.equal(item.protectedSnapshot !== null, readOnly, `${lane.name} ${item.id} snapshot applicability is invalid`);
      if (readOnly) {
        const { before, after } = item.protectedSnapshot;
        assertSnapshotInventory(before, `${lane.name} ${item.id} before`);
        assertSnapshotInventory(after, `${lane.name} ${item.id} after`);
        assert.deepEqual(after, before, `${lane.name} ${item.id} protected snapshots differ`);
        if (item.id === "setup-dry-run") assert.deepEqual(before, trustedBaseline, `${lane.name} dry-run baseline is incomplete`);
        if (["doctor", "setup-repeat", "upgrade-noop"].includes(item.id)) {
          assert.deepEqual(after, trustedCurrent, `${lane.name} ${item.id} current inventory is incomplete`);
        }
      }
    }
    assert.equal(lane.demo?.applicable, lane.withAssertLedger, `${lane.name} demo applicability is invalid`);
    if (lane.withAssertLedger) {
      assert.equal(lane.demo.evidence?.verdict, "VERIFIED", `${lane.name} demo evidence is invalid`);
      const report = lane.demo.evidence?.report;
      const statuses = [report?.verdict, report?.status, report?.decision?.verdict, report?.decision?.status]
        .filter((value) => value !== undefined);
      assert(statuses.length > 0 && statuses.every((value) => value === "VERIFIED"), `${lane.name} demo report is missing or contradictory`);
      assert.equal(lane.demo.evidence.packageVersion, context.versions.assertledger, `${lane.name} demo package version is invalid`);
      const expectedDemoRoot = path.join(context.runRoot, "lanes", lane.name, "assertledger-demo");
      assert.equal(lane.demo.evidence.demo?.repository, expectedDemoRoot, `${lane.name} demo repository identity is invalid`);
    } else assert.equal(lane.demo.status, "NOT_APPLICABLE", `${lane.name} demo status is invalid`);
  }
  return results;
}

export async function runNativeSmokeOrchestration({ runMatrix, matrixOptions, resultContext, finalize }) {
  assert.equal(typeof runMatrix, "function", "native smoke matrix entrypoint missing");
  assert.equal(typeof finalize, "function", "native smoke finalizer missing");
  const results = assertNativeSmokeResults(await runMatrix(matrixOptions), resultContext);
  return finalize(results);
}

export async function runOwnedAssertLedgerDemo({ createDemo, validateDemo, checkDemo }) {
  for (const callback of [createDemo, validateDemo, checkDemo]) {
    assert.equal(typeof callback, "function", "AssertLedger demo boundary dependency missing");
  }
  const demo = await createDemo();
  validateDemo(demo);
  const report = await checkDemo(demo);
  return { demo, report };
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
