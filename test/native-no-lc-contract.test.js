import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffSnapshots, runtimeCachePaths, snapshotTree, validateNativeReport } from "../scripts/native-no-lc-contract.mjs";
import { resolveBundledNpmCli } from "../scripts/native-runtime-paths.mjs";
import { buildNativeConfig } from "../scripts/native-no-lc-config.mjs";
import { NATIVE_LANE_DEFINITIONS, NATIVE_STAGE_IDS, runNativeLaneMatrix,
  assertNativeSmokeResults, runNativeSmokeOrchestration, validateNativeSmokeEntrypointSource } from "../scripts/native-no-lc-runner.mjs";

function touch(path, bytes = "fixture\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

test("bundled npm resolution ignores a custom global prefix on Windows and Unix layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-bundled-npm-"));
  const windowsNode = touch(join(root, "windows", "node.exe"));
  const windowsNpm = touch(join(root, "windows", "node_modules", "npm", "bin", "npm-cli.js"));
  touch(join(root, "custom-prefix", "node_modules", "npm", "bin", "npm-cli.js"), "foreign\n");
  expect(resolveBundledNpmCli(windowsNode, "win32")).toBe(realpathSync(windowsNpm));

  const unixNode = touch(join(root, "unix", "bin", "node"));
  const unixNpm = touch(join(root, "unix", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  expect(resolveBundledNpmCli(unixNode, "linux")).toBe(realpathSync(unixNpm));
  expect(() => resolveBundledNpmCli(join(root, "missing", "node"), "linux")).toThrow(/Bundled npm CLI/u);
});

