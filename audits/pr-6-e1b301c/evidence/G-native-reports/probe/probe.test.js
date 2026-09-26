import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execute, parseArgs, quoteShellToken } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-G-native-reports/src/app.js";
import { createRuntime, validateState } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-G-native-reports/src/runtime.js";

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
const wrap = (rt, match, edit) => { const x = rt.exec; rt.exec = async (argv, cwd, t) => { const r = await x(argv, cwd, t); if (!match(argv)) return r; const j = JSON.parse(r.stdout); const o = edit(j, r) ?? {}; return { ...r, ...o, stdout: JSON.stringify(j) }; }; return rt; };
const semState = { schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } };
const out = {};
async function probe(name, rt, opts = setupOptions()) {
  const r = await execute(opts, rt);
  out[name] = { ok: r.ok, codes: r.conflicts.map((c) => c.code), comp: r.components.map((c) => `${c.name}:${c.state ?? ""}/${c.configured}`), writes: rt.writes.length };
}
test("probe pristine guards for coverage gaps", async () => {
  // G07: setup plan for another repository
  await probe("G07_setupplan_root_other", wrap(fakeRuntime(), (a) => a.includes("setup") && a.includes("--dry-run"), (j) => { j.repositoryRoot = "/other"; }));
  // G08: applied setup report for another repository (verdict READY)
  await probe("G08_apply_setup_root_other", wrap(fakeRuntime(), (a) => a.includes("setup") && !a.includes("--dry-run"), (j) => { j.repositoryRoot = "/other"; }));
  // G09: host install dry-run with selected host failed
  await probe("G09_host_status_failed", wrap(fakeRuntime(), (a) => a.includes("install") && a.includes("--dry-run"), (j) => { j.hosts.codex.status = "failed"; }));
  // G12: semctx setup dry-run exit 4 with a valid plan body
  await probe("G12_setup_exit4", wrap(fakeRuntime(), (a) => a.includes("setup") && a.includes("--dry-run"), () => ({ code: 4 })));
  // G14: doctor healthy, index-health partial -> must not skip setup / be "yes"
  await probe("G14_doctor_index_partial", wrap(fakeRuntime({ state: structuredClone(semState), workspaceReady: true }), (a) => a.includes("index-health"), (j) => { j.coverage.status = "partial"; return { code: 2 }; }), parseArgs(["doctor", "/repo", "--host", "codex"]));
  // G16: post-install plugin-status content unverified
  { const rt = fakeRuntime(); let installs = 0; const x = rt.exec; rt.exec = async (a, c, t) => { if (a.includes("install") && !a.includes("--dry-run")) installs += 1; const r = await x(a, c, t); if (!a.includes("plugin-status") || !installs) return r; const j = JSON.parse(r.stdout); j.hosts.codex.installed.contentMatchesSnapshot = null; return { ...r, stdout: JSON.stringify(j) }; }; await probe("G16_post_install_content_null", rt); }
  // G03: AssertLedger report for another client
  { const files = { [join("/repo", "package.json")]: JSON.stringify({ name: "fixture" }) };
    const rt = fakeRuntime({ tools: ["node", "npm"], files }); const x = rt.exec;
    rt.exec = async (a, c, t) => a[0] === "npm" && a.includes("exec") ? { code: 0, stdout: JSON.stringify({ ...assertSetupReport(a, "WOULD_CREATE", "dry-run"), client: "claude-code", connection: { client: "claude-code", status: "EMITTED" } }), stderr: "" } : x(a, c, t);
    await probe("G03_assert_other_client", rt, { ...setupOptions(), with: ["assertledger"], dryRun: true }); }
  // G04: Compass preview reporting another version
  await probe("G04_compass_other_version", wrap(fakeRuntime({ tools: ["uv"], uvInstalled: false }), (a) => a[0] === "uv" && a.includes("run"), (j) => { j.version = "9.9.9"; }), { ...setupOptions(), with: ["latent-compass"], dryRun: true });
  // G17: native stream failure detail
  { const native = createRuntime({ spawnProcess: () => ({ stdout: new ReadableStream({ start(c) { c.error(new Error("simulated stdout read failure")); } }), stderr: new ReadableStream({ start(c) { c.close(); } }), exited: Promise.resolve(0), kill: () => {} }) });
    const r = await native.exec(["x"], "/"); out.G17_runtime_exec_result = r; }
  console.log(JSON.stringify(out, null, 1));
});
