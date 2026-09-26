import { join } from "node:path";
import { homedir } from "node:os";
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
  const options = { command, project: ".", host: "auto", with: [], dryRun: false, json: false, refreshPending: false };
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
    else if (arg === "--refresh-pending") options.refreshPending = true;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (hasProject) throw new UsageError("Only one repository path is accepted");
    else {
      options.project = arg;
      hasProject = true;
    }
  }
  if (!["auto", "codex", "claude", "all"].includes(options.host)) throw new UsageError("--host must be auto, codex, claude, or all");
  if (options.refreshPending && command !== "upgrade") throw new UsageError("--refresh-pending is only valid with upgrade");
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
  const declarations = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .filter((group) => manifest?.[group]?.assertledger !== undefined)
    .map((group) => ({ group, version: manifest[group].assertledger }));
  if (declarations.length === 0) return null;
  for (const { group, version } of declarations) {
    if (!isStableVersion(version)) {
      throw new Error(`AssertLedger dependency in ${group} must be pinned exactly; found ${String(version)}`);
    }
  }
  if (new Set(declarations.map(({ version }) => version)).size !== 1) {
    throw new Error(`Conflicting AssertLedger dependency declarations: ${declarations.map(({ group, version }) => `${group}=${version}`).join(", ")}`);
  }
  return declarations[0].version;
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

function uvToolVersion(output, stderr = "") {
  if (!output.trim() && stderr.trim() === "No tools installed") return null;
  if (stderr.trim()) throw new Error(`uv tool list reported an unexpected message: ${stderr.trim().slice(0, 100)}`);
  const lines = output.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === "No tools installed") return null;
  if (lines.length === 0) throw new Error("uv tool list returned an empty inventory");
  let version = null;
  let sawTool = false;
  for (const line of lines) {
    if (/^-[ ]+\S+/u.test(line)) {
      if (!sawTool) throw new Error("uv tool list has an executable without a tool");
      continue;
    }
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*) v([^\s]+)$/u);
    if (!match) throw new Error(`uv tool list has an unrecognized line: ${line.slice(0, 100)}`);
    sawTool = true;
    if (match[1] === "latent-compass") {
      if (version || !isStableVersion(match[2])) throw new Error("uv tool list has an invalid Latent Compass version");
      version = match[2];
    }
  }
  return version;
}

function validCompassInstallReport(rt, parsed, root, host, version, dryRun) {
  const hostDir = `.${host}`;
  const expected = [
    `${hostDir}/latent-compass-shadow/runtime/latent-compass-shadow-hook.py`,
    `${hostDir}/${host === "codex" ? "hooks.json" : "settings.json"}`,
    `${hostDir}/latent-compass-shadow/config.json`,
    `${hostDir}/latent-compass-shadow/ownership.json`,
  ];
  let home;
  let project;
  try {
    home = rt.realpath(homedir()).replaceAll("\\", "/");
    project = rt.realpath(parsed?.project_root);
  } catch {
    return false;
  }
  return parsed?.schema_version === 1 && parsed.operation === "install" && parsed.version === version
    && project === root
    && parsed.dry_run === dryRun && Array.isArray(parsed.hosts) && parsed.hosts.length === 1
    && parsed.hosts[0] === host && Array.isArray(parsed.files) && parsed.files.length === expected.length
    && expected.every((relativePath) => parsed.files.filter((file) => {
      if (typeof file?.path !== "string") return false;
      const normalized = file.path.replaceAll("\\", "/");
      const suffix = `/${relativePath}`;
      if (!normalized.endsWith(suffix)) return false;
      try {
        return rt.realpath(normalized.slice(0, -suffix.length)).replaceAll("\\", "/") === home;
      } catch {
        return false;
      }
    }).length === 1)
    && parsed.files.every((file) => typeof file?.path === "string" && file.path.length > 0
      && ["create", "update", "unchanged"].includes(file.action))
    && Array.isArray(parsed.conflicts) && parsed.conflicts.length === 0
    && typeof parsed.states?.[host]?.installed === "boolean"
    && typeof parsed.states?.[host]?.configured === "boolean";
}

function validSemctxSetupPlan(parsed, root) {
  return parsed?.schemaVersion === 1 && parsed.kind === "setup_plan" && parsed.verdict === "SETUP_PLANNED"
    && parsed.repositoryRoot === root && Array.isArray(parsed.plannedChanges)
    && parsed.plannedChanges.every((path) => typeof path === "string" && path.length > 0)
    && ["create", "keep"].includes(parsed.config?.action) && Array.isArray(parsed.semantic?.files)
    && parsed.index?.status === "not-run" && parsed.index.reason === "dry-run"
    && parsed.analysisReady === "unknown" && parsed.setupReady === "unknown";
}