test("native helper CLIs execute under the pinned Node 22.15 runtime", () => {
  const windowsNode = "C:\\Users\\Hokli\\Documents\\Codex\\2026-09-25\\aujourd-hui-j-ai-un-probl-2\\work\\node-v22.15.0-win-x64\\node.exe";
  const node = process.platform === "win32" && existsSync(windowsNode) ? windowsNode : Bun.which("node");
  expect(node).toBeTruthy();
  expect(Bun.spawnSync({ cmd: [node, "--version"] }).stdout.toString().trim()).toMatch(/^v22\.15\./u);
  const runtimeCli = fileURLToPath(new URL("../scripts/native-runtime-paths.mjs", import.meta.url));
  const configCli = fileURLToPath(new URL("../scripts/native-no-lc-config.mjs", import.meta.url));
  for (const modulePath of [runtimeCli, configCli]) {
    const imported = Bun.spawnSync({
      cmd: [node, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(modulePath).href)})`],
      stdout: "pipe", stderr: "pipe",
    });
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    expect(imported.stdout.toString()).toBe("");
  }
  const resolved = Bun.spawnSync({ cmd: [node, runtimeCli], stdout: "pipe", stderr: "pipe" });
  expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
  expect(resolved.stdout.toString().trim()).toMatch(/npm-cli\.js$/u);

  const root = mkdtempSync(join(tmpdir(), "devkit-config-cli-"));
  const output = join(root, "config.json");
  const env = {
    ...process.env,
    DEVKIT_SHA256: "a".repeat(64),
    DEVKIT_SOURCE_SHA: "b".repeat(40),
    DEVKIT_VERSION: "0.1.0",
  };
  const generated = Bun.spawnSync({
    cmd: [node, configCli, output, join(root, "run"), root, join(root, "artifact.tgz"), "c".repeat(40), resolved.stdout.toString().trim()],
    env, stdout: "pipe", stderr: "pipe",
  });
  expect(generated.exitCode, generated.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
    artifact: { version: "0.1.0" }, expected: { semctx: "0.3.7" },
  });
  const malformed = Bun.spawnSync({ cmd: [node, configCli], env, stdout: "pipe", stderr: "pipe" });
  expect(malformed.exitCode).not.toBe(0);
  expect(malformed.stderr.toString()).toContain("Usage: node native-no-lc-config.mjs");
});

test("native report contract rejects missing, false, duplicate, and foreign evidence", () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "devkit-native-report-")));
  const component = {
    name: "semctx", version: "0.3.7", state: "configured",
    installed: "yes", configured: "yes", loaded: "unknown", approved: "unknown", observed: "unknown",
  };
  const report = {
    schemaVersion: 1, command: "setup", ok: true, projectRoot, hosts: ["codex"], conflicts: [],
    components: [component],
  };
  const options = {
    projectRoot, command: "setup", hosts: ["codex"], names: ["semctx"],
    versions: { semctx: "0.3.7" }, dryRun: false,
  };
  expect(validateNativeReport(structuredClone(report), options)).toEqual(report);
  const mutants = [
    (value) => { delete value.components[0].installed; },
    (value) => { value.components[0].installed = "no"; },
    (value) => { value.components[0].configured = "no"; },
    (value) => { delete value.components[0].state; },
    (value) => { value.hosts = ["claude"]; },
    (value) => { value.components.push({ ...value.components[0] }); },
    (value) => { value.conflicts = [{ code: "APPLY_FAILED" }]; },
  ];
  for (const mutate of mutants) {
    const candidate = structuredClone(report);
    mutate(candidate);
    expect(() => validateNativeReport(candidate, options)).toThrow(/invalid complete component report/u);
  }
});

function syntheticLaneReport(lane, command, dryRun) {
  const planned = command === "setup" && dryRun;
  const doctor = command === "doctor";
  const names = lane.withAssertLedger ? ["semctx", "assertledger"] : ["semctx"];
  return {
    schemaVersion: 1, command, ok: true, projectRoot: lane.repository,
    hosts: lane.host === "all" ? ["codex", "claude"] : [lane.host], conflicts: [],
    components: names.map((name) => ({
      name, version: name === "semctx" ? "0.3.7" : "1.3.0",
      ...(doctor ? {} : { state: planned ? "planned" : "configured" }),
      installed: planned ? "unknown" : "yes", configured: planned ? "unknown" : "yes",
      loaded: "unknown", approved: "unknown", observed: "unknown",
    })),
  };
}

function laneRunnerOptions(overrides = {}) {
  const commands = [];
  return {
    commands,
    laneDefinitions: NATIVE_LANE_DEFINITIONS,
    createLane: async (definition) => ({ ...definition, repository: path.join("/run", "lanes", definition.name, "repository") }),
    executeDevkit: async (lane, command, { dryRun }) => {
      commands.push(`${lane.name}:${command}:${dryRun}`);
      return syntheticLaneReport(lane, command, dryRun);
    },
    reportOptions: (lane, command, dryRun) => ({
      projectRoot: lane.repository, command,
      hosts: lane.host === "all" ? ["codex", "claude"] : [lane.host],
      names: lane.withAssertLedger ? ["semctx", "assertledger"] : ["semctx"],
      versions: { semctx: "0.3.7", assertledger: "1.3.0" }, dryRun,
    }),
    captureProtected: () => ({
      repository: [
        { path: ".", kind: "directory", mode: 0o755, device: "1", inode: "2" },
        { path: "package.json", kind: "file", mode: 0o644, bytes: 3, sha256: "a".repeat(64) },
      ],
      profile: [
        { path: ".", kind: "directory", mode: 0o755, device: "1", inode: "3" },
        { path: "home", kind: "directory", mode: 0o755 },
      ],
    }),
    recordSnapshot: () => {},
    runAssertLedgerDemo: async (lane) => ({ verdict: "VERIFIED", report: { verdict: "VERIFIED" },
      packageVersion: "1.3.0", demo: { repository: path.join("/run", "lanes", lane.name, "assertledger-demo") } }),
    ...overrides,
  };
}

function runnerResultContext(options) {
  const baseline = options.captureProtected();
  return {
    runRoot: "/run", versions: { semctx: "0.3.7", assertledger: "1.3.0" },
    trustedBaselines: new Map(NATIVE_LANE_DEFINITIONS.map((lane) => [lane.name, structuredClone(baseline)])),
    captureCurrent: () => structuredClone(baseline),
  };
}

test("production native runner executes the exact four lanes and seven stages", async () => {
  const options = laneRunnerOptions();
  const results = await runNativeLaneMatrix(options);
  expect(results.map(({ name, host, withAssertLedger }) => ({ name, host, withAssertLedger })))
    .toEqual(NATIVE_LANE_DEFINITIONS);
  for (const result of results) expect(result.stages).toEqual(NATIVE_STAGE_IDS);
  expect(options.commands).toHaveLength(20);
});

test("production native runner rejects an empty lane set", async () => {
  await expect(runNativeLaneMatrix(laneRunnerOptions({ laneDefinitions: [] }))).rejects.toThrow(/exact four/u);
});

test("production native runner cannot bypass native report validation", async () => {
  const invalid = laneRunnerOptions({
    executeDevkit: async (lane, command, { dryRun }) => {
      const report = syntheticLaneReport(lane, command, dryRun);
      delete report.components[0].installed;
      return report;
    },
  });
  await expect(runNativeLaneMatrix(invalid)).rejects.toThrow(/invalid complete component report/u);
});

test("production native runner cannot bypass protected snapshot comparison", async () => {
  let captures = 0;
  const changed = laneRunnerOptions({
    captureProtected: () => ({ repository: [{ path: ".", kind: "directory", captures: captures++ }], profile: [] }),
  });
  await expect(runNativeLaneMatrix(changed)).rejects.toThrow(/changed protected profile or repository/u);
});

test("production smoke orchestration validates literal result completeness before finalization", async () => {
  let finalized = false;
  const validOptions = laneRunnerOptions();
  const valid = await runNativeLaneMatrix(validOptions);
  const resultContext = runnerResultContext(validOptions);
  await expect(runNativeSmokeOrchestration({
    runMatrix: async () => [], matrixOptions: {}, resultContext, finalize: () => { finalized = true; },
  })).rejects.toThrow(/exactly four/u);
  expect(finalized).toBe(false);
  await expect(runNativeSmokeOrchestration({
    runMatrix: async () => valid.map((lane, index) => index === 0 ? { ...lane, stages: lane.stages.slice(1) } : lane),
    matrixOptions: {}, resultContext, finalize: () => { finalized = true; },
  })).rejects.toThrow(/stages are incomplete/u);
  expect(finalized).toBe(false);
  await runNativeSmokeOrchestration({
    runMatrix: async () => valid, matrixOptions: {}, resultContext, finalize: () => { finalized = true; },
  });
  expect(finalized).toBe(true);
});

test("actual native smoke suffix executes four lanes and refuses disconnected PASS", async () => {
  const sourcePath = new URL("../scripts/native-no-lc-smoke.mjs", import.meta.url);
  const source = readFileSync(sourcePath, "utf8");
  expect(validateNativeSmokeEntrypointSource(source)).toBe(true);
  const suffix = source.slice(source.indexOf("function finalizeNativeSmokeResults"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const executeSuffix = async (candidate, matrixRunner = runNativeLaneMatrix) => {
    const options = laneRunnerOptions();
    const writes = new Map();
    const names = [
      "snapshotTree", "sourceCheckout", "writeFileSync", "path", "evidenceRoot", "JSON", "diffSnapshots", "sourceBefore",
      "assert", "physicalRunRoot", "expectedPlatform", "artifactPath", "config", "codexPackage", "sha256File", "codexBin", "sha256Bytes",
      "toolsRoot", "claudePackage", "claudeBin", "console", "assertNativeSmokeResults", "NATIVE_LANE_DEFINITIONS",
      "createLane", "runDevkit", "nativeReportOptions", "snapshotProtected", "recordProtectedSnapshots",
      "runAssertLedgerDemo", "runNativeSmokeOrchestration", "runNativeLaneMatrix",
    ];
    const values = [
      () => [], "/source", (file, bytes) => writes.set(file, bytes), path, "/evidence", JSON, () => [], [],
      assert, "/run", "windows", "/artifact.tgz", { artifact: { sha256: "a", sourceSha: "b", version: "0.1.0" },
        expected: { semctx: "0.3.7", semctxPublicationSha: "c", assertledger: "1.3.0" } },
      { version: "0.147.0" }, () => "digest", "/codex", () => "digest", "/tools", { version: "2.1.229" }, "/claude",
      { log() {} }, assertNativeSmokeResults, NATIVE_LANE_DEFINITIONS, options.createLane, options.executeDevkit,
      options.reportOptions, options.captureProtected, options.recordSnapshot, options.runAssertLedgerDemo,
      runNativeSmokeOrchestration, matrixRunner,
    ];
    await new AsyncFunction(...names, candidate)(...values);
    return { writes, commands: options.commands };
  };
  const positive = await executeSuffix(suffix);
  expect(positive.commands).toHaveLength(20);
  expect([...positive.writes.keys()]).toContain(path.join("/evidence", "PASS"));
  const summary = JSON.parse(positive.writes.get(path.join("/evidence", "summary.json")));
  expect(summary.lanes.map(({ name, host, withAssertLedger }) => [name, host, withAssertLedger])).toEqual([
    ["codex-semctx", "codex", false], ["claude-semctx", "claude", false],
    ["all-semctx", "all", false], ["all-assertledger", "all", true],
  ]);
  for (const lane of summary.lanes) expect(lane.stages).toEqual([
    "create-lane", "setup-dry-run", "setup-apply", "doctor", "setup-repeat", "upgrade-noop", "assertledger-demo",
  ]);

  const validResults = await runNativeLaneMatrix(laneRunnerOptions());
  const labelOnly = validResults.map(({ name, host, withAssertLedger, stages }) => ({ name, host, withAssertLedger, stages }));
  const missingReport = structuredClone(validResults);
  delete missingReport[0].evidence[0].report;
  const malformedReport = structuredClone(validResults);
  delete malformedReport[0].evidence[0].report.components[0].installed;
  const incompleteSnapshot = structuredClone(validResults);
  incompleteSnapshot[0].evidence[0].protectedSnapshot.before.profile = [];
  const rootOnly = structuredClone(validResults);
  rootOnly[0].evidence[0].protectedSnapshot.before.repository.splice(1);
  rootOnly[0].evidence[0].protectedSnapshot.after.repository.splice(1);
  const malformedChild = structuredClone(validResults);
  malformedChild[0].evidence[0].protectedSnapshot.before.repository.push({
    path: "../escape", kind: "file", mode: 0o644, bytes: -1, sha256: "invalid",
  });
  malformedChild[0].evidence[0].protectedSnapshot.after = structuredClone(
    malformedChild[0].evidence[0].protectedSnapshot.before,
  );
  const duplicateRoot = structuredClone(validResults);
  duplicateRoot[0].evidence[0].protectedSnapshot.before.repository.push(structuredClone(
    duplicateRoot[0].evidence[0].protectedSnapshot.before.repository[0],
  ));
  duplicateRoot[0].evidence[0].protectedSnapshot.after = structuredClone(
    duplicateRoot[0].evidence[0].protectedSnapshot.before,
  );
  const duplicateApply = structuredClone(validResults);
  duplicateApply[0].evidence = Array.from({ length: 5 }, () => structuredClone(duplicateApply[0].evidence[1]));
  const forgedValidation = structuredClone(validResults);
  forgedValidation[0].evidence[0].report.projectRoot = "/foreign";
  forgedValidation[0].evidence[0].report.components[0].version = "9.9.9";
  forgedValidation[0].evidence[0].validation.projectRoot = "/foreign";
  forgedValidation[0].evidence[0].validation.versions.semctx = "9.9.9";
  const missingDemoReport = structuredClone(validResults);
  delete missingDemoReport[3].demo.evidence.report;
  const invalidDemoReport = structuredClone(validResults);
  invalidDemoReport[3].demo.evidence.report.verdict = "REJECTED";
  const contradictoryDemo = structuredClone(validResults);
  contradictoryDemo[3].demo.evidence.report.decision = { status: "REJECTED" };
  for (const [name, results] of Object.entries({
    labelOnly, missingReport, malformedReport, incompleteSnapshot, rootOnly, malformedChild, duplicateRoot,
    duplicateApply, forgedValidation, missingDemoReport, invalidDemoReport, contradictoryDemo,
  })) {
    const attempted = executeSuffix(suffix, async (options) => {
      // Populate the real outer capture context before substituting result evidence; otherwise
      // every negative could fail at a missing baseline rather than its mutated boundary.
      await runNativeLaneMatrix(options);
      return results;
    });
    await expect(attempted, name).rejects.toThrow();
  }

  const disconnected = suffix.replace(/await runNativeSmokeOrchestration\(\{[\s\S]*?\n\}\);\s*$/u,
    "const laneResults = [];\nfinalizeNativeSmokeResults(laneResults);\n");
  expect(() => validateNativeSmokeEntrypointSource(disconnected)).toThrow(/orchestration controller/u);
  await expect(executeSuffix(disconnected)).rejects.toThrow(/exactly four/u);
});

test("native snapshots detect permission-only mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-native-mode-"));
  const file = touch(join(root, "tool"));
  const recorded = snapshotTree(root);
  expect(recorded.find((item) => item.path === "tool")).toHaveProperty("mode");
  const synthetic = structuredClone(recorded);
  synthetic.find((item) => item.path === "tool").mode ^= 0o111;
  expect(diffSnapshots({ source: recorded }, { source: synthetic })).not.toEqual([]);
  if (process.platform === "win32") return;
  chmodSync(root, 0o755);
  const rootBefore = { source: snapshotTree(root) };
  chmodSync(root, 0o700);
  expect(diffSnapshots(rootBefore, { source: snapshotTree(root) })).not.toEqual([]);
  chmodSync(file, 0o644);
  const before = { source: snapshotTree(root) };
  chmodSync(file, 0o755);
  expect(diffSnapshots(before, { source: snapshotTree(root) })).not.toEqual([]);
});

test("native snapshots distinguish absent empty and linked roots", () => {
  const parent = mkdtempSync(join(tmpdir(), "devkit-native-root-"));
  const absent = snapshotTree(join(parent, "absent"));
  const emptyRoot = join(parent, "empty");
  mkdirSync(emptyRoot);
  const empty = snapshotTree(emptyRoot);
  expect(absent).toEqual([{ path: ".", kind: "absent" }]);
  expect(empty[0]).toMatchObject({ path: ".", kind: "directory" });
  expect(empty[0]).toHaveProperty("device");
  expect(empty[0]).toHaveProperty("inode");
  if (process.platform !== "win32") {
    const link = join(parent, "linked");
    symlinkSync(emptyRoot, link, "dir");
    expect(snapshotTree(link)).toEqual([expect.objectContaining({
      path: ".", kind: "symlink", target: emptyRoot,
    })]);
  }
});

test("native snapshots inspect root presence and never follow a root symlink", () => {
  const calls = [];
  const io = {
    lstatSync(path, options) {
      calls.push(["lstat", path, options]);
      if (path.endsWith("absent")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (path.endsWith("link")) return {
        mode: 0o120777n, dev: 7n, ino: 11n,
        isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false,
      };
      return {
        mode: 0o040755n, dev: 7n, ino: 10n,
        isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
      };
    },
    readlinkSync(path) { calls.push(["readlink", path]); return "target"; },
    readdirSync(path) { calls.push(["readdir", path]); return []; },
    readFileSync() { throw new Error("unexpected read"); },
  };
  expect(snapshotTree("/fixture/absent", io)).toEqual([{ path: ".", kind: "absent" }]);
  expect(snapshotTree("/fixture/empty", io)).toEqual([{
    path: ".", kind: "directory", mode: 0o755, device: "7", inode: "10",
  }]);
  expect(snapshotTree("/fixture/link", io)).toEqual([{
    path: ".", kind: "symlink", mode: 0o777, target: "target", device: "7", inode: "11",
  }]);
  expect(calls.filter(([kind, path]) => kind === "readdir" && path.endsWith("link"))).toHaveLength(0);
});

test("native runtime cache paths stay outside the fully protected home", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-native-cache-"));
  const runtime = join(root, "runtime");
  const protectedHome = join(root, "profile", "home");
  const caches = runtimeCachePaths(runtime);
  expect(Object.keys(caches)).toContain("BUN_INSTALL_CACHE_DIR");
  for (const cache of Object.values(caches)) {
    expect(cache.startsWith(`${protectedHome}\\`) || cache.startsWith(`${protectedHome}/`)).toBe(false);
    expect(cache.startsWith(runtime)).toBe(true);
  }
});

test("real native startup accepts generated owned config and rejects wrong expected versions before network", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "devkit-native-startup-")));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "README.md"), "fixture\n");
  for (const args of [
    ["init", "--initial-branch=main"],
    ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
  ]) expect(Bun.spawnSync({ cmd: ["git", ...args], cwd: source }).exitCode).toBe(0);
  const sourceSha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: source }).stdout.toString().trim();
  const artifact = touch(join(root, "artifact", "hoklims-devkit-0.1.0.tgz"), "artifact\n");
  const npmCli = touch(join(root, "runtime", "npm-cli.js"));
  const harness = fileURLToPath(new URL("../scripts/native-no-lc-smoke.mjs", import.meta.url));
  const base = {
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    sourceCheckout: source,
    artifact: {
      path: artifact,
      sha256: createHash("sha256").update("artifact\n").digest("hex"),
      sourceSha,
      version: "0.1.0",
    },
    expected: {
      semctx: "0.3.7", semctxPublicationSha: "a".repeat(40), assertledger: "1.3.0",
      codex: "0.147.0", claude: "2.1.229",
    },
    runtime: { npmCliJs: npmCli, bunExecutable: process.execPath, gitExecutable: "git" },
    allowAssertLedgerUnsafeDemo: true,
    startupProbeOnly: true,
  };
  const execute = (name, expected = base.expected) => {
    const config = join(root, `${name}.json`);
    const runRoot = join(root, name);
    const generated = buildNativeConfig({
      runRoot,
      sourceCheckout: source,
      artifactPath: artifact,
      artifactSha256: base.artifact.sha256,
      sourceSha,
      version: "0.1.0",
      semctxPublicationSha: base.expected.semctxPublicationSha,
      npmCliJs: npmCli,
      startupProbeOnly: true,
    });
    writeFileSync(config, `${JSON.stringify({ ...generated, expected })}\n`);
    return Bun.spawnSync({ cmd: [process.execPath, harness, config], cwd: root, stdout: "pipe", stderr: "pipe" });
  };
  const accepted = execute("accepted");
  expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);
  const refused = execute("refused", { ...base.expected, semctx: "0.3.8" });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain("Expected Semctx version gate");
});
