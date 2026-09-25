import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { createRuntime, parseJsonOutput, shortError, validateState } from "./runtime.js";

const COMPONENTS = ["semctx", "assertledger", "latent-compass"];
const HOSTS = ["codex", "claude"];
const VERSION = packageJson.version;

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) return { help: true };
  if (argv.includes("--version")) return { version: true };
  const command = argv[0];
  if (!["setup", "doctor", "upgrade"].includes(command)) throw new UsageError(`Unknown command: ${command}`);
  const options = { command, project: ".", host: "auto", with: [], dryRun: false, json: false };
  let hasProject = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host" || arg === "--with") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      if (arg === "--host") options.host = value;
      else options.with.push(...value.split(",").filter(Boolean));
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (hasProject) throw new UsageError("Only one repository path is accepted");
    else {
      options.project = arg;
      hasProject = true;
    }
  }
  if (!["auto", "codex", "claude", "all"].includes(options.host)) throw new UsageError("--host must be auto, codex, claude, or all");
  if (options.with.some((name) => !COMPONENTS.slice(1).includes(name))) {
    throw new UsageError("--with accepts assertledger and latent-compass");
  }
  options.with = [...new Set(options.with)];
  return options;
}

export class UsageError extends Error {}

function reportFor(options) {
  return {
    schemaVersion: 1,
    command: options.command,
    ok: false,
    projectRoot: null,
    hosts: [],
    components: [],
    plannedChanges: [],
    conflicts: [],
    nextActions: [],
  };
}

function problem(report, code, detail, exitCode = 4) {
  report.conflicts.push({ code, detail });
  report.exitCode = Math.max(report.exitCode ?? 0, exitCode);
  return report;
}

function nativeResult(result, name, report) {
  const json = parseJsonOutput(result);
  if (!json) {
    problem(report, "NATIVE_REPORT_INVALID", `${name}: ${shortError(result)}`, 5);
    return null;
  }
  return json;
}