function optionalNativeRootMatches(rt, parsed, root) {
  if (parsed?.repositoryRoot === undefined) return true;
  try {
    return typeof parsed.repositoryRoot === "string" && rt.realpath(parsed.repositoryRoot) === root;
  } catch {
    return false;
  }
}

function validSemctxHostPlan(rt, parsed, root, hosts, version, selection) {
  return optionalNativeRootMatches(rt, parsed, root)
    && parsed?.ok === true && parsed.version === version && parsed.dryRun === true
    && parsed.selection === selection && hosts.every((host) => parsed.hosts?.[host]?.requested === true
      && parsed.hosts[host].detected === true && parsed.hosts[host].status === "planned");
}

function fileBelongsToRoot(rt, path, relativePath, root) {
  if (typeof path !== "string") return false;
  const normalized = path.replaceAll("\\", "/");
  const suffix = `/${relativePath}`;
  if (!normalized.endsWith(suffix)) return false;
  try {
    return rt.realpath(normalized.slice(0, -suffix.length)) === root;
  } catch {
    return false;
  }
}

function validAssertSetupReport(rt, parsed, root, client, mode, statuses, artifactStates) {
  const expected = [
    ["init", "assertledger.config.json"], ["init", "assertledger.lock.json"],
    ["connection", client === "codex" ? ".codex/config.toml" : ".mcp.json"],
    ["connection", client === "codex" ? ".agents/skills/assertledger/SKILL.md" : ".claude/skills/assertledger/SKILL.md"],
  ];
  return statuses.includes(parsed?.status) && parsed.client === client && parsed.mode === mode
    && Array.isArray(parsed.artifacts) && parsed.artifacts.length === expected.length
    && expected.every(([owner, relativePath]) => parsed.artifacts.filter((artifact) => artifact?.owner === owner
      && fileBelongsToRoot(rt, artifact.path, relativePath, root)).length === 1)
    && parsed.artifacts.every((artifact) => ["init", "connection"].includes(artifact?.owner)
      && typeof artifact.path === "string" && artifact.path.length > 0
      && artifactStates.includes(artifact.state))
    && (mode === "dry-run" ? ["WOULD_CREATE", "UNCHANGED"].includes(parsed.init?.status)
      && parsed.connection?.status === "EMITTED"
      : ["CREATED", "UNCHANGED"].includes(parsed.init?.status)
        && ["CREATED", "UNCHANGED"].includes(parsed.connection?.status))
    && parsed.connection?.client === client
    && parsed.rollback?.status === "NOT_REQUIRED";
}

function recognizableCompassStatus(rt, parsed, root, host, version) {
  if (parsed?.schema_version !== 1 || parsed.operation !== "status" || parsed.version !== version
    || typeof parsed.project_root !== "string" || !Array.isArray(parsed.hosts) || parsed.hosts.length !== 1
    || parsed.hosts[0]?.host !== host
    || !["NO_OBSERVATIONS", "OBSERVING", "OBSERVATION_UNKNOWN", "DEGRADED"].includes(parsed.hosts[0].status)
    || typeof parsed.states?.[host]?.installed !== "boolean"
    || typeof parsed.states?.[host]?.configured !== "boolean"
    || (parsed.hosts[0].status === "OBSERVATION_UNKNOWN" && parsed.states[host].observed !== "UNKNOWN")) return false;
  try {
    return rt.realpath(parsed.project_root) === root;
  } catch {
    return false;
  }
}

