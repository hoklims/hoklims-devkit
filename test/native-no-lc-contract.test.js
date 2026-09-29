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
  assertNativeSmokeResults, runNativeSmokeOrchestration, runOwnedAssertLedgerDemo,
  validateNativeSmokeEntrypointSource } from "../scripts/native-no-lc-runner.mjs";
import { assertLedgerContract } from "../src/assertledger-contracts.js";

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
        { path: "package.json", kind: "file", mode: 0o644, bytes: 3, sha256: "a".repeat(64), device: "1", inode: "4" },
      ],
      profile: [
        { path: ".", kind: "directory", mode: 0o755, device: "1", inode: "3" },
        { path: "home", kind: "directory", mode: 0o755, device: "1", inode: "5" },
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

test("owned AssertLedger demo boundary refuses foreign creator output before unsafe check", async () => {
  let checks = 0;
  await expect(runOwnedAssertLedgerDemo({
    createDemo: async () => ({ repository: "/foreign/user-repo", out: "/foreign/result" }),
    validateDemo: (demo) => {
      assert.equal(demo.repository, "/owned/assertledger-demo");
      assert.equal(demo.out, "evidence-strong");
    },
    checkDemo: async () => { checks += 1; return { verdict: "VERIFIED" }; },
  })).rejects.toThrow();
  expect(checks).toBe(0);
  const positive = await runOwnedAssertLedgerDemo({
    createDemo: async () => ({ repository: "/owned/assertledger-demo", out: "evidence-strong" }),
    validateDemo: (demo) => {
      assert.equal(demo.repository, "/owned/assertledger-demo");
      assert.equal(demo.out, "evidence-strong");
    },
    checkDemo: async () => { checks += 1; return { verdict: "VERIFIED" }; },
  });
  expect(positive.report.verdict).toBe("VERIFIED");
  expect(checks).toBe(1);
});

test("actual AssertLedger demo function validates owned paths and reauthenticates before unsafe check", async () => {
  const source = readFileSync(new URL("../scripts/native-no-lc-smoke.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function runAssertLedgerDemo"),
    source.indexOf("function finalizeNativeSmokeResults"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const load = new AsyncFunction(
    "assert", "config", "path", "readFileSync", "assertLedgerContract", "realpathSync", "sha256File", "process", "spawnSync",
    "runOwnedAssertLedgerDemo", "runCommand", "parseJsonOutput", "isWithin", "statSync", "existsSync", "lstatSync",
    "writeFileSync", "evidenceRoot", "JSON", `${body}\nreturn runAssertLedgerDemo;`,
  );
  const execute = async ({ mutateDemo, mutateAsset, mutateGitOutput, symlinkPath, danglingLink, redirectedRoot } = {}) => {
    const lane = { name: "all-assertledger", root: path.join("/run", "lanes", "all-assertledger"),
      repository: path.join("/run", "lanes", "all-assertledger", "repository"), env: {} };
    const demoRoot = path.join(lane.root, "assertledger-demo");
    const provenance = JSON.parse(readFileSync(new URL(
      "./fixtures/assertledger-assets/1.3.0/examples/git-history/escape-string-regexp/provenance.json", import.meta.url,
    ), "utf8"));
    const validDemo = { repository: demoRoot,
      before: "be437c0ce8b155277f87d38c6519da85663a0890",
      after: "3c46e97e26f497f7a3adcf2c209283fd424e42ca",
      neutral: "6c703f810069afafdbe7562d454b26a7ae974557",
      neutralReason: "Documentation-only change to the corrected tree; no additional behavioral robustness claim",
      test: "strong.test.mjs", baseTests: ["base.test.mjs"], out: "evidence-strong", provenance };
    const demo = mutateDemo ? mutateDemo(structuredClone(validDemo)) : validDemo;
    let checks = 0;
    let created = false;
    const contract = assertLedgerContract("1.3.0");
    const packageRoot = path.join(lane.repository, "node_modules", "assertledger");
    const fakeProcess = { execPath: path.join("/runtime", "node") };
    const runCommand = async ({ name }) => {
      if (name.endsWith("demo-create")) { created = true; return { stdout: JSON.stringify(demo) }; }
      checks += 1;
      return { stdout: JSON.stringify({ verdict: "VERIFIED" }) };
    };
    const realpath = (value) => redirectedRoot && path.resolve(value) === path.resolve(demoRoot)
      ? path.join("/foreign", "user-repo") : path.resolve(value);
    const fn = await load(
      assert, { allowAssertLedgerUnsafeDemo: true, expected: { assertledger: "1.3.0" }, runtime: { gitExecutable: "git" } }, path,
      (file) => file.endsWith("package.json") ? JSON.stringify({ version: "1.3.0" })
        : file.endsWith("provenance.json") ? JSON.stringify(provenance) : "bytes",
      () => contract, realpath,
      (file) => {
        const relativePath = path.relative(packageRoot, file).split(path.sep).join("/");
        if (created && relativePath === mutateAsset) return "mutated";
        return contract[relativePath];
      },
      fakeProcess, (_git, args) => {
        const command = args.findIndex((argument) => ["rev-list", "rev-parse", "ls-tree"].includes(argument));
        const operation = args[command];
        const revision = args.at(-1).replace(/\^\{tree\}$/u, "");
        const values = {
          be437c0ce8b155277f87d38c6519da85663a0890: {
            parents: "be437c0ce8b155277f87d38c6519da85663a0890", tree: "c9ba3febfbba5eceef294ad8949010c74b5cf21e",
            subject: "58217a4efa3c835c532499a3dad887017dc70a6b", readme: "855625ddc60ab9faae61e8a1663741956ff90cdd",
          },
          "3c46e97e26f497f7a3adcf2c209283fd424e42ca": {
            parents: "3c46e97e26f497f7a3adcf2c209283fd424e42ca be437c0ce8b155277f87d38c6519da85663a0890",
            tree: "878b78912efdeb0689bfac7c9fa80c08687d295f", subject: "e5bb9db7933b7230327c7d99cc8459575f090dd4",
            readme: "855625ddc60ab9faae61e8a1663741956ff90cdd",
          },
          "6c703f810069afafdbe7562d454b26a7ae974557": {
            parents: "6c703f810069afafdbe7562d454b26a7ae974557 3c46e97e26f497f7a3adcf2c209283fd424e42ca",
            tree: "786fceacda932497b07e9ddbfaabfd089bb5a27a", subject: "e5bb9db7933b7230327c7d99cc8459575f090dd4",
            readme: "23fe9073fbb13f2134086b91f110a0cacfdbb66e",
          },
        };
        const value = values[revision];
        const common = [
          "100644 blob e7af2f77107d73046421ef56c4684cbfdd3c1e89\tLICENSE",
          `100644 blob ${value.readme}\tREADME.md`,
          "100644 blob 33b18dc93d4e8057f61d7a5b820c7f27ba96de2c\tbase.test.mjs",
          "100644 blob 63802e5cbdeb4098be4180e5d478c4e2a25ae34e\tcrash.test.mjs",
          "100644 blob 9d30947a9b4f89db1ec6f10de18f5a1161187528\tpackage.json",
          "100644 blob e39b9e7b14a9a1226533ce2c068afa92b8466b00\tstrong.test.mjs",
          `100644 blob ${value.subject}\tsubject.cjs`,
          "100644 blob c4365c9655b940ab0d3049614c40df438f98e15f\tweak.test.mjs",
        ];
        let stdout = operation === "rev-list" ? value.parents : operation === "rev-parse" ? value.tree : common.join("\n");
        if (mutateGitOutput && operation === mutateGitOutput) stdout = `${stdout}mutated`;
        return { status: 0, signal: null, stdout, stderr: "", error: undefined };
      }, runOwnedAssertLedgerDemo, runCommand, (result) => JSON.parse(result.stdout),
      (parent, child) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); },
      () => ({ isFile: () => true }), (value) => !danglingLink && symlinkPath !== undefined && path.resolve(value) === path.resolve(symlinkPath),
      (value) => ({ isSymbolicLink: () => symlinkPath !== undefined && path.resolve(value) === path.resolve(symlinkPath) }),
      () => {}, "/evidence", JSON,
    );
    let error = null;
    try { await fn(lane); } catch (caught) { error = caught; }
    return { error, checks };
  };
  expect((await execute()).checks).toBe(1);
  for (const options of [
    { mutateDemo: (demo) => ({ ...demo, repository: path.join("/foreign", "user-repo") }) },
    { mutateDemo: (demo) => ({ ...demo, out: path.join("/foreign", "result") }) },
    { mutateDemo: (demo) => ({ ...demo, out: "other-output" }) },
    { mutateDemo: (demo) => ({ ...demo, test: "other.test.mjs" }) },
    { mutateDemo: (demo) => ({ ...demo, baseTests: ["other-base.test.mjs"] }) },
    { mutateDemo: (demo) => ({ ...demo, after: demo.before }) },
    { mutateDemo: (demo) => ({ ...demo, neutral: "d".repeat(40) }) },
    { mutateDemo: (demo) => ({ ...demo, test: "../escape.test.mjs" }) },
    { mutateDemo: (demo) => ({ ...demo, out: "link/result" }),
      symlinkPath: path.join("/run", "lanes", "all-assertledger", "assertledger-demo", "link") },
    { mutateDemo: (demo) => ({ ...demo, out: "link/result" }), danglingLink: true,
      symlinkPath: path.join("/run", "lanes", "all-assertledger", "assertledger-demo", "link") },
    { redirectedRoot: true },
    { mutateGitOutput: "ls-tree" },
  ]) {
    const result = await execute(options);
    expect(result.error).toBeTruthy();
    expect(result.checks).toBe(0);
  }
  for (const mutateAsset of [
    "dist/engine/setup.js",
    "examples/git-history/create-demo.mjs",
    "examples/git-history/escape-string-regexp/before.cjs.txt",
    "examples/git-history/escape-string-regexp/fixed.cjs.txt",
    "examples/git-history/escape-string-regexp/LICENSE",
    "examples/git-history/escape-string-regexp/provenance.json",
  ]) {
    const result = await execute({ mutateAsset });
    expect(result.error, mutateAsset).toBeTruthy();
    expect(result.checks, mutateAsset).toBe(0);
  }
});

test("reviewed demo Git identities match the authentic creator output", () => {
  const parent = mkdtempSync(join(tmpdir(), "devkit-assertledger-demo-git-"));
  const repository = join(parent, "fixture");
  const creator = fileURLToPath(new URL(
    "./fixtures/assertledger-assets/1.3.0/examples/git-history/create-demo.mjs", import.meta.url,
  ));
  const created = Bun.spawnSync({ cmd: [process.execPath, creator, repository] });
  expect(created.exitCode).toBe(0);
  const demo = JSON.parse(created.stdout.toString());
  expect({ before: demo.before, after: demo.after, neutral: demo.neutral }).toEqual({
    before: "be437c0ce8b155277f87d38c6519da85663a0890",
    after: "3c46e97e26f497f7a3adcf2c209283fd424e42ca",
    neutral: "6c703f810069afafdbe7562d454b26a7ae974557",
  });
  const git = (args) => {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: repository });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  expect(git(["rev-list", "--parents", "-n", "1", demo.after])).toBe(`${demo.after} ${demo.before}`);
  expect(git(["rev-list", "--parents", "-n", "1", demo.neutral])).toBe(`${demo.neutral} ${demo.after}`);
  expect(git(["rev-parse", `${demo.before}^{tree}`])).toBe("c9ba3febfbba5eceef294ad8949010c74b5cf21e");
  expect(git(["rev-parse", `${demo.after}^{tree}`])).toBe("878b78912efdeb0689bfac7c9fa80c08687d295f");
  expect(git(["rev-parse", `${demo.neutral}^{tree}`])).toBe("786fceacda932497b07e9ddbfaabfd089bb5a27a");
  expect(git(["rev-parse", `${demo.before}:subject.cjs`])).toBe("58217a4efa3c835c532499a3dad887017dc70a6b");
  expect(git(["rev-parse", `${demo.after}:subject.cjs`])).toBe("e5bb9db7933b7230327c7d99cc8459575f090dd4");
  expect(git(["rev-parse", `${demo.neutral}:README.md`])).toBe("23fe9073fbb13f2134086b91f110a0cacfdbb66e");
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
    path: "../escape", kind: "file", mode: 0o644, bytes: -1, sha256: "invalid", device: "1", inode: "6",
  });
  malformedChild[0].evidence[0].protectedSnapshot.after = structuredClone(
    malformedChild[0].evidence[0].protectedSnapshot.before,
  );
  const missingChildIdentity = structuredClone(validResults);
  delete missingChildIdentity[0].evidence[0].protectedSnapshot.before.repository[1].device;
  missingChildIdentity[0].evidence[0].protectedSnapshot.after = structuredClone(
    missingChildIdentity[0].evidence[0].protectedSnapshot.before,
  );
  const noncanonicalIdentity = structuredClone(validResults);
  noncanonicalIdentity[0].evidence[0].protectedSnapshot.before.repository[1].device = 1;
  noncanonicalIdentity[0].evidence[0].protectedSnapshot.after = structuredClone(
    noncanonicalIdentity[0].evidence[0].protectedSnapshot.before,
  );
  const linkWithoutMode = structuredClone(validResults);
  linkWithoutMode[0].evidence[0].protectedSnapshot.before.repository.push({
    path: "same-link", kind: "symlink", target: "same-target", device: "1", inode: "7",
  });
  linkWithoutMode[0].evidence[0].protectedSnapshot.after = structuredClone(
    linkWithoutMode[0].evidence[0].protectedSnapshot.before,
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
    labelOnly, missingReport, malformedReport, incompleteSnapshot, rootOnly, malformedChild, missingChildIdentity, noncanonicalIdentity,
    linkWithoutMode, duplicateRoot,
    duplicateApply, forgedValidation, missingDemoReport, invalidDemoReport, contradictoryDemo,
  })) {
    const attempted = executeSuffix(suffix, async (options) => {
      // Populate the real outer capture context before substituting result evidence; otherwise
      // every negative could fail at a missing baseline rather than its mutated boundary.
      await runNativeLaneMatrix(options);
      return results;
    });
    await expect(attempted, name).rejects.toThrow(name === "noncanonicalIdentity" ? /identity is invalid/u : undefined);
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

test("native snapshots detect child inode replacement with unchanged bytes modes and targets", () => {
  const makeIo = (changedKind = null) => ({
    lstatSync(value, options) {
      expect(options).toEqual({ bigint: true });
      const name = path.basename(value);
      const kind = value === "/fixture" ? "root" : name === "dir" ? "directory" : name;
      const baseInode = { root: 1n, directory: 10n, file: 11n, link: 12n }[kind];
      const inode = changedKind === kind ? baseInode + 100n : baseInode;
      return {
        mode: { root: 0o040755n, directory: 0o040755n, file: 0o100644n, link: 0o120777n }[kind],
        dev: 7n, ino: inode, size: kind === "file" ? 7n : 0n,
        isDirectory: () => ["root", "directory"].includes(kind), isFile: () => kind === "file", isSymbolicLink: () => kind === "link",
      };
    },
    readdirSync(value) { return value === "/fixture" ? ["dir", "file", "link"] : []; },
    readFileSync() { return Buffer.from("fixture"); },
    readlinkSync() { return "same-target"; },
  });
  const before = { source: snapshotTree("/fixture", makeIo()) };
  for (const kind of ["directory", "file", "link"]) {
    expect(diffSnapshots(before, { source: snapshotTree("/fixture", makeIo(kind)) }), kind).not.toEqual([]);
  }
  const contentChanged = makeIo();
  contentChanged.readFileSync = () => Buffer.from("changed");
  expect(diffSnapshots(before, { source: snapshotTree("/fixture", contentChanged) })).not.toEqual([]);
  const modeChanged = makeIo();
  const nativeStat = modeChanged.lstatSync;
  modeChanged.lstatSync = (value, options) => {
    const stat = nativeStat(value, options);
    if (path.basename(value) === "file") stat.mode = 0o100600n;
    return stat;
  };
  expect(diffSnapshots(before, { source: snapshotTree("/fixture", modeChanged) })).not.toEqual([]);
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