function isStableVersion(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/u.test(version);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function existingAssertVersion(rt, root) {
  const manifestPath = join(root, "package.json");
  if (!rt.exists(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(rt.readText(manifestPath));
  } catch {
    throw new Error("package.json is invalid JSON");
  }
  const declared = manifest?.devDependencies?.assertledger ?? manifest?.dependencies?.assertledger;
  if (declared === undefined) return null;
  if (!isStableVersion(declared)) throw new Error(`AssertLedger dependency must be pinned exactly; found ${String(declared)}`);
  return declared;
}

function packageManager(rt, root) {
  const manifestPath = join(root, "package.json");
  if (!rt.exists(manifestPath)) throw new Error("AssertLedger setup needs an existing package.json");
  const manifest = JSON.parse(rt.readText(manifestPath));
  const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : null;
  const locks = [
    ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
    ["pnpm", ["pnpm-lock.yaml"]],
    ["bun", ["bun.lock", "bun.lockb"]],
  ];
  const found = new Set(locks.filter(([, paths]) => paths.some((path) => rt.exists(join(root, path)))).map(([name]) => name));
  if (declared) found.add(declared);
  if (found.size > 1) throw new Error(`Conflicting package managers: ${[...found].join(", ")}`);
  const selected = [...found][0] ?? "npm";
  if (rt.exists(join(root, "yarn.lock"))) throw new Error("Yarn repositories must use AssertLedger's native setup until a verified Yarn adapter is available");
  if (!["npm", "pnpm", "bun"].includes(selected)) throw new Error(`Unsupported package manager: ${selected}`);
  return selected;
}

function installPackageCommand(manager, version) {
  const spec = `assertledger@${version}`;
  if (manager === "npm") return ["npm", "install", "--save-dev", "--save-exact", "--ignore-scripts", spec];
  if (manager === "pnpm") return ["pnpm", "add", "--save-dev", "--save-exact", "--ignore-scripts", spec];
  return ["bun", "add", "--dev", "--exact", "--ignore-scripts", spec];
}

function localAssertEntry(rt, root) {
  const packagePath = join(root, "node_modules", "assertledger", "package.json");
  const cliPath = join(root, "node_modules", "assertledger", "dist", "cli.js");
  if (!rt.exists(packagePath) || !rt.exists(cliPath)) return null;
  try {
    const version = JSON.parse(rt.readText(packagePath))?.version;
    return isStableVersion(version) ? { version, cliPath } : null;
  } catch {
    return null;
  }
}

function localAssertCommand(entry, args) {
  if (!entry) throw new Error("The project-local AssertLedger executable is missing or invalid");
  return ["node", entry.cliPath, ...args];
}

function uvToolVersion(output) {
  const match = output.match(/^latent-compass v(\d+\.\d+\.\d+)\s*$/mu);
  return match?.[1] ?? null;
}

async function persistentCompassEntry(rt, root) {
  const bin = await rt.exec(["uv", "tool", "dir", "--bin"], root);
  if (bin.code !== 0) return null;
  const executable = join(bin.stdout.trim(), process.platform === "win32" ? "latent-compass.exe" : "latent-compass");
  if (!rt.exists(executable)) return null;
  const reported = await rt.exec([executable, "--version"], root);
  const version = reported.code === 0 ? reported.stdout.trim().match(/^latent-compass (\d+\.\d+\.\d+)$/u)?.[1] : null;
  return version ? { executable, version } : null;
}

async function resolveVersion(rt, name) {
  if (name === "latent-compass") {
    const data = await rt.fetchJson("https://pypi.org/pypi/latent-compass/json");
    if (!isStableVersion(data?.info?.version)) throw new Error("PyPI has no stable latent-compass release");
    return data.info.version;
  }
  const data = await rt.fetchJson(`https://registry.npmjs.org/${name}/latest`);
  if (!isStableVersion(data?.version)) throw new Error(`npm has no stable ${name} release`);
  return data.version;
}

async function checkSemctxChannel(rt, version) {
  const sources = [
    ["Codex", "https://raw.githubusercontent.com/hoklims/semctx/stable/plugins/semctx-control/.codex-plugin/plugin.json"],
    ["Claude", "https://raw.githubusercontent.com/hoklims/semctx/stable/plugins/claude-code/plugin.json"],
  ];
  for (const [host, url] of sources) {
    const manifest = await rt.fetchJson(url);
    if (manifest?.version !== version) {
      throw new Error(`Semctx npm ${version} differs from ${host} stable plugin ${String(manifest?.version ?? "unknown")}`);
    }
  }
}

async function resolveComponents(rt, options, state, root, report) {
  const selected = new Set(["semctx", ...options.with]);
  if (options.command !== "setup" && options.with.length === 0) {
    for (const name of Object.keys(state?.components ?? {})) selected.add(name);
  }
  const versions = {};
  for (const name of COMPONENTS.filter((item) => selected.has(item))) {
    try {
      if (options.command !== "upgrade" && state?.components?.[name]?.version) {
        versions[name] = state.components[name].version;
      } else if (name === "assertledger" && options.command === "setup" && existingAssertVersion(rt, root)) {
        versions[name] = existingAssertVersion(rt, root);
      } else if (name === "latent-compass" && options.command === "setup" && rt.which("uv")) {
        const listed = await rt.exec(["uv", "tool", "list"], root);
        versions[name] = uvToolVersion(listed.stdout) ?? await resolveVersion(rt, name);
      } else {
        versions[name] = await resolveVersion(rt, name);
      }
      if (!isStableVersion(versions[name])) throw new Error(`Invalid ${name} version`);
      // 0.3.3 accepts `setup --dry-run` but writes workspace files. Never invoke it as a preflight.
      if (name === "semctx" && compareVersions(versions[name], "0.3.4") < 0) {
        throw new Error("Semctx before 0.3.4 has no safe workspace preflight");
      }
      if (name === "semctx" && (options.command === "upgrade" || !state?.components?.semctx)) {
        await checkSemctxChannel(rt, versions[name]);
      }
    } catch (error) {
      problem(report, name === "semctx" ? "RELEASE_SKEW_OR_UNAVAILABLE" : "VERSION_UNAVAILABLE", `${name}: ${String(error.message ?? error)}`, 3);
    }
  }
  return versions;
}

async function preflightSemctx(rt, root, hosts, version, previous, command, report) {
  const hostMode = hosts.length === 2 ? "all" : hosts[0];
  const args = ["--root", root, "--json"];
  const hostInstallNeeded = command === "upgrade" || !previous || hosts.some((host) => !previous.hosts?.includes(host));
  if (hostInstallNeeded && previous && command !== "upgrade") {
    try {
      await checkSemctxChannel(rt, version);
    } catch (error) {
      problem(report, "RELEASE_SKEW_OR_UNAVAILABLE", `Semctx host expansion: ${String(error.message ?? error)}`, 3);
      return null;
    }
  }
  const setup = await rt.exec(["bunx", `semctx@${version}`, "setup", "--dry-run", ...args], root);
  const setupJson = nativeResult(setup, "semctx setup --dry-run", report);
  if (!setupJson) return null;
  if (setup.code !== 0 || setupJson.kind !== "setup_plan" || setupJson.verdict !== "SETUP_PLANNED") {
    problem(report, "SEMCTX_WORKSPACE_CONFLICT", JSON.stringify(setupJson).slice(0, 600));
  }
  const status = await rt.exec(["bunx", `semctx@${version}`, "plugin-status", "--host", hostMode, ...args], root);
  const statusJson = nativeResult(status, "semctx plugin-status", report);
  if (!statusJson) return null;
  const installedVersions = hosts.map((host) => statusJson.hosts?.[host]?.installed?.version).filter((value) => isStableVersion(value));
  if (command !== "upgrade" && !previous && installedVersions.some((installed) => installed !== version)) {
    problem(report, "EXISTING_VERSION", `Semctx is already installed at ${[...new Set(installedVersions)].join(", ")}; use upgrade explicitly`);
  }
  if (previous && installedVersions.some((installed) => installed !== previous.version)) {
    problem(report, "INSTALLED_VERSION_DRIFT", `Semctx installation differs from recorded ${previous.version}`);
  }
  let hostJson = { ok: true, dryRun: true, hosts: {}, skipped: true };
  if (hostInstallNeeded) {
    const host = await rt.exec(["bunx", `semctx@${version}`, "install", "--host", hostMode, "--skip-setup", "--dry-run", ...args], root);
    hostJson = nativeResult(host, "semctx install --dry-run", report);
    if (!hostJson) return null;
    if (host.code !== 0 || hostJson.ok !== true || hostJson.dryRun !== true) problem(report, "SEMCTX_HOST_CONFLICT", JSON.stringify(hostJson).slice(0, 600));
  }
  report.plannedChanges.push({ component: "semctx", workspace: setupJson, hosts: hostJson.hosts });
  return { setup: setupJson, host: hostJson };
}

async function preflightAssert(rt, root, hosts, version, previous, command, report) {
  if (!rt.which("node") || !rt.which("npm")) {
    problem(report, "NODE_REQUIRED", "AssertLedger needs Node >=22.15 and npm", 3);
    return null;
  }
  const node = await rt.exec(["node", "--version"], root);
  const match = node.stdout.trim().match(/^v(\d+)\.(\d+)\./u);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 15)) {
    problem(report, "NODE_VERSION", "AssertLedger needs Node >=22.15", 3);
    return null;
  }
  let manager;
  try {
    manager = packageManager(rt, root);
  } catch (error) {
    problem(report, "PACKAGE_MANAGER_CONFLICT", String(error.message ?? error));
    return null;
  }
  if (!rt.which(manager)) {
    problem(report, "PACKAGE_MANAGER_MISSING", `${manager} is not on PATH`, 3);
    return null;
  }
  let current;
  try {
    current = existingAssertVersion(rt, root);
  } catch (error) {
    problem(report, "PACKAGE_MANIFEST_CONFLICT", String(error.message ?? error));
    return null;
  }
  if (command !== "upgrade" && current && current !== version) problem(report, "INSTALLED_VERSION_DRIFT", `AssertLedger dependency is ${current}, expected ${version}`);
  const localEntry = localAssertEntry(rt, root);
  const needsInstall = current !== version || localEntry?.version !== version;
  const previews = [];
  for (const host of hosts) {
    const client = host === "claude" ? "claude-code" : "codex";
    const previewCommand = !needsInstall
      ? localAssertCommand(localEntry, ["setup", root, "--client", client, "--dry-run", "--json"])
      : ["npm", "exec", "--yes", "--ignore-scripts", `--package=assertledger@${version}`, "--", "assertledger", "setup", root, "--client", client, "--dry-run", "--json"];
    const result = await rt.exec(previewCommand, root);
    const parsed = nativeResult(result, `assertledger setup (${client})`, report);
    if (!parsed) continue;
    if (result.code !== 0 || !["WOULD_CREATE", "UNCHANGED"].includes(parsed.status) || parsed.mode !== "dry-run") {
      problem(report, "ASSERTLEDGER_CONFLICT", JSON.stringify(parsed).slice(0, 600));
    }
    previews.push({
      host,
      status: parsed.status,
      artifacts: (parsed.artifacts ?? []).map(({ owner, path, state }) => ({ owner, path, state })),
      requiredOperatorInputs: parsed.init?.requiredOperatorInputs ?? [],
    });
  }
  report.plannedChanges.push({ component: "assertledger", packageManager: manager, installPackage: needsInstall, previews });
  return { manager, current, needsInstall, previews };
}

