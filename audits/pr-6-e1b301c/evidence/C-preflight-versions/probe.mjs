// Probe (not a test edit): reuses a verbatim copy of test/app.test.js lines 8-159 (fixtures) to exercise scenarios with no test coverage.
import { join } from "node:path";
import { homedir } from "node:os";
import { execute, parseArgs } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-C-preflight-versions/src/app.js";
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
const assertFiles = (declared = "1.2.0", local = declared) => ({
  [join("/repo", "package.json")]: JSON.stringify({ devDependencies: { assertledger: declared }, packageManager: "npm@10.9.8" }),
  [join("/repo", "package-lock.json")]: "{}",
  [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: local }),
  [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
});
const summary = (report, rt) => ({
  ok: report.ok,
  codes: report.conflicts.map((c) => c.code),
  versions: Object.fromEntries(report.components.map((c) => [c.name, c.version])),
  stateWrites: rt.writes.length,
  nonDryRunNative: rt.calls.filter((a) => (a.includes("install") || a.includes("add") || a.includes("--write") || (a.includes("setup") && a[0] === "bunx")) && !a.includes("--dry-run")).map((a) => a.slice(0, 4).join(" ")),
});
const scenarios = {
  // --host all, AssertLedger native preview conflicts only for the second host (claude-code)
  S1_assert_second_host_conflict: async () => {
    const rt = fakeRuntime({ tools: ["node", "npm", "claude"], files: assertFiles() });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => {
      const r = await exec(argv, cwd, t);
      if (argv[0] === "node" && argv.includes("--dry-run") && argv.includes("claude-code")) {
        const j = JSON.parse(r.stdout); j.status = "CONFLICT"; return { ...r, code: 4, stdout: JSON.stringify(j) };
      }
      return r;
    };
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "all", "--with", "assertledger"]), rt), rt);
  },
  // --host all, Compass preview invalid only for claude
  S2_compass_second_host_conflict: async () => {
    const rt = fakeRuntime({ tools: ["uv", "claude"], uvInstalled: false });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => argv[0] === "uv" && argv.includes("run") && argv.includes("claude")
      ? { code: 0, stdout: JSON.stringify({ ...compassInstallReport(argv), project_root: "/other" }), stderr: "" } : exec(argv, cwd, t);
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "all", "--with", "latent-compass"]), rt), rt);
  },
  // --host all, Semctx plugin bytes drifted only on claude
  S3_semctx_second_host_drift: async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex", "claude"] } } };
    const rt = fakeRuntime({ state, tools: ["claude"] });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => {
      const r = await exec(argv, cwd, t);
      if (!argv.includes("plugin-status")) return r;
      const j = JSON.parse(r.stdout); j.hosts.claude.installed.contentMatchesSnapshot = false; return { ...r, stdout: JSON.stringify(j) };
    };
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "all"]), rt), rt);
  },
  // all three components; only latent-compass (3rd) preview conflicts
  S4_third_component_conflict: async () => {
    const rt = fakeRuntime({ tools: ["node", "npm", "uv"], uvInstalled: false, files: assertFiles() });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => argv[0] === "uv" && argv.includes("run")
      ? { code: 0, stdout: JSON.stringify({ ...compassInstallReport(argv), project_root: "/other" }), stderr: "" } : exec(argv, cwd, t);
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "codex", "--with", "assertledger,latent-compass"]), rt), rt);
  },
  // unmanaged repo: Semctx plugin already installed at 0.3.4, npm stable is 0.3.5; setup must not bump
  S5_setup_existing_semctx_other_version: async () => {
    const rt = fakeRuntime({ version: "0.3.5", stable: "0.3.5", installedSemctxVersion: "0.3.4" });
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "codex"]), rt), rt);
  },
  // unmanaged repo: AssertLedger declared+installed at 1.1.0, registry latest 1.2.0; setup must keep 1.1.0
  S6_setup_existing_assert_other_version: async () => {
    const rt = fakeRuntime({ tools: ["node", "npm"], files: assertFiles("1.1.0") });
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "codex", "--with", "assertledger", "--dry-run"]), rt), rt);
  },
  // unmanaged repo: uv has latent-compass 0.2.0, PyPI latest 0.3.0; setup must keep 0.2.0
  S7_setup_existing_compass_other_version: async () => {
    const rt = fakeRuntime({ tools: ["uv"] });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => argv[0] === "uv" && argv.includes("list")
      ? { code: 0, stdout: "latent-compass v0.2.0\n", stderr: "" } : exec(argv, cwd, t);
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "codex", "--with", "latent-compass", "--dry-run"]), rt), rt);
  },
  // managed repo, registry offline: setup with a recorded version should not need the registry
  S8_setup_recorded_registry_offline: async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    rt.fetchJson = async () => { throw new Error("registry offline"); };
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "codex", "--dry-run"]), rt), rt);
  },
  // Compass apply: native install+status report installed=true but configured=false (recognizable status)
  S9_compass_apply_installed_not_configured: async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => {
      if (argv[0] === executable && argv.includes("install")) return { code: 0, stdout: JSON.stringify(compassInstallReport(argv, { installed: true, configured: false })), stderr: "" };
      if (argv[0] === executable && argv.includes("status")) return { code: 0, stdout: JSON.stringify({ schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo", hosts: [{ host: "codex", status: "NO_OBSERVATIONS" }], states: { codex: { installed: true, configured: false, observed: false } } }), stderr: "" };
      return exec(argv, cwd, t);
    };
    const report = await execute(parseArgs(["setup", "/repo", "--host", "codex", "--with", "latent-compass"]), rt);
    return { ...summary(report, rt), compass: report.components.find((c) => c.name === "latent-compass") };
  },
  // Compass doctor: status OBSERVING, installed=true, configured=false
  S10_compass_doctor_installed_not_configured: async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
    const exec = rt.exec;
    rt.exec = async (argv, cwd, t) => argv[0] === executable && argv.includes("status")
      ? { code: 0, stdout: JSON.stringify({ schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo", hosts: [{ host: "codex", status: "OBSERVING" }], states: { codex: { installed: true, configured: false, observed: true } } }), stderr: "" }
      : exec(argv, cwd, t);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    return { ok: report.ok, compass: report.components.find((c) => c.name === "latent-compass") };
  },
  // Replica of test "global preflight rechecks AssertLedger tools after later component previews" (app.test.js:1564) WITHOUT removing npm:
  // shows the fixture's Compass preview conflicts on its own, so that test's no-write assertions do not isolate the tool recheck.
  S11_replica_1564_without_tool_loss: async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const files = {
      [join("/repo", "package.json")]: JSON.stringify({ dependencies: { assertledger: "1.2.0" }, packageManager: "pnpm@10.0.0" }),
      [join("/repo", "pnpm-lock.yaml")]: "lockfileVersion: 9",
      [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: "1.2.0" }),
      [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
      [executable]: "shim",
    };
    const rt = fakeRuntime({ tools: ["node", "npm", "pnpm", "uv"], files });
    return summary(await execute(parseArgs(["setup", "/repo", "--host", "codex", "--with", "assertledger,latent-compass"]), rt), rt);
  },
};
const only = process.argv.slice(2);
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length && !only.some((prefix) => name.startsWith(prefix))) continue;
  try { console.log(name, JSON.stringify(await run())); } catch (e) { console.log(name, "THREW", e.message); }
}
