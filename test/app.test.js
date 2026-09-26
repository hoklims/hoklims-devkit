import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { execute, parseArgs, quoteShellToken } from "../src/app.js";

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
      if (argv[0] === "npm" && argv.includes("install")) return { code: failAssertInstall ? 5 : 0, stdout: "", stderr: failAssertInstall ? "package install failed" : "" };
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
      if (argv.includes("doctor")) return { code: 0, stdout: JSON.stringify(workspaceReady ? {
        healthy: true, version,
        checks: ["cli", "workspace", "config", "index", "runtime"].map((name) => ({ name, ok: true, ...(name === "index" ? { status: "healthy" } : {}) })),
      } : { ok: true }), stderr: "" };
      if (argv.includes("index-health")) return workspaceReady
        ? { code: 0, stdout: JSON.stringify({ schemaVersion: 1, kind: "index_health", binding: { status: "valid" }, freshness: { canRunHighRiskControl: true }, coverage: { status: "complete" } }), stderr: "" }
        : { code: 2, stdout: JSON.stringify({ coverage: { status: "partial" } }), stderr: "" };
      if (argv.includes("install")) {
        if (!argv.includes("--dry-run")) semctxInstalledVersion = version;
        return { code: 0, stdout: JSON.stringify({
          ok: true, version, dryRun: argv.includes("--dry-run"), selection: argv[argv.indexOf("--host") + 1],
          hosts: {
            codex: { requested: true, detected: true, status: "planned" },
            claude: { requested: true, detected: true, status: "planned" },
          },
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
    readText: (path) => files[path],
    join: (...parts) => parts.join("/"),
  };
  return rt;
}

const setupOptions = () => parseArgs(["setup", "/repo", "--host", "codex"]);

describe("public CLI", () => {
  test("parses the default profile and rejects unrecognized components", () => {
    expect(setupOptions().with).toEqual([]);
    expect(parseArgs(["setup", ".", "--with", "assertledger,latent-compass"]).with).toEqual(["assertledger", "latent-compass"]);
    expect(() => parseArgs(["setup", ".", "--with", "unknown"])).toThrow();
    expect(() => parseArgs(["setup", ".", "--refresh-pending"])).toThrow();
  });

  test("blocks published Semctx 0.3.3 before invoking its unsafe dry-run", async () => {
    const rt = fakeRuntime({ version: "0.3.3" });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0].code).toBe("RELEASE_SKEW_OR_UNAVAILABLE");
    expect(rt.calls).toHaveLength(2);
    expect(rt.writes).toHaveLength(0);
  });

  test("dry-run performs every preflight without installation or state writes", async () => {
    const rt = fakeRuntime();
    const report = await execute({ ...setupOptions(), dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.components).toEqual([expect.objectContaining({ name: "semctx", state: "planned" })]);
    expect(rt.calls.some((args) => args.includes("install") && !args.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("every planned and applied component reports the five distinct states", async () => {
    const rt = fakeRuntime();
    const plan = await execute({ ...setupOptions(), dryRun: true }, rt);
    expect(plan.components[0]).toMatchObject({
      installed: "unknown", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown",
    });
    const applied = await execute(setupOptions(), rt);
    expect(applied.components[0]).toMatchObject({
      installed: "yes", configured: "yes", loaded: "unknown", approved: "unknown", observed: "unknown",
    });
  });

  test("Semctx plugin-status failure or incomplete host evidence blocks all writes", async () => {
    for (const settings of [{ semctxStatusCode: 5 }, { semctxStatusMalformed: true }]) {
      const rt = fakeRuntime(settings);
      const report = await execute(setupOptions(), rt);
      expect(report.ok).toBe(false);
      expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_STATUS_INVALID");
      expect(rt.calls.some((args) => args.includes("install") && !args.includes("--dry-run"))).toBe(false);
      expect(rt.writes).toHaveLength(0);
    }
  });

  test("a malformed Semctx installed version blocks before any write", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      const result = await nativeExec(argv, cwd);
      if (!argv.includes("plugin-status")) return result;
      const status = JSON.parse(result.stdout);
      status.hosts.codex.installed.version = "bad";
      return { ...result, stdout: JSON.stringify(status) };
    };
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_STATUS_INVALID");
    expect(rt.calls.some((argv) => argv.includes("setup") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("workspace conflict prevents any host installation", async () => {
    const rt = fakeRuntime({ setup: { kind: "setup_conflict", verdict: "SETUP_REFUSED", reason: "invalid-config" } });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_WORKSPACE_CONFLICT");
    expect(rt.calls.some((args) => args.includes("install") && !args.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("an incomplete Semctx workspace plan blocks all writes", async () => {
    const rt = fakeRuntime({ setup: { ...semctxSetupPlan(), index: undefined } });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_WORKSPACE_CONFLICT");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a Semctx host plan missing its selected host blocks all writes", async () => {
    const rt = fakeRuntime();
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("install") && argv.includes("--dry-run")
      ? { code: 0, stdout: JSON.stringify({ ok: true, version: "0.3.4", dryRun: true, selection: "codex", hosts: {} }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_HOST_CONFLICT");
    expect(rt.writes).toHaveLength(0);
  });

  test("a Semctx host plan naming another repository blocks all writes", async () => {
    const rt = fakeRuntime();
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      const result = await nativeExec(argv, cwd);
      if (!argv.includes("install") || !argv.includes("--dry-run")) return result;
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), repositoryRoot: "/other" }) };
    };
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_HOST_CONFLICT");
    expect(rt.writes).toHaveLength(0);
  });

  test("Semctx plugin status naming another repository blocks all writes", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      const result = await nativeExec(argv, cwd);
      if (!argv.includes("plugin-status")) return result;
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), repositoryRoot: "/other" }) };
    };
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_STATUS_INVALID");
    expect(rt.writes).toHaveLength(0);
  });

  test("successful setup records the exact installed version for resume", async () => {
    const rt = fakeRuntime();
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(true);
    expect(report.components[0].state).toBe("configured");
    expect(rt.writes).toHaveLength(3);
    expect(rt.writes[0].inProgress.versions.semctx).toBe("0.3.4");
    expect(rt.writes.at(-1).components.semctx).toEqual({ version: "0.3.4", hosts: ["codex"] });
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
    expect(report.components[0].loaded).toBe("unknown");
  });

  test("Semctx post-write refusal cannot be reported configured", async () => {
    const rt = fakeRuntime();
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("setup") && !argv.includes("--dry-run")
      ? { code: 0, stdout: JSON.stringify({
        schemaVersion: 1, kind: "setup", repositoryRoot: "/other",
        verdict: "SETUP_REFUSED", setupReady: true, analysisReady: true, check: { ok: true },
      }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0]).toMatchObject({ state: "partial", configured: "unknown" });
    expect(rt.writes.at(-1).inProgress).toBeDefined();
  });

  test("Semctx negative verdict remains unconfigured despite true readiness flags", async () => {
    const rt = fakeRuntime();
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("setup") && !argv.includes("--dry-run")
      ? { code: 0, stdout: JSON.stringify({
        schemaVersion: 1, kind: "setup", repositoryRoot: "/repo",
        verdict: "SETUP_NOT_READY", setupReady: true, analysisReady: true, check: { ok: false },
      }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0]).toMatchObject({ state: "needs-attention", configured: "unknown" });
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_NOT_READY");
  });

  test("setup keeps the recorded version; only upgrade resolves latest", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ version: "0.3.5", stable: "0.3.5", state });
    const report = await execute({ ...setupOptions(), dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.components[0].version).toBe("0.3.4");
    expect(rt.writes).toHaveLength(0);
    expect(rt.calls.some((args) => args.includes("install"))).toBe(false);
    const upgrade = await execute({ ...setupOptions(), command: "upgrade", dryRun: true }, rt);
    expect(upgrade.components[0].version).toBe("0.3.5");
  });

  test("adding a host cannot silently move an older Semctx install to current stable", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ version: "0.3.5", stable: "0.3.5", state, tools: ["claude"] });
    const report = await execute(parseArgs(["setup", "/repo", "--host", "all"]), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("RELEASE_SKEW_OR_UNAVAILABLE");
    expect(rt.calls.some((args) => args.includes("install"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("adding Codex to a Claude-only component persists canonical host order", async () => {
    const state = {
      schemaVersion: 1,
      projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["claude"] } },
    };
    const rt = fakeRuntime({ state });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(true);
    expect(rt.writes.at(-1).components.semctx.hosts).toEqual(["codex", "claude"]);
  });

  test("doctor keeps unobserved session and approval unknown", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0]).toEqual(expect.objectContaining({ installed: "yes", loaded: "unknown", approved: "unknown", observed: "unknown" }));
    expect(report.conflicts.map((item) => item.code)).toContain("DOCTOR_NOT_READY");
  });

  test("doctor keeps Semctx installation unknown without positive content attestation", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("plugin-status")
      ? { code: 3, stdout: JSON.stringify({ schemaVersion: 2, kind: "plugin_delivery_status", hosts: {
        codex: { requested: true, installed: { version: "0.3.4", contentMatchesSnapshot: null }, marketplace: { matchesSemctx: true } },
      } }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0]).toMatchObject({ installed: "unknown", approved: "unknown" });
  });

  test("doctor refuses zero-exit Semctx diagnostics with missing readiness fields", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("doctor") || argv.includes("index-health")
      ? { code: 0, stdout: "{}", stderr: "" } : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0].configured).toBe("unknown");
  });

  test("doctor rejects a Semctx diagnostic naming another repository", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, workspaceReady: true });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      const result = await nativeExec(argv, cwd);
      if (!argv.includes("doctor")) return result;
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), repositoryRoot: "/other" }) };
    };
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0].configured).toBe("unknown");
  });

  test("doctor preserves unknown configuration when native diagnostics are unavailable", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("doctor") || argv.includes("index-health")
      ? { code: 5, stdout: "", stderr: "simulated diagnostic outage" } : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0]).toMatchObject({ installed: "yes", configured: "unknown" });
  });

  test("doctor does not claim success when the tool was never configured", async () => {
    const rt = fakeRuntime();
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0].installed).toBe("unknown");
    expect(report.conflicts.map((item) => item.code)).toContain("DOCTOR_UNMANAGED");
  });

  test("doctor rejects AssertLedger native CONFLICT even when JSON is returned", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { assertledger: { version: "1.2.0", hosts: ["codex"] } } };
    const files = {
      [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: "1.2.0" }),
      [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
    };
    const rt = fakeRuntime({ state, files, assertStatus: "CONFLICT" });
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    const assertledger = report.components.find((item) => item.name === "assertledger");
    expect(assertledger.configured).toBe("no");
    expect(report.ok).toBe(false);
  });

  test("doctor does not infer AssertLedger configuration from empty artifacts", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { assertledger: { version: "1.2.0", hosts: ["codex"] } } };
    const files = {
      [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: "1.2.0" }),
      [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
    };
    const rt = fakeRuntime({ state, tools: ["node", "npm"], files });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "node" && argv.includes("setup")
      ? { code: 0, stdout: JSON.stringify({ ...assertSetupReport(argv, "UNCHANGED", "dry-run"), artifacts: [] }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "assertledger").configured).toBe("unknown");
  });

  test("doctor preserves unknown for unavailable optional native diagnostics", async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {
      assertledger: { version: "1.2.0", hosts: ["codex"] },
      "latent-compass": { version: "0.3.0", hosts: ["codex"] },
    } };
    const files = {
      [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: "1.2.0" }),
      [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
      [executable]: "shim",
    };
    const rt = fakeRuntime({ state, files, tools: ["uv", "node"] });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => (argv[0] === "node" && argv.includes("setup"))
      || (argv[0] === executable && argv.includes("status"))
      ? { code: 5, stdout: "", stderr: "simulated native outage" } : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "assertledger").configured).toBe("unknown");
    expect(report.components.find((item) => item.name === "latent-compass").configured).toBe("unknown");
  });

  test("doctor keeps Compass observation unknown when native status omits the evidence", async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, compassStatus: "OBSERVING" });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === executable && argv.includes("status")
      ? { code: 0, stdout: JSON.stringify({ schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo", hosts: [{ host: "codex", status: "OBSERVING" }], states: { codex: { installed: true, configured: true } } }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.components.find((item) => item.name === "latent-compass")).toMatchObject({ configured: "yes", observed: "unknown" });
  });

  test("doctor accepts configured Compass status when Windows observation enumeration is unavailable", async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {
      semctx: { version: "0.3.4", hosts: ["codex"] },
      "latent-compass": { version: "0.3.0", hosts: ["codex"] },
    } };
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, workspaceReady: true });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === executable && argv.includes("status")
      ? { code: 0, stdout: JSON.stringify({
        schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo",
        hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
        states: { codex: { installed: true, configured: true, observed: "UNKNOWN" } },
      }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(true);
    expect(report.components.find((item) => item.name === "latent-compass")).toMatchObject({ configured: "yes", observed: "unknown" });
  });

  test("doctor rejects inconsistent or foreign observation-unknown Compass reports", async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const reports = [
      { hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }], states: { codex: { installed: true, configured: true, observed: "UNKNOWN" } } },
      {
        schema_version: 1, operation: "status", version: "0.3.0", project_root: "/foreign",
        hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
        states: { codex: { installed: true, configured: true, observed: "UNKNOWN" } },
      },
      {
        schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo",
        hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
        states: { codex: { installed: true, configured: true, observed: true } },
      },
      {
        schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo",
        hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
        states: { codex: { installed: true, configured: true, observed: false } },
      },
      {
        schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo",
        hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
        states: { codex: { installed: true, configured: true } },
      },
    ];
    for (const nativeReport of reports) {
      const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
      const nativeExec = rt.exec;
      rt.exec = async (argv, cwd) => argv[0] === executable && argv.includes("status")
        ? { code: 0, stdout: JSON.stringify(nativeReport), stderr: "" }
        : nativeExec(argv, cwd);
      const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
      expect(report.ok).toBe(false);
      expect(report.components.find((item) => item.name === "latent-compass")).toMatchObject({ configured: "unknown", observed: "unknown" });
      expect(report.conflicts.map((item) => item.code)).toContain("DOCTOR_NOT_READY");
    }
  });

  test("doctor rejects Compass host flags without status identity", async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === executable && argv.includes("status")
      ? { code: 0, stdout: JSON.stringify({ hosts: [{ host: "codex", status: "NO_OBSERVATIONS" }], states: { codex: { installed: true, configured: true } } }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "latent-compass").configured).toBe("unknown");
  });

  test("doctor rejects a rendered but unconfigured Latent Compass status", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, compassStatus: "DEGRADED" });
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    const compass = report.components.find((item) => item.name === "latent-compass");
    expect(compass.configured).toBe("no");
    expect(compass.observed).toBe("unknown");
    expect(report.ok).toBe(false);
  });

  test("malformed saved state blocks before running any native installer", async () => {
    const rt = fakeRuntime({ state: { schemaVersion: 1, projectRoot: "/repo", components: [] } });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
    expect(rt.calls.some((args) => args.includes("setup") || args.includes("install"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("repeating a completed setup does not rewrite devkit state", async () => {
    const rt = fakeRuntime({ setup: semctxSetupPlan(), workspaceReady: true });
    expect((await execute(setupOptions(), rt)).ok).toBe(true);
    const writes = rt.writes.length;
    const setupCalls = rt.calls.filter((argv) => argv.includes("setup") && !argv.includes("--dry-run")).length;
    expect((await execute(setupOptions(), rt)).ok).toBe(true);
    expect(rt.writes).toHaveLength(writes);
    expect(rt.calls.filter((argv) => argv.includes("setup") && !argv.includes("--dry-run"))).toHaveLength(setupCalls);
  });

  test("release skew prevents writes", async () => {
    const rt = fakeRuntime({ version: "0.3.4", stable: "0.3.5" });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0].code).toBe("RELEASE_SKEW_OR_UNAVAILABLE");
    expect(rt.writes).toHaveLength(0);
  });

  test("optional package-manager conflict blocks Semctx application too", async () => {
    const rt = fakeRuntime({
      tools: ["node", "npm", "pnpm"],
      files: {
        [join("/repo", "package.json")]: JSON.stringify({ name: "fixture" }),
        [join("/repo", "package-lock.json")]: "{}",
        [join("/repo", "pnpm-lock.yaml")]: "lockfileVersion: 9",
      },
    });
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    expect(report.conflicts.map((item) => item.code)).toContain("PACKAGE_MANAGER_CONFLICT");
    expect(rt.calls.some((args) => args.includes("install") && !args.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("malformed packageManager declarations block before state writes", async () => {
    for (const packageManager of [
      7, null, false, { name: "npm" },
      "npm@", "npm@latest", "npm@^10", "npm@10.9",
      "npm@01.2.3", "npm@1.2.3-..", "npm@1.2.3+sha512.a",
      "npm@https://example.com/npm.zip",
      "npm@https://example.com/npm.tgz#sha512.a",
    ]) {
      const rt = fakeRuntime({
        tools: ["node", "npm"],
        files: { [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager }) },
      });
      const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
      expect(report.ok).toBe(false);
      expect(report.conflicts.map((item) => item.code)).toContain("PACKAGE_MANAGER_CONFLICT");
      expect(report.conflicts.map((item) => item.detail).join("\n")).toMatch(/packageManager must be a string/u);
      expect(rt.writes).toHaveLength(0);
    }
  });

  test("valid packageManager declarations retain supported manager selection", async () => {
    for (const packageManager of [
      "npm@10.9.8",
      `npm@10.9.8+sha512.${"ab".repeat(64)}`,
      "npm@10.9.8-rc.1",
      "pnpm@10.0.0",
      `pnpm@https://registry.npmjs.org/pnpm/-/pnpm-10.0.0.tgz#sha224.${"ab".repeat(28)}`,
      "bun@1.4.2",
    ]) {
      const manager = packageManager.split("@")[0];
      const rt = fakeRuntime({
        tools: ["node", "npm", manager],
        files: { [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager }) },
      });
      const report = await execute({ ...setupOptions(), with: ["assertledger"], dryRun: true }, rt);
      expect(report.ok).toBe(true);
      expect(report.plannedChanges.find((item) => item.component === "assertledger").packageManager).toBe(manager);
      expect(rt.writes).toHaveLength(0);
    }
  });

  test("AssertLedger preview cannot plan artifacts for another repository or client", async () => {
    const rt = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({ name: "fixture" }) },
    });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "npm" && argv.includes("exec")
      ? { code: 0, stdout: JSON.stringify({
        ...assertSetupReport(argv, "WOULD_CREATE", "dry-run"),
        artifacts: [
          { owner: "init", path: "/other/assertledger.config.json", state: "WOULD_CREATE" },
          { owner: "init", path: "/other/assertledger.lock.json", state: "WOULD_CREATE" },
          { owner: "connection", path: "/other/.mcp.json", state: "WOULD_CREATE" },
          { owner: "connection", path: "/other/.claude/skills/assertledger/SKILL.md", state: "WOULD_CREATE" },
        ],
      }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("ASSERTLEDGER_CONFLICT");
    expect(rt.writes).toHaveLength(0);
  });

  test("a declared AssertLedger version without installed executable still plans installation", async () => {
    const rt = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({ devDependencies: { assertledger: "1.2.0" } }) },
    });
    const report = await execute({ ...setupOptions(), with: ["assertledger"], dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.plannedChanges.find((item) => item.component === "assertledger").installPackage).toBe(true);
    expect(rt.writes).toHaveLength(0);
  });

  test("matching AssertLedger declarations resolve to their shared exact version", async () => {
    const rt = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({
        dependencies: { assertledger: "1.2.0" },
        devDependencies: { assertledger: "1.2.0" },
      }) },
    });
    const report = await execute({ ...setupOptions(), with: ["assertledger"], dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.components.find((item) => item.name === "assertledger").version).toBe("1.2.0");
    expect(rt.writes).toHaveLength(0);
  });

  test("conflicting AssertLedger declarations block every write", async () => {
    const rt = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({
        dependencies: { assertledger: "1.3.0" },
        devDependencies: { assertledger: "1.2.0" },
      }) },
    });
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(report.conflicts.map((item) => item.detail).join("\n")).toMatch(/Conflicting AssertLedger dependency declarations/u);
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);

    const constraintMismatch = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({
        dependencies: { assertledger: "^1.2.0" },
        devDependencies: { assertledger: "1.2.0" },
      }) },
    });
    const rejectedConstraint = await execute({ ...setupOptions(), with: ["assertledger"] }, constraintMismatch);
    expect(rejectedConstraint.ok).toBe(false);
    expect(rejectedConstraint.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(rejectedConstraint.conflicts.map((item) => item.detail).join("\n")).toMatch(/must be pinned exactly/u);
    expect(constraintMismatch.writes).toHaveLength(0);
  });

  test("AssertLedger declarations in optional and peer dependency groups are validated", async () => {
    const matching = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({
        optionalDependencies: { assertledger: "1.2.0" },
        peerDependencies: { assertledger: "1.2.0" },
      }) },
    });
    const accepted = await execute({ ...setupOptions(), with: ["assertledger"], dryRun: true }, matching);
    expect(accepted.ok).toBe(true);
    expect(accepted.components.find((item) => item.name === "assertledger").version).toBe("1.2.0");

    const conflicting = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({
        optionalDependencies: { assertledger: "1.2.0" },
        peerDependencies: { assertledger: "1.3.0" },
      }) },
    });
    const rejected = await execute({ ...setupOptions(), with: ["assertledger"] }, conflicting);
    expect(rejected.ok).toBe(false);
    expect(rejected.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(conflicting.writes).toHaveLength(0);
  });

  test("a listed uv tool without its executable is planned for reinstall", async () => {
    const rt = fakeRuntime({ tools: ["uv"] });
    const report = await execute({ ...setupOptions(), with: ["latent-compass"], dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.plannedChanges.find((item) => item.component === "latent-compass").installTool).toBe(true);
    expect(rt.writes).toHaveLength(0);
  });

  test("an empty uv inventory reported on stderr plans first installation", async () => {
    const rt = fakeRuntime({ tools: ["uv"], uvInstalled: false });
    const report = await execute({ ...setupOptions(), with: ["latent-compass"], dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.plannedChanges.find((item) => item.component === "latent-compass").installTool).toBe(true);
    expect(rt.writes).toHaveLength(0);
  });

  test("a Compass preview without evidence for its requested host blocks every write", async () => {
    const rt = fakeRuntime({ tools: ["uv"], uvInstalled: false });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("run")
      ? { code: 0, stdout: JSON.stringify({ dry_run: true, conflicts: [] }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("COMPASS_HOOK_CONFLICT");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a Compass preview without planned files blocks every write", async () => {
    const rt = fakeRuntime({ tools: ["uv"], uvInstalled: false });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("run")
      ? { code: 0, stdout: JSON.stringify({ ...compassInstallReport(argv), files: [] }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("COMPASS_HOOK_CONFLICT");
    expect(rt.writes).toHaveLength(0);
  });

  test("a Compass preview for another host path blocks every write", async () => {
    const rt = fakeRuntime({ tools: ["uv"], uvInstalled: false });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      if (argv[0] !== "uv" || !argv.includes("run")) return nativeExec(argv, cwd);
      const plan = compassInstallReport(argv);
      plan.files[1].path = join(homedir(), ".claude", "settings.json");
      return { code: 0, stdout: JSON.stringify(plan), stderr: "" };
    };
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("COMPASS_HOOK_CONFLICT");
    expect(rt.writes).toHaveLength(0);
  });

  test("a Compass preview for another repository blocks every write", async () => {
    const rt = fakeRuntime({ tools: ["uv"], uvInstalled: false });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("run")
      ? { code: 0, stdout: JSON.stringify({ ...compassInstallReport(argv), project_root: "/other" }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("COMPASS_HOOK_CONFLICT");
    expect(rt.writes).toHaveLength(0);
  });

  test("optional registry failure blocks all components before preflight writes", async () => {
    const rt = fakeRuntime({ tools: ["uv"], failPyPi: true, uvInstalled: false });
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(rt.calls.some((args) => args.includes("setup"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a failed uv inventory blocks optional installation before any native write", async () => {
    const rt = fakeRuntime({ tools: ["uv"] });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("list")
      ? { code: 5, stdout: "", stderr: "uv inventory unavailable" } : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a successful but unrecognized uv inventory blocks before any native write", async () => {
    const rt = fakeRuntime({ tools: ["uv"] });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("list")
      ? { code: 0, stdout: "latent-compass corrupted inventory\n", stderr: "" } : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a malformed uv inventory also blocks a resumed pinned plan", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const rt = fakeRuntime({ tools: ["uv"], state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("list")
      ? { code: 0, stdout: "unexpected output\n", stderr: "" } : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("UV_TOOL_INVENTORY_FAILED");
    expect(rt.writes).toHaveLength(0);
  });

  test("a failed uv tool directory probe blocks optional installation", async () => {
    const rt = fakeRuntime({ tools: ["uv"] });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "uv" && argv.includes("dir")
      ? { code: 5, stdout: "", stderr: "uv bin directory unavailable" } : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("UV_TOOL_INVENTORY_FAILED");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("partial failure saves the completed component for a later retry", async () => {
    const rt = fakeRuntime({
      tools: ["node", "npm"],
      files: { [join("/repo", "package.json")]: JSON.stringify({ name: "fixture" }) },
      failAssertInstall: true,
    });
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.components.map((item) => item.state)).toEqual(["configured", "partial"]);
    expect(rt.writes).toHaveLength(2);
    expect(rt.writes[0].inProgress.versions.assertledger).toBe("1.2.0");
    expect(rt.writes.at(-1).components.semctx.version).toBe("0.3.4");
    expect(rt.writes.at(-1).components.assertledger).toBeUndefined();
  });

  test("AssertLedger write needs an unchanged native post-install preview", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {
      semctx: { version: "0.3.4", hosts: ["codex"] },
      assertledger: { version: "1.2.0", hosts: ["codex"] },
    } };
    const files = {
      [join("/repo", "package.json")]: JSON.stringify({ dependencies: { assertledger: "1.2.0" } }),
      [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: "1.2.0" }),
      [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
    };
    const rt = fakeRuntime({ state, tools: ["node", "npm"], files });
    const nativeExec = rt.exec;
    let previews = 0;
    rt.exec = async (argv, cwd) => {
      if (argv[0] === "node" && argv.includes("setup") && argv.includes("--dry-run")) {
        previews += 1;
        if (previews === 3) return { code: 0, stdout: JSON.stringify(assertSetupReport(argv, "WOULD_CREATE", "dry-run")), stderr: "" };
      }
      return nativeExec(argv, cwd);
    };
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
    expect(report.components.find((item) => item.name === "assertledger").configured).toBe("unknown");
  });

  test("AssertLedger cannot report configured when nested native outcomes conflict", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {
      semctx: { version: "0.3.4", hosts: ["codex"] },
      assertledger: { version: "1.2.0", hosts: ["codex"] },
    } };
    const files = {
      [join("/repo", "package.json")]: JSON.stringify({ dependencies: { assertledger: "1.2.0" } }),
      [join("/repo", "node_modules", "assertledger", "package.json")]: JSON.stringify({ version: "1.2.0" }),
      [join("/repo", "node_modules", "assertledger", "dist", "cli.js")]: "cli",
    };
    const rt = fakeRuntime({ state, tools: ["node", "npm"], files });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv[0] === "node" && argv.includes("setup") && argv.includes("--write")
      ? { code: 0, stdout: JSON.stringify({
        ...assertSetupReport(argv, "CREATED", "write"),
        init: { status: "CONFLICT" }, connection: { client: "codex", status: "CONFLICT" },
      }), stderr: "" }
      : nativeExec(argv, cwd);
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "assertledger").configured).toBe("unknown");
    expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
  });

  test("interrupted host expansion preserves both selected hosts in its pending plan", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, tools: ["claude"] });
    const nativeExec = rt.exec;
    let interrupt = true;
    rt.exec = async (argv, cwd, timeout) => interrupt && argv[0] === "bunx" && argv.includes("install") && !argv.includes("--dry-run")
      ? { code: 5, stdout: "", stderr: "simulated interruption" } : nativeExec(argv, cwd, timeout);
    const options = parseArgs(["setup", "/repo", "--host", "all"]);
    const first = await execute(options, rt);
    expect(first.ok).toBe(false);
    expect(rt.writes.at(-1).inProgress.hosts).toEqual(["codex", "claude"]);
    expect(rt.writes.at(-1).components.semctx.hosts).toEqual(["codex"]);
    interrupt = false;
    const resumed = await execute(options, rt);
    expect(resumed.ok).toBe(true);
    expect(rt.writes.at(-1).components.semctx.hosts).toEqual(["codex", "claude"]);
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
  });

  test("retry keeps the failed component's resolved version when registry latest advances", async () => {
    const files = { [join("/repo", "package.json")]: JSON.stringify({ name: "fixture" }) };
    const rt = fakeRuntime({ tools: ["node", "npm"], files });
    const nativeExec = rt.exec;
    const nativeFetch = rt.fetchJson;
    let assertLatest = "1.2.0";
    let failOnce = true;
    rt.fetchJson = async (url) => url.includes("registry.npmjs.org/assertledger")
      ? { version: assertLatest } : nativeFetch(url);
    rt.exec = async (argv, cwd, timeout) => {
      if (argv[0] === "npm" && argv.includes("install")) {
        if (failOnce) { failOnce = false; return { code: 5, stdout: "", stderr: "simulated interruption" }; }
        files[join("/repo", "node_modules", "assertledger", "package.json")] = JSON.stringify({ version: "1.2.0" });
        files[join("/repo", "node_modules", "assertledger", "dist", "cli.js")] = "cli";
      }
      return nativeExec(argv, cwd, timeout);
    };
    const options = { ...setupOptions(), with: ["assertledger"] };
    const interrupted = await execute(options, rt);
    expect(interrupted.ok).toBe(false);
    expect(rt.writes.at(-1).inProgress.versions.assertledger).toBe("1.2.0");
    assertLatest = "1.2.1";
    const resumed = await execute(options, rt);
    expect(resumed.ok).toBe(true);
    expect(resumed.components.find((item) => item.name === "assertledger").version).toBe("1.2.0");
    expect(rt.writes.at(-1).components.assertledger.version).toBe("1.2.0");
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
  });

  test("a missing recorded Semctx host is reinstalled instead of reported installed", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, semctxMissing: true });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(true);
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(true);
    expect(report.components[0].installed).toBe("yes");
  });

  test("altered Semctx plugin bytes block before workspace or host writes", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, semctxContentDrift: true });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_CONTENT_DRIFT");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a pinned same-version upgrade does not overwrite modified Semctx plugin bytes", async () => {
    const state = {
      schemaVersion: 1, projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: { command: "upgrade", selected: ["semctx"], hosts: ["codex"], versions: { semctx: "0.3.4" } },
    };
    const rt = fakeRuntime({ state, semctxContentDrift: true });
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_CONTENT_DRIFT");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("a foreign Semctx marketplace blocks before workspace setup", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state, semctxMarketplaceMatch: false });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_MARKETPLACE_CONFLICT");
    expect(rt.calls.some((argv) => argv.includes("setup") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("an interrupted upgrade accepts its already installed pinned Semctx version", async () => {
    const state = {
      schemaVersion: 1, projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: { command: "upgrade", selected: ["semctx"], hosts: ["codex"], versions: { semctx: "0.3.5" } },
    };
    const rt = fakeRuntime({ state, version: "0.3.6", stable: "0.3.6", installedSemctxVersion: "0.3.5" });
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(true);
    expect(report.components[0].version).toBe("0.3.5");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes.at(-1).components.semctx.version).toBe("0.3.5");
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
  });

  test("a failed same-version upgrade pins its version before native writes", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => argv.includes("setup") && !argv.includes("--dry-run")
      ? { code: 5, stdout: "", stderr: "setup interrupted" } : nativeExec(argv, cwd);
    const options = parseArgs(["upgrade", "/repo", "--host", "codex"]);
    const interrupted = await execute(options, rt);
    expect(interrupted.ok).toBe(false);
    expect(rt.writes.at(-1).inProgress.versions.semctx).toBe("0.3.4");
    rt.exec = nativeExec;
    const originalFetch = rt.fetchJson;
    rt.fetchJson = async (url) => url.includes("semctx") ? { version: "0.3.5" } : originalFetch(url);
    const resumed = await execute(options, rt);
    expect(resumed.ok).toBe(true);
    expect(resumed.components[0].version).toBe("0.3.4");
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
  });

  test("an interrupted upgrade can explicitly refresh a now-unavailable stable plan", async () => {
    const state = {
      schemaVersion: 1, projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: { command: "upgrade", selected: ["semctx"], hosts: ["codex"], versions: { semctx: "0.3.5" } },
    };
    const rt = fakeRuntime({ state, version: "0.3.6", stable: "0.3.6" });
    const pinned = await execute(parseArgs(["upgrade", "/repo", "--host", "codex"]), rt);
    expect(pinned.ok).toBe(false);
    expect(pinned.conflicts.map((item) => item.code)).toContain("RELEASE_SKEW_OR_UNAVAILABLE");
    expect(pinned.nextActions.join(" ")).toContain("--refresh-pending");
    expect(rt.writes).toHaveLength(0);
    const refreshed = await execute(parseArgs(["upgrade", "/repo", "--host", "codex", "--refresh-pending"]), rt);
    expect(refreshed.ok).toBe(true);
    expect(refreshed.components[0].version).toBe("0.3.6");
    expect(rt.writes.at(-1).components.semctx.version).toBe("0.3.6");
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
  });

  test("refreshing a pending plan cannot silently drop its other host", async () => {
    const state = {
      schemaVersion: 1, projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: { command: "setup", selected: ["semctx"], hosts: ["codex", "claude"], versions: { semctx: "0.3.4" } },
    };
    const rt = fakeRuntime({ state, version: "0.3.5", stable: "0.3.5", tools: ["claude"] });
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex", "--refresh-pending"]), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("PENDING_PLAN_CONFLICT");
    const detail = report.conflicts.map((item) => item.detail).join("\n");
    expect(detail).toContain("hoklims-devkit setup /repo --host all");
    expect(detail).not.toContain("hoklims-devkit upgrade");
    expect(detail).not.toContain("--refresh-pending");
    expect(rt.writes).toHaveLength(0);
  });

  test("an interrupted upgrade accepts its already installed pinned Compass version", async () => {
    const state = {
      schemaVersion: 1, projectRoot: "/repo",
      components: {
        semctx: { version: "0.3.4", hosts: ["codex"] },
        "latent-compass": { version: "0.2.0", hosts: ["codex"] },
      },
      inProgress: { command: "upgrade", selected: ["semctx", "latent-compass"], hosts: ["codex"], versions: { semctx: "0.3.4", "latent-compass": "0.3.0" } },
    };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, uvInstalled: true });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd, timeout) => argv[0] === executable && argv.includes("install")
      ? { code: 0, stdout: JSON.stringify(compassInstallReport(argv, { installed: true, configured: true })), stderr: "" }
      : nativeExec(argv, cwd, timeout);
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(true);
    expect(report.components.find((item) => item.name === "latent-compass").version).toBe("0.3.0");
    expect(rt.calls.some((argv) => argv[0] === "uv" && argv.includes("install"))).toBe(false);
    expect(rt.writes.at(-1).components["latent-compass"].version).toBe("0.3.0");
    expect(rt.writes.at(-1).inProgress).toBeUndefined();
  });

  test("a successful native write without host configuration remains partial", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd, timeout) => argv[0] === executable && argv.includes("install")
      ? { code: 0, stdout: JSON.stringify(compassInstallReport(argv)), stderr: "" }
      : nativeExec(argv, cwd, timeout);
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "latent-compass").state).toBe("partial");
    expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
    expect(rt.writes.at(-1).inProgress).toBeDefined();
  });

  test("a Compass install response needs independent native status readback", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {
      semctx: { version: "0.3.4", hosts: ["codex"] },
      "latent-compass": { version: "0.3.0", hosts: ["codex"] },
    } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      if (argv[0] === executable && argv.includes("install")) {
        return { code: 0, stdout: JSON.stringify(compassInstallReport(argv, { installed: true, configured: true })), stderr: "" };
      }
      if (argv[0] === executable && argv.includes("status")) {
        return { code: 0, stdout: JSON.stringify({ operation: "status", version: "0.3.0", states: { codex: { installed: true, configured: false } } }), stderr: "" };
      }
      return nativeExec(argv, cwd);
    };
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "latent-compass").configured).toBe("unknown");
    expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
  });

  test("Compass setup accepts a configured install when Windows observation enumeration is unavailable", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, workspaceReady: true });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd, timeout) => {
      if (argv[0] === executable && argv.includes("install")) {
        return { code: 0, stdout: JSON.stringify(compassInstallReport(argv, { installed: true, configured: true })), stderr: "" };
      }
      if (argv[0] === executable && argv.includes("status")) {
        return { code: 0, stdout: JSON.stringify({
          schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo",
          hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
          states: { codex: { installed: true, configured: true, observed: "UNKNOWN" } },
        }), stderr: "" };
      }
      return nativeExec(argv, cwd, timeout);
    };
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(true);
    expect(report.components.find((item) => item.name === "latent-compass")).toMatchObject({ state: "configured", configured: "yes", loaded: "unknown", observed: "unknown" });
    expect(rt.writes.at(-1).components["latent-compass"]).toEqual({ version: "0.3.0", hosts: ["codex"] });
  });

  test("Compass setup rejects observation-unknown status without exact unknown evidence", async () => {
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    for (const observed of [true, false, undefined]) {
      const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
      const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, workspaceReady: true });
      const nativeExec = rt.exec;
      rt.exec = async (argv, cwd, timeout) => {
        if (argv[0] === executable && argv.includes("install")) {
          return { code: 0, stdout: JSON.stringify(compassInstallReport(argv, { installed: true, configured: true })), stderr: "" };
        }
        if (argv[0] === executable && argv.includes("status")) {
          return { code: 0, stdout: JSON.stringify({
            schema_version: 1, operation: "status", version: "0.3.0", project_root: "/repo",
            hosts: [{ host: "codex", status: "OBSERVATION_UNKNOWN" }],
            states: { codex: { installed: true, configured: true, ...(observed === undefined ? {} : { observed }) } },
          }), stderr: "" };
        }
        return nativeExec(argv, cwd, timeout);
      };
      const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
      expect(report.ok).toBe(false);
      expect(report.components.find((item) => item.name === "latent-compass")).toMatchObject({ state: "partial", configured: "unknown", observed: "unknown" });
      expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
      expect(rt.writes.at(-1).components["latent-compass"]).toBeUndefined();
    }
  });

  test("Compass post-install status needs a matching host snapshot", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {
      semctx: { version: "0.3.4", hosts: ["codex"] },
      "latent-compass": { version: "0.3.0", hosts: ["codex"] },
    } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" } });
    const nativeExec = rt.exec;
    rt.exec = async (argv, cwd) => {
      if (argv[0] === executable && argv.includes("install")) {
        return { code: 0, stdout: JSON.stringify(compassInstallReport(argv, { installed: true, configured: true })), stderr: "" };
      }
      if (argv[0] === executable && argv.includes("status")) {
        return { code: 0, stdout: JSON.stringify({
          schema_version: 1, operation: "status", version: "0.3.0", hosts: [],
          states: { codex: { installed: true, configured: true } },
        }), stderr: "" };
      }
      return nativeExec(argv, cwd);
    };
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.ok).toBe(false);
    expect(report.components.find((item) => item.name === "latent-compass").configured).toBe("unknown");
    expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
  });

  test("upgrading one host cannot relabel an untouched host at the new version", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex", "claude"] } } };
    const rt = fakeRuntime({ state, version: "0.3.5", stable: "0.3.5", tools: ["claude"] });
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("HOST_SCOPE_UPGRADE_CONFLICT");
    expect(rt.calls.some((argv) => argv.includes("install") && !argv.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("concurrent host setups cannot overwrite a completed state record", async () => {
    let persisted = null;
    let locked = false;
    let waiting = 0;
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    const runtimes = [fakeRuntime({ tools: ["claude"] }), fakeRuntime({ tools: ["claude"] })];
    for (const rt of runtimes) {
      const fetchJson = rt.fetchJson;
      rt.fetchJson = async (url) => {
        if (++waiting === 2) releaseFetch();
        await fetchGate;
        return fetchJson(url);
      };
      rt.readState = () => structuredClone(persisted);
      rt.writeState = (_path, value) => { persisted = structuredClone(value); rt.writes.push(structuredClone(value)); };
      rt.acquireLock = () => {
        if (locked) throw Object.assign(new Error("Another setup is running"), { code: "RUN_LOCKED" });
        locked = true;
        return () => { locked = false; };
      };
    }
    const [codex, claude] = await Promise.all([
      execute(setupOptions(), runtimes[0]),
      execute(parseArgs(["setup", "/repo", "--host", "claude"]), runtimes[1]),
    ]);
    expect([codex, claude].filter((report) => report.ok)).toHaveLength(1);
    expect([codex, claude].find((report) => !report.ok).conflicts[0].code).toMatch(/^(RUN_LOCKED|STATE_CHANGED)$/u);
    expect(runtimes.flatMap((rt) => rt.writes)).toHaveLength(3);
    expect(persisted.components.semctx.hosts).toHaveLength(1);
  });

  test("STATE_CHANGED recovery uses the latest locked reread plan", async () => {
    const lockedState = {
      schemaVersion: 1,
      projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: {
        command: "upgrade",
        selected: ["semctx", "assertledger"],
        hosts: ["codex"],
        versions: { semctx: "0.3.5", assertledger: "1.3.0" },
      },
    };
    const rt = fakeRuntime({ tools: ["node", "npm"], files: {
      [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager: "npm@10.9.8" }),
      [join("/repo", "package-lock.json")]: "{}",
    } });
    let reads = 0;
    let released = false;
    rt.readState = () => ++reads === 1 ? null : structuredClone(lockedState);
    rt.acquireLock = () => () => { released = true; };
    const report = await execute({ ...setupOptions(), with: ["assertledger"] }, rt);
    const detail = report.conflicts.map((item) => item.detail).join("\n");
    expect(report.conflicts.map((item) => item.code)).toContain("STATE_CHANGED");
    expect(detail).toContain("hoklims-devkit upgrade /repo --host codex --with assertledger");
    expect(detail).not.toContain("hoklims-devkit setup");
    expect(rt.writes).toHaveLength(0);
    expect(released).toBe(true);
  });

  test("noncanonical persisted plan order is a state conflict", async () => {
    for (const state of [
      {
        schemaVersion: 1, projectRoot: "/repo", components: {},
        inProgress: {
          command: "setup",
          selected: ["semctx", "latent-compass", "assertledger"],
          hosts: ["codex"],
          versions: { semctx: "0.3.5", assertledger: "1.3.0", "latent-compass": "0.3.0" },
        },
      },
      {
        schemaVersion: 1, projectRoot: "/repo", components: {},
        inProgress: {
          command: "setup",
          selected: ["semctx"],
          hosts: ["claude", "codex"],
          versions: { semctx: "0.3.5" },
        },
      },
      {
        schemaVersion: 1,
        projectRoot: "/repo",
        components: {
          semctx: { version: "0.3.5", hosts: ["codex"] },
          assertledger: { version: "1.3.0", hosts: ["codex"] },
        },
        inProgress: {
          command: "upgrade",
          selected: ["semctx"],
          hosts: ["codex"],
          versions: { semctx: "0.3.5" },
        },
      },
    ]) {
      const rt = fakeRuntime({ state, tools: ["claude"] });
      const report = await execute(parseArgs(["setup", "/repo", "--host", "all"]), rt);
      expect(report.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
      expect(report.conflicts.map((item) => item.code)).not.toContain("PENDING_PLAN_CONFLICT");
      expect(rt.writes).toHaveLength(0);
    }
  });

  test("every accepted pending upgrade host scope has an admitted retry", async () => {
    const cases = [
      { existing: ["codex"], pending: ["codex"], from: "0.3.4", to: "0.3.5", valid: true },
      { existing: ["claude"], pending: ["claude"], from: "0.3.4", to: "0.3.5", valid: true },
      { existing: ["codex", "claude"], pending: ["codex", "claude"], from: "0.3.4", to: "0.3.5", valid: true },
      { existing: ["codex", "claude"], pending: ["codex"], from: "0.3.4", to: "0.3.5", valid: false },
      { existing: ["codex", "claude"], pending: ["claude"], from: "0.3.4", to: "0.3.5", valid: false },
      { existing: ["codex", "claude"], pending: ["codex"], from: "0.3.4", to: "0.3.4", valid: true },
      { existing: ["codex", "claude"], pending: ["claude"], from: "0.3.4", to: "0.3.4", valid: true },
    ];
    for (const scenario of cases) {
      const state = {
        schemaVersion: 1,
        projectRoot: "/repo",
        components: { semctx: { version: scenario.from, hosts: scenario.existing } },
        inProgress: {
          command: "upgrade",
          selected: ["semctx"],
          hosts: scenario.pending,
          versions: { semctx: scenario.to },
        },
      };
      const host = scenario.pending.length === 2 ? "all" : scenario.pending[0];
      const rt = fakeRuntime({ state, version: scenario.to, stable: scenario.to, tools: ["claude"] });
      const report = await execute(parseArgs(["upgrade", "/repo", "--host", host]), rt);
      if (scenario.valid) {
        expect(report.conflicts.map((item) => item.code)).not.toContain("STATE_CONFLICT");
        expect(report.conflicts.map((item) => item.code)).not.toContain("PENDING_PLAN_CONFLICT");
        expect(report.conflicts.map((item) => item.code)).not.toContain("HOST_SCOPE_UPGRADE_CONFLICT");
      } else {
        expect(report.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
        expect(rt.writes).toHaveLength(0);
      }
    }
  });

  test("state I/O failures are distinct from lock contention and release the owned lock", async () => {
    const permission = fakeRuntime();
    permission.acquireLock = () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); };
    const denied = await execute(setupOptions(), permission);
    expect(denied.ok).toBe(false);
    expect(denied.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(denied.conflicts.map((item) => item.code)).not.toContain("RUN_LOCKED");
    expect(denied.conflicts.map((item) => item.detail).join("\n")).toMatch(/disk space|permissions/u);

    const writeFailure = fakeRuntime();
    let released = false;
    writeFailure.acquireLock = () => () => { released = true; };
    writeFailure.writeState = () => { throw Object.assign(new Error("quota exhausted"), { code: "ENOSPC" }); };
    const failedWrite = await execute(setupOptions(), writeFailure);
    expect(failedWrite.ok).toBe(false);
    expect(failedWrite.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(failedWrite.conflicts.map((item) => item.code)).not.toContain("RUN_LOCKED");
    expect(released).toBe(true);

    const rereadFailure = fakeRuntime();
    const initialRead = rereadFailure.readState;
    let reads = 0;
    let rereadReleased = false;
    rereadFailure.readState = (path) => {
      reads += 1;
      if (reads === 1) return initialRead(path);
      throw Object.assign(new Error("state read failed"), { code: "EIO" });
    };
    rereadFailure.acquireLock = () => () => { rereadReleased = true; };
    const failedReread = await execute(setupOptions(), rereadFailure);
    expect(failedReread.ok).toBe(false);
    expect(failedReread.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(failedReread.conflicts.map((item) => item.code)).not.toContain("RUN_LOCKED");
    expect(rereadReleased).toBe(true);

    const releaseFailure = fakeRuntime();
    releaseFailure.acquireLock = () => () => { throw Object.assign(new Error("lock unlink denied"), { code: "EACCES" }); };
    const failedRelease = await execute(setupOptions(), releaseFailure);
    expect(failedRelease.ok).toBe(false);
    expect(failedRelease.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(failedRelease.conflicts.map((item) => item.code)).not.toContain("RUN_LOCKED");
    expect(failedRelease.conflicts.map((item) => item.detail).join("\n")).toMatch(/lock release/u);
  });

  test("an initial state read permission failure is STATE_IO_ERROR", async () => {
    const rt = fakeRuntime();
    rt.readState = () => { throw Object.assign(new Error("state access denied"), { code: "EACCES" }); };
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(report.conflicts.map((item) => item.code)).not.toContain("STATE_CONFLICT");
    expect(report.conflicts.map((item) => item.detail).join("\n")).toMatch(/disk space|permissions/u);
    expect(report.conflicts.map((item) => item.detail).join("\n")).toContain("hoklims-devkit setup /repo --host codex");
    expect(rt.writes).toHaveLength(0);
  });

  test("state I/O recovery repeats the recorded upgrade selectors", async () => {
    const state = {
      schemaVersion: 1,
      projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: {
        command: "setup",
        selected: ["semctx", "assertledger"],
        hosts: ["codex"],
        versions: { semctx: "0.3.4", assertledger: "1.3.0" },
      },
    };
    const rt = fakeRuntime({
      state,
      version: "0.3.5",
      stable: "0.3.5",
      tools: ["node", "npm"],
      files: {
        [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager: "npm@10.9.8" }),
        [join("/repo", "package-lock.json")]: "{}",
      },
    });
    rt.writeState = () => { throw Object.assign(new Error("state disk unavailable"), { code: "EIO" }); };
    const options = parseArgs(["upgrade", "/repo", "--host", "codex", "--with", "assertledger", "--refresh-pending"]);
    const report = await execute(options, rt);
    const detail = report.conflicts.map((item) => item.detail).join("\n");
    expect(report.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(detail).toContain("hoklims-devkit upgrade /repo --host codex --with assertledger --refresh-pending");
    expect(detail).not.toContain("hoklims-devkit setup");
    expect(rt.writes).toHaveLength(0);

    const checkpoint = fakeRuntime({
      state: structuredClone(state),
      version: "0.3.5",
      stable: "0.3.5",
      tools: ["node", "npm"],
      files: {
        [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager: "npm@10.9.8" }),
        [join("/repo", "package-lock.json")]: "{}",
      },
    });
    const persist = checkpoint.writeState;
    let writes = 0;
    checkpoint.writeState = (path, value) => {
      writes += 1;
      if (writes === 1) return persist(path, value);
      throw Object.assign(new Error("checkpoint disk unavailable"), { code: "EIO" });
    };
    const laterFailure = await execute(options, checkpoint);
    const laterDetail = laterFailure.conflicts.map((item) => item.detail).join("\n");
    expect(laterFailure.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(laterDetail).toContain("hoklims-devkit upgrade /repo --host codex --with assertledger");
    expect(laterDetail).not.toContain("--refresh-pending");
  });

  test("native failure resumes a successfully persisted refreshed plan without refreshing again", async () => {
    const state = {
      schemaVersion: 1,
      projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: {
        command: "setup",
        selected: ["semctx", "assertledger"],
        hosts: ["codex"],
        versions: { semctx: "0.3.4", assertledger: "1.3.0" },
      },
    };
    const rt = fakeRuntime({
      state,
      version: "0.3.5",
      stable: "0.3.5",
      tools: ["node", "npm"],
      failAssertInstall: true,
      files: {
        [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager: "npm@10.9.8" }),
        [join("/repo", "package-lock.json")]: "{}",
      },
    });
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex", "--with", "assertledger", "--refresh-pending"]), rt);
    const detail = report.conflicts.map((item) => item.detail).join("\n");
    expect(report.conflicts.map((item) => item.code)).toContain("APPLY_FAILED");
    expect(rt.writes[0].inProgress).toMatchObject({ command: "upgrade", selected: ["semctx", "assertledger"], hosts: ["codex"] });
    expect(detail).toContain("hoklims-devkit upgrade /repo --host codex --with assertledger");
    expect(detail).not.toContain("--refresh-pending");
  });

  test("doctor state I/O recovery repeats doctor", async () => {
    const rt = fakeRuntime();
    rt.readState = () => { throw Object.assign(new Error("state access denied"), { code: "EACCES" }); };
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    const detail = report.conflicts.map((item) => item.detail).join("\n");
    expect(report.conflicts.map((item) => item.code)).toContain("STATE_IO_ERROR");
    expect(detail).toContain("hoklims-devkit doctor /repo --host codex");
    expect(detail).not.toContain("hoklims-devkit setup");
  });

  test("shell-quoted recovery paths round-trip as one inert token", () => {
    const root = process.platform === "win32"
      ? "C:\\repo with 'quote $() ` tick"
      : "/tmp/a\\b repo with 'quote $() ` tick";
    const quoted = quoteShellToken(root);
    const command = process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", `[Console]::Out.Write(${quoted})`]
      : ["bash", "-lc", `printf %s ${quoted}`];
    const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(root);
    expect(result.stderr.toString()).toBe("");
  });

  test("typed state path conflicts stay STATE_CONFLICT at every locked boundary", async () => {
    const conflict = (message) => Object.assign(new Error(message), { code: "STATE_CONFLICT" });

    const acquireFailure = fakeRuntime();
    acquireFailure.acquireLock = () => { throw conflict("unsafe linked lock parent; inspect the path and retry"); };
    const failedAcquire = await execute(setupOptions(), acquireFailure);
    expect(failedAcquire.ok).toBe(false);
    expect(failedAcquire.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
    expect(failedAcquire.conflicts.map((item) => item.code)).not.toContain("STATE_IO_ERROR");
    expect(failedAcquire.conflicts.map((item) => item.code)).not.toContain("RUN_LOCKED");
    expect(failedAcquire.conflicts.map((item) => item.detail).join("\n")).toMatch(/inspect the path and retry/u);
    expect(acquireFailure.writes).toHaveLength(0);

    const rereadFailure = fakeRuntime();
    const initialRead = rereadFailure.readState;
    let reads = 0;
    let rereadReleased = false;
    rereadFailure.readState = (path) => {
      reads += 1;
      if (reads === 1) return initialRead(path);
      throw conflict("state path became linked");
    };
    rereadFailure.acquireLock = () => () => { rereadReleased = true; };
    const failedReread = await execute(setupOptions(), rereadFailure);
    expect(failedReread.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
    expect(failedReread.conflicts.map((item) => item.code)).not.toContain("STATE_IO_ERROR");
    expect(rereadReleased).toBe(true);

    const writeFailure = fakeRuntime();
    let writeReleased = false;
    writeFailure.acquireLock = () => () => { writeReleased = true; };
    writeFailure.writeState = () => { throw conflict("state destination became linked"); };
    const failedWrite = await execute(setupOptions(), writeFailure);
    expect(failedWrite.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
    expect(failedWrite.conflicts.map((item) => item.code)).not.toContain("STATE_IO_ERROR");
    expect(failedWrite.conflicts.map((item) => item.code)).not.toContain("APPLY_FAILED");
    expect(writeReleased).toBe(true);

    const releaseFailure = fakeRuntime();
    releaseFailure.acquireLock = () => () => { throw conflict("lock path became linked"); };
    const failedRelease = await execute(setupOptions(), releaseFailure);
    expect(failedRelease.ok).toBe(false);
    expect(failedRelease.conflicts.map((item) => item.code)).toContain("STATE_CONFLICT");
    expect(failedRelease.conflicts.map((item) => item.code)).not.toContain("STATE_IO_ERROR");
  });

  test("genuine lock contention remains RUN_LOCKED", async () => {
    const rt = fakeRuntime();
    rt.acquireLock = () => { throw Object.assign(new Error("another setup is running"), { code: "RUN_LOCKED" }); };
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("RUN_LOCKED");
    expect(report.conflicts.map((item) => item.code)).not.toContain("STATE_IO_ERROR");
  });

  test("lock contention preserves the admitted pending-plan recovery", async () => {
    const state = {
      schemaVersion: 1,
      projectRoot: "/repo",
      components: { semctx: { version: "0.3.4", hosts: ["codex"] } },
      inProgress: {
        command: "upgrade",
        selected: ["semctx", "assertledger"],
        hosts: ["codex"],
        versions: { semctx: "0.3.5", assertledger: "1.3.0" },
      },
    };
    const rt = fakeRuntime({ state, version: "0.3.5", stable: "0.3.5", tools: ["node", "npm"], files: {
      [join("/repo", "package.json")]: JSON.stringify({ name: "fixture", packageManager: "npm@10.9.8" }),
      [join("/repo", "package-lock.json")]: "{}",
    } });
    rt.acquireLock = () => { throw Object.assign(new Error("Another setup may be running"), { code: "RUN_LOCKED" }); };
    const report = await execute(parseArgs(["upgrade", "/repo", "--host", "codex", "--with", "assertledger"]), rt);
    const detail = report.conflicts.map((item) => item.detail).join("\n");
    expect(report.conflicts.map((item) => item.code)).toContain("RUN_LOCKED");
    expect(detail).toContain("another Devkit operation");
    expect(detail).not.toContain("Another setup");
    expect(detail).toContain("hoklims-devkit upgrade /repo --host codex --with assertledger");
    expect(report.nextActions.join("\n")).toContain("hoklims-devkit upgrade /repo --host codex --with assertledger");
    expect(rt.writes).toHaveLength(0);
  });

  test("an incomplete Semctx index is reported without claiming the profile is ready", async () => {
    const rt = fakeRuntime({ setupReady: false });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0].state).toBe("needs-attention");
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_NOT_READY");
    expect(report.conflicts.map((item) => item.detail).join("\n")).toContain("hoklims-devkit setup /repo --host codex");
    expect(report.nextActions.join("\n")).toContain("hoklims-devkit setup /repo --host codex");
    expect(rt.writes).toHaveLength(2);
  });
});