async function preflightCompass(rt, root, hosts, version, previous, command, report) {
  if (!rt.which("uv")) {
    problem(report, "UV_REQUIRED", "Latent Compass needs uv on PATH", 3);
    return null;
  }
  const listed = await rt.exec(["uv", "tool", "list"], root);
  const current = uvToolVersion(listed.stdout);
  if (command !== "upgrade" && current && current !== version) problem(report, "EXISTING_VERSION", `Latent Compass is installed at ${current}; use upgrade explicitly`);
  if (previous && current && current !== previous.version) problem(report, "INSTALLED_VERSION_DRIFT", `Latent Compass installation differs from recorded ${previous.version}`);
  const entry = await persistentCompassEntry(rt, root);
  const needsInstall = current !== version || entry?.version !== version;
  const previews = [];
  for (const host of hosts) {
    const commandLine = !needsInstall
      ? [entry.executable, "host", "install", "--project-root", root, "--host", host, "--dry-run", "--json"]
      : ["uv", "tool", "run", "--from", `latent-compass==${version}`, "latent-compass", "host", "install", "--project-root", root, "--host", host, "--dry-run", "--json"];
    const result = await rt.exec(commandLine, root);
    const parsed = nativeResult(result, `latent-compass host install (${host})`, report);
    if (!parsed) continue;
    if (result.code !== 0 || parsed.dry_run !== true || !Array.isArray(parsed.conflicts) || parsed.conflicts.length > 0) {
      problem(report, "COMPASS_HOOK_CONFLICT", JSON.stringify(parsed).slice(0, 600));
    }
    previews.push({ host, files: parsed.files ?? [], conflicts: parsed.conflicts ?? [] });
  }
  report.plannedChanges.push({ component: "latent-compass", installTool: needsInstall, previews });
  return { current, needsInstall, previews };
}

