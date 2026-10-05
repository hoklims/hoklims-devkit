import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execute, parseArgs, quoteShellToken } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-E-recovery/src/app.js";
import { createRuntime, validateState } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-E-recovery/src/runtime.js";

function compassInstallReport(argv, { installed = false, configured = false } = {}) {
  const host = argv[argv.indexOf("--host") + 1];
  const hostRoot = join(homedir(), `.${host}`);
  return {
    schema_version: 1, operation: "install", version: "0.3.0", project_root: "/repo", dry_run: argv.includes("--dry-run"),
    hosts: [host], files: [
      { path: join(hostRoot, "latent-compass-shadow", "runtime", "latent-compass-shadow-hook.py"), action: "unchanged" },
      { path: join(hostRoot, host === "codex" ? "hooks.json" : "settings.json"), action: "unchanged" },
      { path: join(hostRoot, "latent-compass-shadow", "config.json"), action: "unchanged" },
      { path: join(hostRoot, "latent-compass-shadow", "ownership.json"), action: "unchanged" },
    ],
    conflicts: [], states: { [host]: { installed, configured } },
  };
}

function semctxSetupPlan() {
  return {
    schemaVersion: 1, kind: "setup_plan", verdict: "SETUP_PLANNED", repositoryRoot: "/repo",
    config: { action: "create" }, semantic: { files: [] }, plannedChanges: [],
    index: { status: "not-run", reason: "dry-run" }, analysisReady: "unknown", setupReady: "unknown",
  };
}

function assertSetupReport(argv, status, mode) {
  const client = argv[argv.indexOf("--client") + 1];
  const artifactState = status === "CREATED" ? "CREATED" : status === "UNCHANGED" ? "UNCHANGED"
    : status === "CONFLICT" ? "CONFLICT" : "WOULD_CREATE";
  return {
    status, client, mode,
    init: { status: mode === "write" ? status : status === "UNCHANGED" ? "UNCHANGED" : "WOULD_CREATE", requiredOperatorInputs: [] },
    connection: { client, status: mode === "write" ? status : "EMITTED" },
    artifacts: [
      { owner: "init", path: "/repo/assertledger.config.json", state: artifactState },
      { owner: "init", path: "/repo/assertledger.lock.json", state: artifactState },
      { owner: "connection", path: client === "codex" ? "/repo/.codex/config.toml" : "/repo/.mcp.json", state: artifactState },
      { owner: "connection", path: client === "codex" ? "/repo/.agents/skills/assertledger/SKILL.md" : "/repo/.claude/skills/assertledger/SKILL.md", state: artifactState },
    ],
    rollback: { status: "NOT_REQUIRED", removed: [], unresolved: [] },
  };
}

