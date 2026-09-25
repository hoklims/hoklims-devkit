import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { execute, parseArgs } from "../src/app.js";

function fakeRuntime({ version = "0.3.4", stable = version, setup = { kind: "setup_plan", verdict: "SETUP_PLANNED" }, setupReady = true, state = null, files = {}, tools = [], failAssertInstall = false, failPyPi = false, uvInstalled = true, assertStatus = "UNCHANGED", compassStatus = "NO_OBSERVATIONS", semctxStatusCode = 3, semctxStatusMalformed = false } = {}) {
  const calls = [];
  const writes = [];
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
      if (argv[0] === "node" && argv.includes("setup")) return { code: assertStatus === "CONFLICT" ? 4 : 0, stdout: JSON.stringify({ status: assertStatus, mode: "dry-run", artifacts: [{ state: assertStatus === "UNCHANGED" ? "UNCHANGED" : "CONFLICT" }] }), stderr: "" };
      if (argv[0] === "node") return { code: 0, stdout: "v22.15.0\n", stderr: "" };
      if (argv[0] === "git") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (argv[0] === "uv" && argv.includes("dir")) return { code: 0, stdout: "/uvbin\n", stderr: "" };
      if (argv[0] === "uv" && argv.includes("list")) return { code: 0, stdout: uvInstalled ? "latent-compass v0.3.0\n" : "No tools installed\n", stderr: "" };
      if (argv[0] === "uv" && argv.includes("run")) return { code: 0, stdout: JSON.stringify({ dry_run: true, conflicts: [], files: [] }), stderr: "" };
      if (argv[0] === join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass") && argv.includes("--version")) return { code: 0, stdout: "latent-compass 0.3.0\n", stderr: "" };
      if (argv[0] === join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass") && argv.includes("status")) return { code: 0, stdout: JSON.stringify({ hosts: [{ host: "codex", status: compassStatus }], states: { codex: { installed: true, configured: compassStatus === "NO_OBSERVATIONS", observed: false } } }), stderr: "" };
      if (argv[0] === "npm" && argv.includes("exec")) return { code: 0, stdout: JSON.stringify({ status: "WOULD_CREATE", mode: "dry-run", artifacts: [{ owner: "init", path: "/repo/assertledger.config.json", state: "WOULD_CREATE" }], init: { requiredOperatorInputs: [] } }), stderr: "" };
      if (argv[0] === "npm" && argv.includes("install")) return { code: failAssertInstall ? 5 : 0, stdout: "", stderr: failAssertInstall ? "package install failed" : "" };
      if (argv.includes("plugin-status")) {
        return {
          code: semctxStatusCode,
          stdout: JSON.stringify(semctxStatusMalformed ? { hosts: {} } : {
            schemaVersion: 2,
            kind: "plugin_delivery_status",
            hosts: {
              codex: { requested: true, installed: { version: null, contentMatchesSnapshot: null }, marketplace: { matchesSemctx: null } },
              claude: { requested: true, installed: { version: null, contentMatchesSnapshot: null }, marketplace: { matchesSemctx: null } },
            },
          }),
          stderr: "",
        };
      }
      if (argv.includes("setup") && argv.includes("--dry-run")) {
        return { code: setup.kind === "setup_plan" ? 0 : 4, stdout: JSON.stringify(setup), stderr: "" };
      }
      if (argv.includes("doctor")) return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      if (argv.includes("index-health")) return { code: 2, stdout: JSON.stringify({ coverage: { status: "partial" } }), stderr: "" };
      if (argv.includes("install")) return { code: 0, stdout: JSON.stringify({ ok: true, dryRun: argv.includes("--dry-run"), hosts: { codex: { status: "planned" } } }), stderr: "" };
      if (argv.includes("setup")) return { code: setupReady ? 0 : 1, stdout: JSON.stringify({ kind: "setup", setupReady, analysisReady: setupReady }), stderr: "" };
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

  test("workspace conflict prevents any host installation", async () => {
    const rt = fakeRuntime({ setup: { kind: "setup_conflict", verdict: "SETUP_REFUSED", reason: "invalid-config" } });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_WORKSPACE_CONFLICT");
    expect(rt.calls.some((args) => args.includes("install") && !args.includes("--dry-run"))).toBe(false);
    expect(rt.writes).toHaveLength(0);
  });

  test("successful setup records the exact installed version for resume", async () => {
    const rt = fakeRuntime();
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(true);
    expect(report.components[0].state).toBe("configured");
    expect(rt.writes).toHaveLength(1);
    expect(rt.writes[0].components.semctx).toEqual({ version: "0.3.4", hosts: ["codex"] });
    expect(report.components[0].loaded).toBe("unknown");
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

  test("doctor keeps unobserved session and approval unknown", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
    const rt = fakeRuntime({ state });
    const report = await execute(parseArgs(["doctor", "/repo", "--host", "codex"]), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0]).toEqual(expect.objectContaining({ installed: "no", loaded: "unknown", approved: "unknown", observed: "unknown" }));
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

  test("doctor rejects a rendered but unconfigured Latent Compass status", async () => {
    const state = { schemaVersion: 1, projectRoot: "/repo", components: { "latent-compass": { version: "0.3.0", hosts: ["codex"] } } };
    const executable = join("/uvbin", process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
    const rt = fakeRuntime({ state, tools: ["uv"], files: { [executable]: "shim" }, compassStatus: "NOT_CONFIGURED" });
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

  test("a listed uv tool without its executable is planned for reinstall", async () => {
    const rt = fakeRuntime({ tools: ["uv"] });
    const report = await execute({ ...setupOptions(), with: ["latent-compass"], dryRun: true }, rt);
    expect(report.ok).toBe(true);
    expect(report.plannedChanges.find((item) => item.component === "latent-compass").installTool).toBe(true);
    expect(rt.writes).toHaveLength(0);
  });

  test("optional registry failure blocks all components before preflight writes", async () => {
    const rt = fakeRuntime({ tools: ["uv"], failPyPi: true, uvInstalled: false });
    const report = await execute({ ...setupOptions(), with: ["latent-compass"] }, rt);
    expect(report.conflicts.map((item) => item.code)).toContain("VERSION_UNAVAILABLE");
    expect(rt.calls.some((args) => args.includes("setup"))).toBe(false);
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
    expect(rt.writes).toHaveLength(1);
    expect(rt.writes[0].components.semctx.version).toBe("0.3.4");
    expect(rt.writes[0].components.assertledger).toBeUndefined();
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
        if (locked) throw new Error("Another setup is running");
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
    expect(runtimes.flatMap((rt) => rt.writes)).toHaveLength(1);
    expect(persisted.components.semctx.hosts).toHaveLength(1);
  });

  test("an incomplete Semctx index is reported without claiming the profile is ready", async () => {
    const rt = fakeRuntime({ setupReady: false });
    const report = await execute(setupOptions(), rt);
    expect(report.ok).toBe(false);
    expect(report.components[0].state).toBe("needs-attention");
    expect(report.conflicts.map((item) => item.code)).toContain("SEMCTX_NOT_READY");
    expect(rt.writes).toHaveLength(1);
  });
});