async function applySemctx(rt, root, hosts, version, previous, command) {
  const hostMode = hosts.length === 2 ? "all" : hosts[0];
  const args = ["--root", root, "--json"];
  if (!previous || command === "upgrade" || hosts.some((host) => !previous.hosts?.includes(host))) {
    const install = await rt.exec(["bunx", `semctx@${version}`, "install", "--host", hostMode, "--skip-setup", ...args], root);
    const parsed = parseJsonOutput(install);
    if (install.code !== 0 || parsed?.ok !== true || parsed?.dryRun !== false) throw new Error(`Semctx host install: ${shortError(install)}`);
  }
  const setup = await rt.exec(["bunx", `semctx@${version}`, "setup", ...args], root);
  const setupReport = parseJsonOutput(setup);
  if (setupReport?.kind !== "setup" || (setup.code !== 0 && setup.code !== 1)) {
    throw new Error(`Semctx workspace setup: ${shortError(setup)}`);
  }
  if (setup.code === 1 && setupReport.setupReady !== false) {
    throw new Error(`Semctx workspace setup failed unexpectedly: ${shortError(setup)}`);
  }
  return {
    activation: "unknown",
    ready: setupReport.setupReady === true && setupReport.analysisReady === true,
    next: setupReport.setupReady === true && setupReport.analysisReady === true
      ? ["Open a new Codex task or reload Claude plugins; then verify tool visibility"]
      : ["Semctx setup reported incomplete analysis; run semctx doctor and index-health before relying on it"],
  };
}