function fakeRuntime({ version = "0.3.4", stable = version, setup = semctxSetupPlan(), setupReady = true, workspaceReady = false, state = null, files = {}, tools = [], failAssertInstall = false, failPyPi = false, uvInstalled = true, assertStatus = "UNCHANGED", compassStatus = "NO_OBSERVATIONS", semctxStatusCode = 3, semctxStatusMalformed = false, semctxMissing = false, semctxContentDrift = false, semctxMarketplaceMatch = true, installedSemctxVersion } = {}) {
  const calls = [];
  const writes = [];
  let semctxInstalledVersion = semctxMissing ? null : installedSemctxVersion ?? state?.components?.semctx?.version ?? null;
  const rt = {
    calls,
    writes,
    which: (name) => ["bun", "bunx", "codex", ...tools].includes(name) ? `/bin/${name}` : null,
    resolve: () => "/repo",
    realpath: (path) => path,
    statePath: () => "/state/repo.json",
    readState: () => state,
    writeState: (_path, value) => { writes.push(structuredClone(value)); state = structuredClone(value); },
    acquireLock: () => () => {},
    fetchJson: async (url) => {
      if (url.includes("raw.githubusercontent.com")) return { version: stable };
      if (url.includes("pypi.org")) {
        if (failPyPi) throw new Error("PyPI offline");
        return { info: { version: "0.3.0" } };
      }
      return { version: url.includes("assertledger") ? "1.2.0" : version };
    },
    exec: async (argv) => {
      calls.push(argv);
      if (argv[0] === "bun") return { code: 0, stdout: "1.4.0\n", stderr: "" };
      if (argv[0] === "node" && argv.includes("setup")) {
        const write = argv.includes("--write");
        return { code: assertStatus === "CONFLICT" ? 4 : 0, stdout: JSON.stringify(assertSetupReport(argv, write ? "CREATED" : assertStatus, write ? "write" : "dry-run")), stderr: "" };
      }
      if (argv[0] === "node") return { code: 0, stdout: "v22.15.0\n", stderr: "" };
      if (argv[0] === "git") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (argv[0] === "uv" && argv.includes("dir")) return { code: 0, stdout: "/uvbin\n", stderr: "" };
      if (argv[0] === "uv" && argv.includes("list")) return { code: 0, stdout: uvInstalled ? "latent-compass v0.3.0\n" : "", stderr: uvInstalled ? "" : "No tools installed\n" };
      if (argv[0] === "uv" && argv.includes("run")) return { code: 0, stdout: JSON.stringify(compassInstallReport(argv)), stderr: "" };
      if (argv[0] === join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass") && argv.includes("--version")) return { code: 0, stdout: "latent-compass 0.3.0\n", stderr: "" };
      if (argv[0] === join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass") && argv.includes("status")) return { code: 0, stdout: JSON.stringify({ schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo", hosts: [{ host: "codex", status: compassStatus }], states: { codex: { installed: true, configured: compassStatus === "NO_OBSERVATIONS", observed: false } } }), stderr: "" };
      if (argv[0] === "npm" && argv.includes("exec")) return { code: 0, stdout: JSON.stringify(assertSetupReport(argv, "WOULD_CREATE", "dry-run")), stderr: "" };
      const assertSpec = argv.find((arg) => /^assertledger@/u.test(arg));
      if (assertSpec && ((argv[0] === "npm" && argv.includes("install"))
        || (argv[0] === "pnpm" && argv.includes("add")) || (argv[0] === "bun" && argv.includes("add")))) {
        if (!failAssertInstall) {
          const manifestPath = join("/repo", "package.json");
          const manifest = JSON.parse(files[manifestPath]);
          const installedVersion = assertSpec.slice("assertledger@".length);
          for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            if (manifest[group]) delete manifest[group].assertledger;
          }
          manifest.devDependencies = { ...(manifest.devDependencies ?? {}), assertledger: installedVersion };
          files[manifestPath] = JSON.stringify(manifest);
          files[join("/repo", "node_modules", "assertledger", "package.json")] = JSON.stringify({ version: installedVersion });
          files[join("/repo", "node_modules", "assertledger", "dist", "cli.js")] = "cli";
        }
        return { code: failAssertInstall ? 5 : 0, stdout: "", stderr: failAssertInstall ? "package install failed" : "" };
      }
      if (argv.includes("plugin-status")) {
        return {
          code: semctxInstalledVersion && semctxStatusCode === 3 ? 0 : semctxStatusCode,
          stdout: JSON.stringify(semctxStatusMalformed ? { hosts: {} } : {
            schemaVersion: 2,
            kind: "plugin_delivery_status",
            hosts: {
              codex: { requested: true, installed: { version: semctxInstalledVersion, contentMatchesSnapshot: semctxInstalledVersion ? !semctxContentDrift : null }, marketplace: { matchesSemctx: Boolean(semctxInstalledVersion) && semctxMarketplaceMatch } },
              claude: { requested: true, installed: { version: semctxInstalledVersion, contentMatchesSnapshot: semctxInstalledVersion ? !semctxContentDrift : null }, marketplace: { matchesSemctx: Boolean(semctxInstalledVersion) && semctxMarketplaceMatch } },
            },
          }),
          stderr: "",
        };
      }
      if (argv.includes("setup") && argv.includes("--dry-run")) {
        return { code: setup.kind === "setup_plan" ? 0 : 4, stdout: JSON.stringify(setup), stderr: "" };
      }
      if (argv.includes("doctor")) return { code: workspaceReady ? 0 : 1, stdout: JSON.stringify(workspaceReady ? {
        healthy: true, version: argv[1]?.split("@").at(-1) ?? version,
        checks: ["cli", "workspace", "config", "index", "runtime"].map((name) => ({ name, ok: true, ...(name === "index" ? { status: "healthy" } : {}) })),
      } : {
        healthy: false, version: argv[1]?.split("@").at(-1) ?? version,
        checks: ["cli", "workspace", "config", "index", "runtime"].map((name) => ({ name, ok: name !== "workspace", ...(name === "index" ? { status: "healthy" } : {}) })),
      }), stderr: "" };
      if (argv.includes("index-health")) return workspaceReady
        ? { code: 0, stdout: JSON.stringify({ schemaVersion: 1, kind: "index_health", binding: { status: "valid" }, freshness: { canRunHighRiskControl: true }, coverage: { status: "complete" } }), stderr: "" }
        : { code: 2, stdout: JSON.stringify({ schemaVersion: 1, kind: "index_health", binding: { status: "absent" }, freshness: { canRunHighRiskControl: false }, coverage: { status: "partial" } }), stderr: "" };
      if (argv.includes("install")) {
        if (!argv.includes("--dry-run")) semctxInstalledVersion = version;
        const dryRun = argv.includes("--dry-run");
        const selection = argv[argv.indexOf("--host") + 1];
        return { code: 0, stdout: JSON.stringify({
          ok: true, version, dryRun, selection,
          hosts: {
            codex: { requested: ["codex", "all"].includes(selection), detected: true, status: dryRun ? "planned" : "installed" },
            claude: { requested: ["claude", "all"].includes(selection), detected: true, status: dryRun ? "planned" : "installed" },
          },
          workspace: { status: "skipped", root: "/repo" },
        }), stderr: "" };
      }
      if (argv.includes("setup")) return { code: setupReady ? 0 : 1, stdout: JSON.stringify({
        schemaVersion: 1, kind: "setup", repositoryRoot: "/repo",
        verdict: setupReady ? "SETUP_READY" : "SETUP_NOT_READY", setupReady, analysisReady: setupReady,
        check: { ok: setupReady },
      }), stderr: "" };
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    },
    exists: (path) => Object.hasOwn(files, path),
    pathPresent: (path) => Object.hasOwn(files, path),
    plainFilePresent: (path) => Object.hasOwn(files, path),
    directoryPresent: (path) => Object.keys(files).some((candidate) => candidate.startsWith(`${path}${process.platform === "win32" ? "\\" : "/"}`)),
    readText: (path) => files[path],
    readPlainText: (path) => files[path],
    join: (...parts) => parts.join("/"),
  };
  return rt;
}