async function persistentCompassEntry(rt, root) {
  const bin = await rt.exec(["uv", "tool", "dir", "--bin"], root);
  if (bin.code !== 0) throw new Error(`uv tool dir --bin: ${shortError(bin)}`);
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

function selectedComponents(options, state) {
  const selected = new Set(["semctx", ...options.with]);
  if (options.command !== "setup" && options.with.length === 0) {
    for (const name of Object.keys(state?.components ?? {})) selected.add(name);
    for (const name of state?.inProgress?.selected ?? []) selected.add(name);
  }
  return COMPONENTS.filter((name) => selected.has(name));
}

function semctxStatusHasHosts(rt, status, root, hosts) {
  return optionalNativeRootMatches(rt, status, root)
    && status?.schemaVersion === 2 && status.kind === "plugin_delivery_status"
    && hosts.every((host) => status.hosts?.[host]?.requested === true
      && status.hosts[host].installed
      && (status.hosts[host].installed.version === null || isStableVersion(status.hosts[host].installed.version))
      && [true, false, null].includes(status.hosts[host].installed.contentMatchesSnapshot)
      && [true, false, null].includes(status.hosts[host].marketplace?.matchesSemctx));
}

function semctxWorkspaceStatus(rt, root, doctorResult, healthResult, version) {
  const doctor = doctorResult.report ?? parseJsonOutput(doctorResult);
  const health = healthResult.report ?? parseJsonOutput(healthResult);
  for (const candidate of [doctor?.repositoryRoot, health?.repositoryRoot]) {
    if (candidate === undefined) continue;
    try {
      if (typeof candidate !== "string" || rt.realpath(candidate) !== root) return "unknown";
    } catch {
      return "unknown";
    }
  }
  const doctorCode = doctorResult.exitCode ?? doctorResult.code;
  const healthCode = healthResult.exitCode ?? healthResult.code;
  const requiredChecks = ["cli", "workspace", "config", "index", "runtime"];
  const doctorStructured = [0, 1].includes(doctorCode) && typeof doctor?.healthy === "boolean"
    && doctor.version === version && Array.isArray(doctor.checks)
    && requiredChecks.every((name) => doctor.checks.some((check) => check.name === name && typeof check.ok === "boolean"));
  const healthStructured = [0, 2, 3].includes(healthCode) && health?.schemaVersion === 1
    && health.kind === "index_health" && ["valid", "invalid", "absent"].includes(health.binding?.status)
    && typeof health.freshness?.canRunHighRiskControl === "boolean"
    && ["complete", "partial", "insufficient"].includes(health.coverage?.status);
  if (!doctorStructured || !healthStructured) return "unknown";
  const doctorReady = doctorCode === 0 && doctor?.healthy === true && doctor.version === version
    && Array.isArray(doctor.checks) && requiredChecks.every((name) => doctor.checks.some((check) =>
      check.name === name && check.ok === true && (name !== "index" || check.status === "healthy")));
  const indexReady = healthCode === 0 && health?.schemaVersion === 1 && health.kind === "index_health"
    && health.binding?.status === "valid" && health.freshness?.canRunHighRiskControl === true
    && health.coverage?.status === "complete";
  return doctorReady && indexReady ? "yes" : "no";
}

async function resolveComponents(rt, options, state, root, report) {
  const versions = {};
  for (const name of selectedComponents(options, state)) {
    try {
      if (state?.inProgress?.versions[name] && !options.refreshPending) {
        versions[name] = state.inProgress.versions[name];
      } else if (options.command !== "upgrade" && state?.components?.[name]?.version) {
        versions[name] = state.components[name].version;
      } else if (name === "assertledger" && options.command === "setup" && existingAssertVersion(rt, root)) {
        versions[name] = existingAssertVersion(rt, root);
      } else if (name === "latent-compass" && options.command === "setup" && rt.which("uv")) {
        const listed = await rt.exec(["uv", "tool", "list"], root);
        if (listed.code !== 0) throw new Error(`uv tool list: ${shortError(listed)}`);
        versions[name] = uvToolVersion(listed.stdout, listed.stderr) ?? await resolveVersion(rt, name);
      } else {
        versions[name] = await resolveVersion(rt, name);
      }
      if (!isStableVersion(versions[name])) throw new Error(`Invalid ${name} version`);
      // 0.3.3 accepts `setup --dry-run` but writes workspace files. Never invoke it as a preflight.
      if (name === "semctx" && compareVersions(versions[name], "0.3.4") < 0) {
        throw new Error("Semctx before 0.3.4 has no safe workspace preflight");
      }
    } catch (error) {
      problem(report, name === "semctx" ? "RELEASE_SKEW_OR_UNAVAILABLE" : "VERSION_UNAVAILABLE", `${name}: ${String(error.message ?? error)}`, 3);
    }
  }
  return versions;
}

async function preflightSemctx(rt, root, hosts, version, previous, command, report, pendingVersion) {
  const hostMode = hosts.length === 2 ? "all" : hosts[0];
  const args = ["--root", root, "--json"];
  let hostInstallNeeded = command === "upgrade" || !previous || hosts.some((host) => !previous.hosts?.includes(host));
  const setup = await rt.exec(["bunx", `semctx@${version}`, "setup", "--dry-run", ...args], root);
  const setupJson = nativeResult(setup, "semctx setup --dry-run", report);
  if (!setupJson) return null;
  if (setup.code !== 0 || !validSemctxSetupPlan(setupJson, root)) {
    problem(report, "SEMCTX_WORKSPACE_CONFLICT", JSON.stringify(setupJson).slice(0, 600));
  }
  const status = await rt.exec(["bunx", `semctx@${version}`, "plugin-status", "--host", hostMode, ...args], root);
  const statusJson = nativeResult(status, "semctx plugin-status", report);
  if (!statusJson) return null;
  if (![0, 2, 3].includes(status.code) || !semctxStatusHasHosts(rt, statusJson, root, hosts)) {
    problem(report, "SEMCTX_STATUS_INVALID", `Semctx plugin-status returned incomplete or failed host evidence (exit ${status.code})`);
    return null;
  }
  if (previous && hosts.some((host) => statusJson.hosts[host].installed.version === null)) hostInstallNeeded = true;
  for (const host of hosts) {
    const installed = statusJson.hosts[host].installed;
    if (installed.version !== null && statusJson.hosts[host].marketplace?.matchesSemctx !== true) {
      problem(report, "SEMCTX_MARKETPLACE_CONFLICT", `${host} Semctx plugin is not from the expected marketplace`);
    }
    if (installed.version === version && installed.contentMatchesSnapshot === false) {
      // A pinned retry must not replace modified plugin bytes, even when upgrade is explicit.
      problem(report, "SEMCTX_CONTENT_DRIFT", `${host} Semctx plugin bytes differ from its marketplace snapshot; inspect or repair with the native installer`);
    } else if (previous && installed.version === version && installed.contentMatchesSnapshot !== true) {
      problem(report, "SEMCTX_CONTENT_UNVERIFIED", `${host} Semctx plugin content is unverified; inspect semctx plugin-status before retrying`);
    }
  }
  if (previous && hosts.every((host) => previous.hosts?.includes(host))
    && hosts.every((host) => statusJson.hosts[host].installed.version === version
    && statusJson.hosts[host].installed.contentMatchesSnapshot === true
    && statusJson.hosts[host].marketplace?.matchesSemctx === true)) hostInstallNeeded = false;
  const installedVersions = hosts.map((host) => statusJson.hosts?.[host]?.installed?.version).filter((value) => isStableVersion(value));
  if (command !== "upgrade" && !previous && installedVersions.some((installed) => installed !== version)) {
    problem(report, "EXISTING_VERSION", `Semctx is already installed at ${[...new Set(installedVersions)].join(", ")}; use upgrade explicitly`);
  }
  if (previous && installedVersions.some((installed) => installed !== previous.version
    && !(command === "upgrade" && (installed === version || installed === pendingVersion)))) {
    problem(report, "INSTALLED_VERSION_DRIFT", `Semctx installation differs from recorded ${previous.version}`);
  }
  if (hostInstallNeeded) {
    try {
      await checkSemctxChannel(rt, version);
    } catch (error) {
      problem(report, "RELEASE_SKEW_OR_UNAVAILABLE", `Semctx host installation: ${String(error.message ?? error)}`, 3);
      return null;
    }
  }
  let hostJson = { ok: true, dryRun: true, hosts: {}, skipped: true };
  if (hostInstallNeeded) {
    const host = await rt.exec(["bunx", `semctx@${version}`, "install", "--host", hostMode, "--skip-setup", "--dry-run", ...args], root);
    hostJson = nativeResult(host, "semctx install --dry-run", report);
    if (!hostJson) return null;
    if (host.code !== 0 || !validSemctxHostPlan(rt, hostJson, root, hosts, version, hostMode)) {
      problem(report, "SEMCTX_HOST_CONFLICT", JSON.stringify(hostJson).slice(0, 600));
    }
  }
  let skipSetup = false;
  if (previous && !hostInstallNeeded && Array.isArray(setupJson.plannedChanges)
    && setupJson.plannedChanges.length === 0 && report.conflicts.length === 0) {
    const doctor = await rt.exec(["bunx", `semctx@${version}`, "doctor", ...args], root);
    const health = await rt.exec(["bunx", `semctx@${version}`, "index-health", ...args], root);
    skipSetup = semctxWorkspaceStatus(rt, root, doctor, health, version) === "yes";
  }
  report.plannedChanges.push({ component: "semctx", workspace: setupJson, hosts: hostJson.hosts });
  return { setup: setupJson, host: hostJson, hostInstallNeeded, skipSetup };
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
    if (result.code !== 0 || !validAssertSetupReport(rt, parsed, root, client, "dry-run", ["WOULD_CREATE", "UNCHANGED"], ["WOULD_CREATE", "UNCHANGED"])) {
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

async function preflightCompass(rt, root, hosts, version, previous, command, report, pendingVersion) {
  if (!rt.which("uv")) {
    problem(report, "UV_REQUIRED", "Latent Compass needs uv on PATH", 3);
    return null;
  }
  const listed = await rt.exec(["uv", "tool", "list"], root);
  if (listed.code !== 0) {
    problem(report, "UV_TOOL_INVENTORY_FAILED", `uv tool list: ${shortError(listed)}`, 3);
    return null;
  }
  let current;
  try {
    current = uvToolVersion(listed.stdout, listed.stderr);
  } catch (error) {
    problem(report, "UV_TOOL_INVENTORY_FAILED", String(error.message ?? error), 3);
    return null;
  }
  if (command !== "upgrade" && current && current !== version) problem(report, "EXISTING_VERSION", `Latent Compass is installed at ${current}; use upgrade explicitly`);
  if (previous && current && current !== previous.version
    && !(command === "upgrade" && (current === version || current === pendingVersion))) {
    problem(report, "INSTALLED_VERSION_DRIFT", `Latent Compass installation differs from recorded ${previous.version}`);
  }
  let entry;
  try {
    entry = await persistentCompassEntry(rt, root);
  } catch (error) {
    problem(report, "UV_TOOL_INVENTORY_FAILED", String(error.message ?? error), 3);
    return null;
  }
  const needsInstall = current !== version || entry?.version !== version;
  const previews = [];
  for (const host of hosts) {
    const commandLine = !needsInstall
      ? [entry.executable, "host", "install", "--project-root", root, "--host", host, "--dry-run", "--json"]
      : ["uv", "tool", "run", "--from", `latent-compass==${version}`, "latent-compass", "host", "install", "--project-root", root, "--host", host, "--dry-run", "--json"];
    const result = await rt.exec(commandLine, root);
    const parsed = nativeResult(result, `latent-compass host install (${host})`, report);
    if (!parsed) continue;
    if (result.code !== 0 || !validCompassInstallReport(rt, parsed, root, host, version, true)) {
      problem(report, "COMPASS_HOOK_CONFLICT", JSON.stringify(parsed).slice(0, 600));
    }
    previews.push({ host, files: parsed.files ?? [], conflicts: parsed.conflicts ?? [] });
  }
  report.plannedChanges.push({ component: "latent-compass", installTool: needsInstall, previews });
  return { current, needsInstall, previews };
}

async function applySemctx(rt, root, hosts, version, preflight) {
  const hostMode = hosts.length === 2 ? "all" : hosts[0];
  const args = ["--root", root, "--json"];
  if (preflight.hostInstallNeeded) {
    const install = await rt.exec(["bunx", `semctx@${version}`, "install", "--host", hostMode, "--skip-setup", ...args], root);
    const parsed = parseJsonOutput(install);
    if (install.code !== 0 || parsed?.ok !== true || parsed?.dryRun !== false) throw new Error(`Semctx host install: ${shortError(install)}`);
  }
  let ready = true;
  if (!preflight.skipSetup) {
    const setup = await rt.exec(["bunx", `semctx@${version}`, "setup", ...args], root);
    const setupReport = parseJsonOutput(setup);
    if (setupReport?.schemaVersion !== 1 || setupReport.kind !== "setup" || setupReport.repositoryRoot !== root
      || !["SETUP_READY", "SETUP_NOT_READY"].includes(setupReport.verdict)
      || (setupReport.verdict === "SETUP_READY") !== (setupReport.setupReady === true && setupReport.analysisReady === true && setupReport.check?.ok === true)
      || (setup.code !== 0 && setup.code !== 1)) {
      throw new Error(`Semctx workspace setup: ${shortError(setup)}`);
    }
    if (setup.code === 1 && setupReport.setupReady !== false) {
      throw new Error(`Semctx workspace setup failed unexpectedly: ${shortError(setup)}`);
    }
    ready = setupReport.verdict === "SETUP_READY" && setupReport.setupReady === true
      && setupReport.analysisReady === true && setupReport.check.ok === true;
  }
  const status = await rt.exec(["bunx", `semctx@${version}`, "plugin-status", "--host", hostMode, ...args], root);
  const delivery = parseJsonOutput(status);
  if (![0, 2, 3].includes(status.code) || !semctxStatusHasHosts(rt, delivery, root, hosts)
    || hosts.some((host) => delivery.hosts[host].installed.version !== version
      || delivery.hosts[host].marketplace?.matchesSemctx !== true
      || delivery.hosts[host].installed.contentMatchesSnapshot !== true)) {
    throw new Error("Semctx installation could not be verified from plugin-status; inspect the native report before retrying");
  }
  return {
    activation: "unknown",
    ready,
    next: ready
      ? preflight.skipSetup ? [] : ["Open a new Codex task or reload Claude plugins; then verify tool visibility"]
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
    if (preview.code !== 0 || !validAssertSetupReport(rt, previewReport, root, client, "dry-run", ["WOULD_CREATE", "UNCHANGED"], ["WOULD_CREATE", "UNCHANGED"])) {
      throw new Error(`AssertLedger project preflight (${client}): ${shortError(preview)}`);
    }
    const result = await rt.exec(localAssertCommand(entry, ["setup", root, "--client", client, "--write", "--json"]), root);
    const parsed = parseJsonOutput(result);
    if (result.code !== 0 || !validAssertSetupReport(rt, parsed, root, client, "write", ["CREATED", "UNCHANGED"], ["CREATED", "UNCHANGED"])) {
      throw new Error(`AssertLedger setup (${client}): ${shortError(result)}`);
    }
    const verify = await rt.exec(localAssertCommand(entry, ["setup", root, "--client", client, "--dry-run", "--json"]), root);
    const verified = parseJsonOutput(verify);
    if (verify.code !== 0 || !validAssertSetupReport(rt, verified, root, client, "dry-run", ["UNCHANGED"], ["UNCHANGED"])) {
      throw new Error(`AssertLedger post-install verification (${client}): ${shortError(verify)}`);
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
    if (preview.code !== 0 || !validCompassInstallReport(rt, previewReport, root, host, version, true)) {
      throw new Error(`Latent Compass persistent preflight (${host}): ${shortError(preview)}`);
    }
    const result = await rt.exec([entry.executable, "host", "install", "--project-root", root, "--host", host, "--json"], root);
    const parsed = parseJsonOutput(result);
    if (result.code !== 0 || !validCompassInstallReport(rt, parsed, root, host, version, false)
      || parsed.states?.[host]?.installed !== true || parsed.states?.[host]?.configured !== true) {
      throw new Error(`Latent Compass hook install (${host}): ${shortError(result)}`);
    }
    const status = await rt.exec([entry.executable, "host", "status", "--project-root", root, "--host", host, "--json"], root);
    const observed = parseJsonOutput(status);
    if (status.code !== 0 || !recognizableCompassStatus(rt, observed, root, host, version)
      || !["NO_OBSERVATIONS", "OBSERVING", "OBSERVATION_UNKNOWN"].includes(observed.hosts[0].status)
      || observed.states?.[host]?.installed !== true || observed.states?.[host]?.configured !== true) {
      throw new Error(`Latent Compass post-install status (${host}): ${shortError(status)}`);
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
  const validStatus = [0, 2, 3].includes(checks[0].exitCode) && semctxStatusHasHosts(rt, delivery, root, hosts);
  const validDelivery = validStatus && hosts.every((host) => {
    const item = delivery.hosts[host];
    return item?.installed?.version === version && item?.marketplace?.matchesSemctx === true
      && item?.installed?.contentMatchesSnapshot === true;
  });
  const workspaceStatus = semctxWorkspaceStatus(rt, root, checks[1], checks[2], version);
  const loaded = validDelivery && hosts.every((host) => delivery.hosts[host]?.session?.status === "observed") ? "yes" : "unknown";
  const installed = validDelivery ? "yes"
    : validStatus && hosts.every((host) => delivery.hosts[host].installed.version === null) ? "no" : "unknown";
  return {
    name: "semctx", version, installed,
    configured: workspaceStatus, loaded, approved: "unknown", observed: "unknown",
    checks, ready: validDelivery && workspaceStatus === "yes",
  };
}

async function diagnoseAssert(rt, root, hosts, version) {
  const entry = localAssertEntry(rt, root);
  if (entry?.version !== version) {
    return { name: "assertledger", version, installed: "no", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown", checks: [], ready: false };
  }
  const checks = [];
  for (const host of hosts) {
    const client = host === "claude" ? "claude-code" : "codex";
    const argv = localAssertCommand(entry, ["setup", root, "--client", client, "--dry-run", "--json"]);
    const result = await rt.exec(argv, root);
    checks.push({ command: `setup:${client}`, exitCode: result.code, report: parseJsonOutput(result) });
  }
  const recognizable = checks.every((item, index) => item.report && item.report.mode === "dry-run"
    && item.report.client === (hosts[index] === "claude" ? "claude-code" : "codex")
    && ["UNCHANGED", "WOULD_CREATE", "BLOCKED", "CONFLICT", "PARTIAL_FAILURE"].includes(item.report.status)
    && Array.isArray(item.report.artifacts) && item.report.artifacts.length > 0);
  const configured = recognizable && checks.every((item) => item.exitCode === 0 && item.report.status === "UNCHANGED"
    && validAssertSetupReport(rt, item.report, root, item.command.slice(6), "dry-run", ["UNCHANGED"], ["UNCHANGED"]));
  return {
    name: "assertledger", version, installed: "yes", configured: !recognizable ? "unknown" : configured ? "yes" : "no",
    loaded: "unknown", approved: "unknown", observed: "unknown", checks, ready: configured,
  };
}

async function diagnoseCompass(rt, root, hosts, version) {
  const entry = await persistentCompassEntry(rt, root);
  if (entry?.version !== version) {
    return { name: "latent-compass", version, installed: "no", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown", checks: [], ready: false };
  }
  const checks = [];
  for (const host of hosts) {
    const result = await rt.exec([entry.executable, "host", "status", "--project-root", root, "--host", host, "--json"], root);
    checks.push({ command: `host-status:${host}`, exitCode: result.code, report: parseJsonOutput(result) });
  }
  const recognizable = checks.every((item, index) => {
    const host = hosts[index];
    return recognizableCompassStatus(rt, item.report, root, host, version);
  });
  const healthy = recognizable && checks.every((item, index) => {
    const host = hosts[index];
    const status = item.report?.hosts?.find((entry) => entry.host === host)?.status;
    return item.exitCode === 0 && ["NO_OBSERVATIONS", "OBSERVING", "OBSERVATION_UNKNOWN"].includes(status)
      && item.report?.states?.[host]?.installed === true && item.report.states[host].configured === true;
  });
  const observations = healthy ? checks.map((item, index) => item.report.states[hosts[index]].observed) : [];
  const observed = !healthy || observations.some((value) => typeof value !== "boolean")
    ? "unknown" : observations.every((value) => value === true) ? "yes" : "no";
  return {
    name: "latent-compass", version, installed: "yes", configured: !recognizable ? "unknown" : healthy ? "yes" : "no",
    loaded: "unknown", approved: "unknown", observed, checks, ready: healthy,
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
    const names = new Set(["semctx", ...options.with, ...Object.keys(state?.components ?? {}), ...(state?.inProgress?.selected ?? [])]);
    for (const name of COMPONENTS.filter((item) => names.has(item))) {
      const version = state?.components?.[name]?.version ?? state?.inProgress?.versions[name] ?? null;
      if (!version) {
        report.components.push({ name, installed: "unknown", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown" });
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
        report.components.push({ name, version, installed: "unknown", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown" });
        problem(report, "DOCTOR_UNAVAILABLE", `${name}: ${String(error.message ?? error)}`, 3);
      }
    }
    if (state?.inProgress) {
      problem(report, "INCOMPLETE_OPERATION", `Re-run ${state.inProgress.command} with --host ${state.inProgress.hosts.length === 2 ? "all" : state.inProgress.hosts[0]}${state.inProgress.selected.length > 1 ? ` --with ${state.inProgress.selected.slice(1).join(",")}` : ""} to complete the recorded plan`, 3);
    }
    report.ok = report.conflicts.length === 0;
    return report;
  }
  const selected = selectedComponents(options, state);
  if (state?.inProgress && ((state.inProgress.command !== options.command && !options.refreshPending)
    || JSON.stringify(state.inProgress.hosts) !== JSON.stringify(hosts)
    || JSON.stringify(state.inProgress.selected) !== JSON.stringify(selected))) {
    return problem(report, "PENDING_PLAN_CONFLICT", `Complete the recorded ${state.inProgress.command} plan for ${state.inProgress.hosts.join(",")} and ${state.inProgress.selected.join(",")} before changing selectors`, 4);
  }
  const versions = await resolveComponents(rt, options, state, root, report);
  if (report.conflicts.length) return report;
  if (options.command === "upgrade") {
    for (const name of selected) {
      const previous = state?.components?.[name];
      if (previous && previous.version !== versions[name] && previous.hosts.some((host) => !hosts.includes(host))) {
        problem(report, "HOST_SCOPE_UPGRADE_CONFLICT", `${name} also serves ${previous.hosts.join(",")}; re-run upgrade with --host all to change its shared version safely`);
      }
    }
    if (report.conflicts.length) return report;
  }
  const previews = {};
  for (const name of COMPONENTS.filter((item) => versions[item])) {
    const previous = state?.components?.[name];
    const version = versions[name];
    if (name === "semctx") previews[name] = await preflightSemctx(rt, root, hosts, version, previous, options.command, report, state?.inProgress?.versions.semctx);
    else if (name === "assertledger") previews[name] = await preflightAssert(rt, root, hosts, version, previous, options.command, report);
    else previews[name] = await preflightCompass(rt, root, hosts, version, previous, options.command, report, state?.inProgress?.versions["latent-compass"]);
    report.components.push({ name, version, state: "planned", installed: "unknown", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown" });
  }
  if (report.conflicts.length || options.dryRun) {
    if (state?.inProgress && !options.refreshPending
      && report.conflicts.some((item) => item.code === "RELEASE_SKEW_OR_UNAVAILABLE")) {
      const optional = selected.filter((name) => name !== "semctx");
      report.nextActions.push(`Review the new stable releases, then run hoklims-devkit upgrade ${root} --host ${hosts.length === 2 ? "all" : hosts[0]}${optional.length ? ` --with ${optional.join(",")}` : ""} --refresh-pending`);
    }
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
    let savedState = JSON.stringify(currentState);
    const saveStateIfChanged = () => {
      const next = JSON.stringify(nextState);
      if (next !== savedState) {
        rt.writeState(statePath, nextState);
        savedState = next;
      }
    };
    if (options.command === "upgrade" || state?.inProgress || selected.some((name) => state?.components?.[name]?.version !== versions[name]
      || hosts.some((host) => !state?.components?.[name]?.hosts?.includes(host)))) {
      nextState.inProgress = {
        command: options.command,
        selected,
        hosts,
        versions: Object.fromEntries(selected.map((name) => [name, versions[name]])),
      };
      saveStateIfChanged();
    }
    for (const component of report.components) {
      const { name, version } = component;
      try {
        let result;
        if (name === "semctx") result = await applySemctx(rt, root, hosts, version, previews[name]);
        else if (name === "assertledger") result = await applyAssert(rt, root, hosts, version, previews[name]);
        else result = await applyCompass(rt, root, hosts, version, previews[name]);
        nextState.components[name] = { version, hosts: [...new Set([...(nextState.components[name]?.hosts ?? []), ...hosts])] };
        saveStateIfChanged();
        component.state = result.ready === false ? "needs-attention" : "configured";
        component.installed = "yes";
        component.configured = result.ready === false ? "unknown" : "yes";
        component.loaded = result.activation;
        report.nextActions.push(...result.next);
        if (result.ready === false) {
          problem(report, "SEMCTX_NOT_READY", "Semctx installed but its workspace analysis is incomplete", 3);
          break;
        }
      } catch (error) {
        component.state = "partial";
        component.installed = "unknown";
        component.configured = "unknown";
        problem(report, "APPLY_FAILED", `${name}: ${String(error.message ?? error)}. Re-run setup after resolving the error.`, 5);
        break;
      }
    }
    if (report.conflicts.length === 0 && nextState.inProgress) {
      delete nextState.inProgress;
      saveStateIfChanged();
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
  return `hoklims-devkit ${VERSION}\n\nUsage:\n  hoklims-devkit setup [repository] [--host auto|codex|claude|all] [--with assertledger,latent-compass] [--dry-run] [--json]\n  hoklims-devkit doctor [repository] [--host auto|codex|claude|all] [--json]\n  hoklims-devkit upgrade [repository] [--host auto|codex|claude|all] [--with assertledger,latent-compass] [--dry-run] [--json] [--refresh-pending]\n\nsetup installs Semctx by default. --with adds optional tools. setup keeps installed versions; upgrade resolves new stable versions. --refresh-pending explicitly replaces an interrupted plan with current stable releases.\n`;
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