async function applyAssert(rt, root, hosts, version, preflight) {
  if (preflight.needsInstall) {
    const install = await rt.exec(installPackageCommand(preflight.manager, version), root, 300_000);
    if (install.code !== 0) throw new Error(`AssertLedger package install: ${shortError(install)}`);
  }
  const entry = localAssertEntry(rt, root);
  if (entry?.version !== version) throw new Error(`AssertLedger project executable is not the requested ${version}`);
  for (const host of hosts) {
    const client = host === "claude" ? "claude-code" : "codex";
    const preview = await rt.exec(localAssertCommand(entry, ["setup", root, "--client", client, "--dry-run", "--json"]), root);
    const previewReport = parseJsonOutput(preview);
    if (preview.code !== 0 || !["WOULD_CREATE", "UNCHANGED"].includes(previewReport?.status)) {
      throw new Error(`AssertLedger project preflight (${client}): ${shortError(preview)}`);
    }
    const result = await rt.exec(localAssertCommand(entry, ["setup", root, "--client", client, "--write", "--json"]), root);
    const parsed = parseJsonOutput(result);
    if (result.code !== 0 || !["CREATED", "UNCHANGED"].includes(parsed?.status) || parsed?.mode !== "write") {
      throw new Error(`AssertLedger setup (${client}): ${shortError(result)}`);
    }
  }
  return { activation: "unknown", next: ["Approve or trust the project integration in the selected client, then restart it"] };
}

async function applyCompass(rt, root, hosts, version, preflight) {
  if (preflight.needsInstall) {
    const reinstall = preflight.current === version ? ["--reinstall"] : [];
    const install = await rt.exec(["uv", "tool", "install", ...reinstall, "--python", "3.13", `latent-compass==${version}`], root, 300_000);
    if (install.code !== 0) throw new Error(`Latent Compass tool install: ${shortError(install)}`);
  }
  const entry = await persistentCompassEntry(rt, root);
  if (entry?.version !== version) throw new Error(`Latent Compass persistent executable is not the requested ${version}`);
  for (const host of hosts) {
    const preview = await rt.exec([entry.executable, "host", "install", "--project-root", root, "--host", host, "--dry-run", "--json"], root);
    const previewReport = parseJsonOutput(preview);
    if (preview.code !== 0 || previewReport?.dry_run !== true || !Array.isArray(previewReport.conflicts) || previewReport.conflicts.length > 0) {
      throw new Error(`Latent Compass persistent preflight (${host}): ${shortError(preview)}`);
    }
    const result = await rt.exec([entry.executable, "host", "install", "--project-root", root, "--host", host, "--json"], root);
    const parsed = parseJsonOutput(result);
    if (result.code !== 0 || parsed?.dry_run !== false || !Array.isArray(parsed?.conflicts) || parsed.conflicts.length > 0) {
      throw new Error(`Latent Compass hook install (${host}): ${shortError(result)}`);
    }
  }
  return { activation: "unknown", next: ["Review and trust the exact hook in Codex /hooks or the Claude hook settings; inspect latent-compass-status after use"] };
}