const setupOptions = () => parseArgs(["setup", "/repo", "--host", "codex"]);

test("probe N4: STATE_CHANGED guidance output", async () => {
  const lockedState = {
    schemaVersion: 1, projectRoot: "/repo",
    components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
    inProgress: { command: "upgrade", selected: ["semctx", "assertledger"], hosts: ["codex"], versions: { semctx: "0.3.5", assertledger: "1.3.0" } },
  };
  const rt = fakeRuntime({ tools: ["node", "npm"], files: {
    [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager: "npm@10.9.8" }),
    [join("/repo", "package-lock.json")]: "{}",
  } });
  let reads = 0;
  rt.readState = () => ++reads === 1 ? null : structuredClone(lockedState);
  rt.acquireLock = () => () => {};
  const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
  console.log("N4OUT " + JSON.stringify({ conflicts: report.conflicts, nextActions: report.nextActions }));
});

test("probe U5: transaction write ownership loss after pending plan persisted", async () => {
  const rt = fakeRuntime({ tools: [] });
  let writes = 0;
  rt.acquireLock = () => () => {};
  rt.openStateTransaction = () => ({
    state: null,
    write: (value) => { if (++writes > 1) throw Object.assign(new Error("Managed state file ownership changed"), { code: "STATE_CONFLICT" }); rt.writes.push(structuredClone(value)); },
    close: () => {},
  });
  const report = await execute(setupOptions(), rt);
  const guidance = [...report.nextActions, ...report.conflicts.map((c) => c.detail)].join("\n");
  console.log("U5OUT " + JSON.stringify({ codes: report.conflicts.map((c) => c.code), guidance }));
  expect(report.conflicts.map((c) => c.code)).toContain("STATE_CONFLICT");
  expect(guidance).toContain("inspect and validate the saved Devkit state");
  expect(guidance).not.toContain("complete the recorded plan");
});