async function diagnoseSemctx(rt, root, hosts, version) {
  const nativeCommands = [
    ["bunx", `semctx@${version}`, "plugin-status", "--host", hosts.length === 2 ? "all" : hosts[0], "--root", root, "--json"],
    ["bunx", `semctx@${version}`, "doctor", "--root", root, "--json"],
    ["bunx", `semctx@${version}`, "index-health", "--root", root, "--json"],
  ];
  const checks = [];
  for (const argv of nativeCommands) {
    const result = await rt.exec(argv, root);
    checks.push({ command: argv[2], exitCode: result.code, report: parseJsonOutput(result) });
  }
  const delivery = checks[0].report;
  const validDelivery = delivery?.hosts && checks[0].exitCode <= 2 && hosts.every((host) => {
    const item = delivery.hosts[host];
    return item?.installed?.version === version && item?.marketplace?.matchesSemctx === true
      && item?.installed?.contentMatchesSnapshot !== false;
  });
  const workspaceReady = checks[1].exitCode === 0 && checks[1].report !== null
    && checks[2].exitCode === 0 && checks[2].report !== null;
  const loaded = validDelivery && hosts.every((host) => delivery.hosts[host]?.session?.status === "observed") ? "yes" : "unknown";
  return {
    name: "semctx", version, installed: validDelivery ? "yes" : "no",
    configured: workspaceReady ? "yes" : "no", loaded, trusted: "unknown", observed: "unknown",
    checks, ready: validDelivery && workspaceReady,
  };
}

async function diagnoseAssert(rt, root, hosts, version) {
  const entry = localAssertEntry(rt, root);
  if (entry?.version !== version) {
    return { name: "assertledger", version, installed: "no", configured: "unknown", loaded: "unknown", trusted: "unknown", observed: "unknown", checks: [], ready: false };
  }
  const checks = [];
  for (const host of hosts) {
    const client = host === "claude" ? "claude-code" : "codex";
    const argv = localAssertCommand(entry, ["setup", root, "--client", client, "--dry-run", "--json"]);
    const result = await rt.exec(argv, root);
    checks.push({ command: `setup:${client}`, exitCode: result.code, report: parseJsonOutput(result) });
  }
  const configured = checks.every((item) => item.exitCode === 0 && item.report?.status === "UNCHANGED"
    && item.report?.mode === "dry-run" && item.report.artifacts?.every((artifact) => artifact.state === "UNCHANGED"));
  return {
    name: "assertledger", version, installed: "yes", configured: configured ? "yes" : "no",
    loaded: "unknown", trusted: "unknown", observed: "unknown", checks, ready: configured,
  };
}

async function diagnoseCompass(rt, root, hosts, version) {
  const entry = await persistentCompassEntry(rt, root);
  if (entry?.version !== version) {
    return { name: "latent-compass", version, installed: "no", configured: "unknown", loaded: "unknown", trusted: "unknown", observed: "unknown", checks: [], ready: false };
  }
  const checks = [];
  for (const host of hosts) {
    const result = await rt.exec([entry.executable, "host", "status", "--project-root", root, "--host", host, "--json"], root);
    checks.push({ command: `host-status:${host}`, exitCode: result.code, report: parseJsonOutput(result) });
  }
  const healthy = checks.every((item, index) => {
    const host = hosts[index];
    const status = item.report?.hosts?.find((entry) => entry.host === host)?.status;
    return item.exitCode === 0 && ["NO_OBSERVATIONS", "OBSERVING"].includes(status)
      && item.report?.states?.[host]?.installed === true && item.report.states[host].configured === true;
  });
  const observed = healthy && checks.every((item, index) => item.report.states[hosts[index]].observed === true) ? "yes" : healthy ? "no" : "unknown";
  return {
    name: "latent-compass", version, installed: "yes", configured: healthy ? "yes" : "no",
    loaded: "unknown", trusted: "unknown", observed, checks, ready: healthy,
  };
}

export async function execute(options, rt = createRuntime()) {
  const report = reportFor(options);
  if (!rt.which("bun") || !rt.which("bunx")) return problem(report, "BUN_REQUIRED", "Bun >=1.4 is required", 3);
  const bun = await rt.exec(["bun", "--version"], ".");
  const bunVersion = bun.stdout.trim().match(/^(\d+)\.(\d+)\./u);
  if (!bunVersion || Number(bunVersion[1]) < 1 || (Number(bunVersion[1]) === 1 && Number(bunVersion[2]) < 4)) {
    return problem(report, "BUN_VERSION", "Bun >=1.4 is required", 3);
  }
  const project = rt.resolve(options.project);
  const rootResult = await rt.exec(["git", "-C", project, "rev-parse", "--show-toplevel"], project);
  if (rootResult.code !== 0) return problem(report, "GIT_REPOSITORY_REQUIRED", "Open a Git repository and retry", 3);
  const root = rt.realpath(rootResult.stdout.trim());
  report.projectRoot = root;
  const hosts = options.host === "auto" ? HOSTS.filter((host) => rt.which(host))
    : options.host === "all" ? HOSTS : [options.host];
  if (hosts.length === 0 || hosts.some((host) => !rt.which(host))) {
    return problem(report, "HOST_UNAVAILABLE", `Requested host is not on PATH: ${options.host}`, 3);
  }
  report.hosts = hosts;
  let state;
  const statePath = rt.statePath(root);
  try {
    state = validateState(rt.readState(statePath));
    if (state && state.projectRoot !== root) throw new Error("State belongs to another repository");
  } catch (error) {
    return problem(report, "STATE_CONFLICT", String(error.message ?? error));
  }
  if (options.command === "doctor") {
    const names = new Set(["semctx", ...options.with, ...Object.keys(state?.components ?? {})]);
    for (const name of COMPONENTS.filter((item) => names.has(item))) {
      const version = state?.components?.[name]?.version ?? null;
      if (!version) {
        report.components.push({ name, installed: "unknown", configured: "unknown", loaded: "unknown", trusted: "unknown", observed: "unknown" });
        problem(report, "DOCTOR_UNMANAGED", `${name} has no devkit installation record; run setup or inspect its native CLI`, 3);
        continue;
      }
      try {
        const diagnostic = name === "semctx" ? await diagnoseSemctx(rt, root, hosts, version)
          : name === "assertledger" ? await diagnoseAssert(rt, root, hosts, version)
            : await diagnoseCompass(rt, root, hosts, version);
        const { ready, ...publicDiagnostic } = diagnostic;
        report.components.push(publicDiagnostic);
        if (!ready) problem(report, "DOCTOR_NOT_READY", `${name}: installed=${diagnostic.installed}, configured=${diagnostic.configured}`, 3);
      } catch (error) {
        report.components.push({ name, version, installed: "unknown", configured: "unknown", loaded: "unknown", trusted: "unknown", observed: "unknown" });
        problem(report, "DOCTOR_UNAVAILABLE", `${name}: ${String(error.message ?? error)}`, 3);
      }
    }
    report.ok = report.conflicts.length === 0;
    return report;
  }
  const versions = await resolveComponents(rt, options, state, root, report);
  if (report.conflicts.length) return report;
  const previews = {};
  for (const name of COMPONENTS.filter((item) => versions[item])) {
    const previous = state?.components?.[name];
    const version = versions[name];
    if (name === "semctx") previews[name] = await preflightSemctx(rt, root, hosts, version, previous, options.command, report);
    else if (name === "assertledger") previews[name] = await preflightAssert(rt, root, hosts, version, previous, options.command, report);
    else previews[name] = await preflightCompass(rt, root, hosts, version, previous, options.command, report);
    report.components.push({ name, version, state: "planned", loaded: "unknown", trusted: "unknown", observed: "unknown" });
  }
  if (report.conflicts.length || options.dryRun) {
    report.ok = report.conflicts.length === 0;
    return report;
  }
  const nextState = state ?? { schemaVersion: 1, projectRoot: root, components: {} };
  let releaseLock;
  try {
    releaseLock = rt.acquireLock(statePath);
    // Preflights can take time. Another setup may have committed while they ran.
    // Revalidate under the exclusive lock before applying or recording anything.
    const currentState = validateState(rt.readState(statePath));
    if (JSON.stringify(currentState) !== JSON.stringify(state)) {
      return problem(report, "STATE_CHANGED", "Installation state changed during preflight. Re-run setup to recompute the plan.", 4);
    }
    for (const component of report.components) {
      const { name, version } = component;
      try {
        let result;
        if (name === "semctx") result = await applySemctx(rt, root, hosts, version, nextState.components[name], options.command);
        else if (name === "assertledger") result = await applyAssert(rt, root, hosts, version, previews[name]);
        else result = await applyCompass(rt, root, hosts, version, previews[name]);
        nextState.components[name] = { version, hosts: [...new Set([...(nextState.components[name]?.hosts ?? []), ...hosts])] };
        rt.writeState(statePath, nextState);
        component.state = result.ready === false ? "needs-attention" : "configured";
        component.loaded = result.activation;
        report.nextActions.push(...result.next);
        if (result.ready === false) {
          problem(report, "SEMCTX_NOT_READY", "Semctx installed but its workspace analysis is incomplete", 3);
          break;
        }
      } catch (error) {
        component.state = "partial";
        problem(report, "APPLY_FAILED", `${name}: ${String(error.message ?? error)}. Re-run setup after resolving the error.`, 5);
        break;
      }
    }
  } catch (error) {
    problem(report, "RUN_LOCKED", String(error.message ?? error), 4);
  } finally {
    releaseLock?.();
  }
  report.ok = report.conflicts.length === 0;
  return report;
}

function usage() {
  return `hoklims-devkit ${VERSION}\n\nUsage:\n  hoklims-devkit setup [repository] [--host auto|codex|claude|all] [--with assertledger,latent-compass] [--dry-run] [--json]\n  hoklims-devkit doctor [repository] [--host auto|codex|claude|all] [--json]\n  hoklims-devkit upgrade [repository] [--host auto|codex|claude|all] [--with assertledger,latent-compass] [--dry-run] [--json]\n\nsetup installs Semctx by default. --with adds optional tools. setup keeps installed versions; upgrade resolves new stable versions.\n`;
}

export async function main(argv, rt = createRuntime(), out = process.stdout, err = process.stderr) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err.write(`${error.message}\n${usage()}`);
    return 64;
  }
  if (options.help) { out.write(usage()); return 0; }
  if (options.version) { out.write(`${VERSION}\n`); return 0; }
  let report;
  try {
    report = await execute(options, rt);
  } catch (error) {
    report = problem(reportFor(options), "UNEXPECTED_ERROR", String(error.message ?? error), 5);
  }
  if (options.json) out.write(`${JSON.stringify(report)}\n`);
  else {
    out.write(`${report.ok ? "OK" : "BLOCKED"} ${options.command} ${report.projectRoot ?? options.project}\n`);
    for (const component of report.components) out.write(`  ${component.name} ${component.version ?? ""} ${component.state ?? component.configured ?? "unknown"}\n`);
    for (const conflict of report.conflicts) err.write(`  ${conflict.code}: ${conflict.detail}\n`);
    for (const next of [...new Set(report.nextActions)]) out.write(`Next: ${next}\n`);
  }
  return report.ok ? 0 : report.exitCode ?? 4;
}
