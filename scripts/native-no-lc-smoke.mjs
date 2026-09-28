#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2];
assert(configPath, "Usage: node run-native.mjs ABSOLUTE_CONFIG_JSON");
assert(path.isAbsolute(configPath), "Config path must be absolute");
const config = JSON.parse(readFileSync(configPath, "utf8"));

assert(["win32", "linux", "darwin"].includes(process.platform), "Only native Windows, Linux, and macOS runs are supported");
const expectedPlatform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
assert.equal(config.platform, expectedPlatform, `Config platform must be ${expectedPlatform}`);
assert(Number(process.versions.node.split(".")[0]) >= 22, "Node 22 or later is required");
assert.match(config.artifact.sha256, /^[0-9a-f]{64}$/u, "Artifact SHA-256 must be lowercase hex");
assert.match(config.artifact.sourceSha, /^[0-9a-f]{40}$/u, "Devkit source SHA must be lowercase hex");
assert.match(config.expected.semctxPublicationSha, /^[0-9a-f]{40}$/u, "Semctx publication SHA must be lowercase hex");

const runRoot = path.resolve(config.runRoot);
const sourceCheckout = realpathSync(config.sourceCheckout);
const artifactPath = realpathSync(config.artifact.path);
function resolveExecutable(value) {
  if (path.isAbsolute(value)) return realpathSync(value);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${value}${extension}`);
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    }
  }
  throw new Error(`Runtime executable not found on PATH: ${value}`);
}
const runtime = Object.fromEntries(
  Object.entries(config.runtime).map(([key, value]) => [
    key, key === "npmCliJs" ? realpathSync(value) : resolveExecutable(value),
  ]),
);

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

assert(!isWithin(sourceCheckout, runRoot), "runRoot must be outside the source checkout");
assert(!isWithin(runRoot, sourceCheckout), "source checkout must be outside runRoot");
assert(!isWithin(sourceCheckout, artifactPath), "tarball must be outside the source checkout");
assert(!isWithin(scriptRoot, runRoot), "runRoot must be separate from the prepared harness");
const ambientHome = process.env.HOME ?? process.env.USERPROFILE;
const ambientCodexHome = process.env.CODEX_HOME ?? (ambientHome ? path.join(ambientHome, ".codex") : null);
const ambientClaudeHome = process.env.CLAUDE_CONFIG_DIR ?? (ambientHome ? path.join(ambientHome, ".claude") : null);
for (const actualProfile of [ambientCodexHome, ambientClaudeHome].filter(Boolean).map(path.resolve)) {
  assert(!isWithin(actualProfile, runRoot), `runRoot overlaps an actual profile: ${actualProfile}`);
  assert(!isWithin(runRoot, actualProfile), `actual profile is inside runRoot: ${actualProfile}`);
}

function assertNoSymlinkAncestors(target) {
  let current = path.parse(path.resolve(target)).root;
  for (const part of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    assert(!lstatSync(current).isSymbolicLink(), `Symlink boundary rejected: ${current}`);
  }
}

assertNoSymlinkAncestors(path.dirname(runRoot));
assertNoSymlinkAncestors(sourceCheckout);
assertNoSymlinkAncestors(artifactPath);
if (existsSync(runRoot)) {
  assert(lstatSync(runRoot).isDirectory(), "runRoot exists but is not a directory");
  assert.equal(readdirSync(runRoot).length, 0, "runRoot must be fresh and empty");
} else {
  mkdirSync(runRoot, { recursive: true });
}
const physicalRunRoot = realpathSync(runRoot);

const evidenceRoot = path.join(physicalRunRoot, "evidence");
const commandLogRoot = path.join(evidenceRoot, "commands");
const globalRuntimeRoot = path.join(physicalRunRoot, "runtime");
const consumerRoot = path.join(physicalRunRoot, "consumer");
const toolsRoot = path.join(physicalRunRoot, "tools");
for (const directory of [evidenceRoot, commandLogRoot, globalRuntimeRoot, consumerRoot, toolsRoot]) {
  mkdirSync(directory, { recursive: true });
}
copyFileSync(configPath, path.join(evidenceRoot, "input-config.json"));
writeFileSync(path.join(evidenceRoot, "boundary.json"), `${JSON.stringify({
  runRoot: physicalRunRoot,
  sourceCheckout,
  artifactPath,
  actualProfiles: [ambientCodexHome, ambientClaudeHome].filter(Boolean),
  runRootOutsideSource: true,
  artifactOutsideSource: true,
  runRootOutsideActualProfiles: true,
}, null, 2)}\n`);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

assert.equal(sha256File(artifactPath), config.artifact.sha256, "Devkit tarball digest mismatch");

function snapshotTree(root) {
  if (!existsSync(root)) return [];
  const result = [];
  function walk(current, relative) {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = relative ? path.join(relative, name) : name;
      const info = lstatSync(full);
      const recordPath = rel.split(path.sep).join("/");
      if (info.isSymbolicLink()) {
        result.push({ path: recordPath, kind: "symlink", target: readlinkSync(full) });
      } else if (info.isDirectory()) {
        result.push({ path: recordPath, kind: "directory" });
        walk(full, rel);
      } else if (info.isFile()) {
        result.push({ path: recordPath, kind: "file", bytes: info.size, sha256: sha256File(full) });
      } else {
        result.push({ path: recordPath, kind: "other" });
      }
    }
  }
  walk(root, "");
  return result;
}

function snapshotProtected(lane) {
  return {
    repository: snapshotTree(lane.repository),
    profile: snapshotTree(lane.profileRoot),
  };
}

function diffSnapshots(before, after) {
  const beforeMap = new Map();
  const afterMap = new Map();
  for (const [scope, records] of Object.entries(before)) {
    for (const record of records) beforeMap.set(`${scope}/${record.path}`, JSON.stringify(record));
  }
  for (const [scope, records] of Object.entries(after)) {
    for (const record of records) afterMap.set(`${scope}/${record.path}`, JSON.stringify(record));
  }
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys
    .filter((key) => beforeMap.get(key) !== afterMap.get(key))
    .map((key) => ({ path: key, before: beforeMap.get(key) ?? null, after: afterMap.get(key) ?? null }));
}

function cleanBaseEnvironment() {
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "WINDIR",
    "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key) && value !== undefined) environment[key] = value;
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.FORCE_COLOR = "0";
  return environment;
}

let commandCounter = 0;
async function runCommand({ name, executable, args, cwd, env, timeoutMs = 180_000, expect = 0 }) {
  commandCounter += 1;
  const id = `${String(commandCounter).padStart(3, "0")}-${name.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
  const startedAt = new Date().toISOString();
  const result = await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error: null });
    });
  });
  writeFileSync(path.join(commandLogRoot, `${id}.stdout.log`), result.stdout);
  writeFileSync(path.join(commandLogRoot, `${id}.stderr.log`), result.stderr);
  writeFileSync(
    path.join(commandLogRoot, `${id}.json`),
    `${JSON.stringify({
      name,
      executable,
      args,
      cwd,
      startedAt,
      finishedAt: new Date().toISOString(),
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      error: result.error,
    }, null, 2)}\n`,
  );
  assert.equal(result.error, null, `${name} failed to start: ${result.error}`);
  assert.equal(result.timedOut, false, `${name} timed out`);
  assert.equal(result.signal, null, `${name} terminated by ${result.signal}`);
  assert.equal(result.code, expect, `${name} exited ${result.code}: ${result.stderr}`);
  return result;
}

function makeRuntimeEnvironment(root, pathPrefix = null) {
  const environment = cleanBaseEnvironment();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  const localAppData = path.join(root, "localappdata");
  const temp = path.join(root, "temp");
  const npmCache = path.join(root, "npm-cache");
  const xdg = path.join(root, "xdg");
  for (const directory of [home, appData, localAppData, temp, npmCache, xdg]) {
    mkdirSync(directory, { recursive: true });
  }
  environment.HOME = home;
  environment.USERPROFILE = home;
  environment.APPDATA = appData;
  environment.LOCALAPPDATA = localAppData;
  environment.TEMP = temp;
  environment.TMP = temp;
  environment.TMPDIR = temp;
  environment.XDG_CONFIG_HOME = path.join(xdg, "config");
  environment.XDG_CACHE_HOME = path.join(xdg, "cache");
  environment.XDG_STATE_HOME = path.join(xdg, "state");
  environment.XDG_DATA_HOME = path.join(xdg, "data");
  environment.npm_config_cache = npmCache;
  environment.NPM_CONFIG_USERCONFIG = path.join(root, "absent-user-npmrc");
  environment.NPM_CONFIG_GLOBALCONFIG = path.join(root, "absent-global-npmrc");
  environment.npm_config_update_notifier = "false";
  environment.npm_config_audit = "false";
  environment.npm_config_fund = "false";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = path.join(root, "absent-global-gitconfig");
  if (pathPrefix) {
    const existingPath = environment.PATH ?? environment.Path ?? "";
    environment.PATH = `${pathPrefix}${path.delimiter}${existingPath}`;
    delete environment.Path;
  }
  return environment;
}

const globalEnv = makeRuntimeEnvironment(globalRuntimeRoot);

async function npm(args, name, cwd = physicalRunRoot, env = globalEnv) {
  return runCommand({ name, executable: process.execPath, args: [runtime.npmCliJs, ...args], cwd, env });
}

async function captureToolVersion(executable, args, name, env = globalEnv) {
  return (await runCommand({ name, executable, args, cwd: physicalRunRoot, env, timeoutMs: 30_000 })).stdout.trim();
}

const bunVersion = await captureToolVersion(runtime.bunExecutable, ["--version"], "bun-version");
const [bunMajor, bunMinor] = bunVersion.split(".").map(Number);
assert(bunMajor > 1 || (bunMajor === 1 && bunMinor >= 4), "Bun 1.4+ required");
await captureToolVersion(runtime.gitExecutable, ["--version"], "git-version");

const sourceHead = (await runCommand({
  name: "source-head",
  executable: runtime.gitExecutable,
  args: ["-C", sourceCheckout, "rev-parse", "HEAD"],
  cwd: physicalRunRoot,
  env: globalEnv,
  timeoutMs: 30_000,
})).stdout.trim();
assert.equal(sourceHead, config.artifact.sourceSha, "Frozen source SHA mismatch");
const sourceBefore = snapshotTree(sourceCheckout);
writeFileSync(path.join(evidenceRoot, "source-before.json"), `${JSON.stringify(sourceBefore, null, 2)}\n`);

writeFileSync(path.join(consumerRoot, "package.json"), '{"name":"devkit-native-consumer","private":true}\n');
await npm([
  "install", "--prefix", consumerRoot, "--ignore-scripts", "--no-audit", "--no-fund", artifactPath,
], "install-devkit-tarball", consumerRoot);

writeFileSync(path.join(toolsRoot, "package.json"), '{"name":"devkit-native-host-tools","private":true}\n');
await npm([
  "install", "--prefix", toolsRoot, "--ignore-scripts", "--no-audit", "--no-fund",
  `@openai/codex@${config.expected.codex}`,
  `@anthropic-ai/claude-code@${config.expected.claude}`,
], "install-pinned-host-tools", toolsRoot);

const devkitPackage = JSON.parse(readFileSync(path.join(consumerRoot, "node_modules", "hoklims-devkit", "package.json"), "utf8"));
const codexPackage = JSON.parse(readFileSync(path.join(toolsRoot, "node_modules", "@openai", "codex", "package.json"), "utf8"));
const claudePackage = JSON.parse(readFileSync(path.join(toolsRoot, "node_modules", "@anthropic-ai", "claude-code", "package.json"), "utf8"));
assert.equal(devkitPackage.version, config.artifact.version);
assert.equal(codexPackage.version, config.expected.codex);
assert.equal(claudePackage.version, config.expected.claude);

const devkitBinValue = typeof devkitPackage.bin === "string"
  ? devkitPackage.bin
  : devkitPackage.bin["hoklims-devkit"];
assert(devkitBinValue, "hoklims-devkit bin entry missing");
const devkitEntry = realpathSync(path.join(consumerRoot, "node_modules", "hoklims-devkit", devkitBinValue));
const toolsBin = path.join(toolsRoot, "node_modules", ".bin");
const codexBin = path.join(toolsBin, process.platform === "win32" ? "codex.cmd" : "codex");
const claudeBin = path.join(toolsBin, process.platform === "win32" ? "claude.cmd" : "claude");
assert(statSync(codexBin).isFile(), "Pinned Codex entry point missing");
assert(statSync(claudeBin).isFile(), "Pinned Claude entry point missing");

const registrySemctx = await npm([
  "view", `semctx@${config.expected.semctx}`, "version", "dist.integrity", "gitHead", "--json",
], "registry-semctx-exact");
const registryLatest = await npm(["view", "semctx", "dist-tags.latest", "--json"], "registry-semctx-latest");
const registryAssert = await npm([
  "view", `assertledger@${config.expected.assertledger}`, "version", "dist.integrity", "gitHead", "--json",
], "registry-assertledger-exact");
const semctxExact = JSON.parse(registrySemctx.stdout);
const semctxLatest = JSON.parse(registryLatest.stdout);
const assertExact = JSON.parse(registryAssert.stdout);
assert.equal(semctxExact.version, config.expected.semctx);
assert.equal(semctxLatest, config.expected.semctx);
assert.equal(semctxExact.gitHead, config.expected.semctxPublicationSha, "Semctx npm gitHead mismatch");
assert.equal(assertExact.version, config.expected.assertledger);
const semctxStableRoot = path.join(physicalRunRoot, "semctx-stable-public");
await runCommand({
  name: "clone-semctx-stable",
  executable: runtime.gitExecutable,
  args: [
    "clone", "--depth", "1", "--branch", "stable", "--single-branch", "--no-tags",
    "https://github.com/hoklims/semctx.git", semctxStableRoot,
  ],
  cwd: physicalRunRoot,
  env: globalEnv,
  timeoutMs: 180_000,
});
const semctxStableHead = (await runCommand({
  name: "semctx-stable-head",
  executable: runtime.gitExecutable,
  args: ["-C", semctxStableRoot, "rev-parse", "HEAD"],
  cwd: physicalRunRoot,
  env: globalEnv,
  timeoutMs: 30_000,
})).stdout.trim();
assert.equal(semctxStableHead, config.expected.semctxPublicationSha, "Semctx stable branch mismatch");
const codexPluginManifest = JSON.parse(readFileSync(
  path.join(semctxStableRoot, "plugins", "semctx-control", ".codex-plugin", "plugin.json"),
  "utf8",
));
const claudePluginManifest = JSON.parse(readFileSync(
  path.join(semctxStableRoot, "plugins", "claude-code", "plugin.json"),
  "utf8",
));
const claudeMarketplaceManifest = JSON.parse(readFileSync(
  path.join(semctxStableRoot, ".claude-plugin", "marketplace.json"),
  "utf8",
));
assert.equal(codexPluginManifest.version, config.expected.semctx, "Codex plugin version mismatch");
assert.equal(claudePluginManifest.version, config.expected.semctx, "Claude plugin version mismatch");
assert.equal(claudeMarketplaceManifest.plugins?.[0]?.version, config.expected.semctx, "Claude marketplace version mismatch");
writeFileSync(path.join(evidenceRoot, "registry.json"), `${JSON.stringify({
  semctxExact,
  semctxLatest,
  semctxStableHead,
  codexPluginManifest: { name: codexPluginManifest.name, version: codexPluginManifest.version },
  claudePluginManifest: { name: claudePluginManifest.name, version: claudePluginManifest.version },
  claudeMarketplaceVersion: claudeMarketplaceManifest.plugins?.[0]?.version,
  assertExact,
}, null, 2)}\n`);

const laneDefinitions = [
  { name: "codex-semctx", host: "codex", withAssertLedger: false },
  { name: "claude-semctx", host: "claude", withAssertLedger: false },
  { name: "all-semctx", host: "all", withAssertLedger: false },
  { name: "all-assertledger", host: "all", withAssertLedger: true },
];

function laneEnvironment(lane) {
  const environment = makeRuntimeEnvironment(lane.runtimeRoot, toolsBin);
  environment.CODEX_HOME = lane.codexHome;
  environment.CLAUDE_CONFIG_DIR = lane.claudeConfig;
  environment.HOME = lane.home;
  environment.USERPROFILE = lane.home;
  environment.APPDATA = lane.appData;
  environment.LOCALAPPDATA = lane.localAppData;
  environment.XDG_CONFIG_HOME = lane.xdgConfig;
  environment.XDG_CACHE_HOME = lane.xdgCache;
  environment.XDG_STATE_HOME = lane.xdgState;
  environment.XDG_DATA_HOME = lane.xdgData;
  environment.npm_config_cache = lane.npmCache;
  return environment;
}

async function createLane(definition) {
  const root = path.join(physicalRunRoot, "lanes", definition.name);
  const lane = {
    ...definition,
    root,
    repository: path.join(root, "repository"),
    profileRoot: path.join(root, "profile"),
    runtimeRoot: path.join(root, "runtime"),
  };
  lane.home = path.join(lane.profileRoot, "home");
  lane.codexHome = path.join(lane.profileRoot, "codex-home");
  lane.claudeConfig = path.join(lane.profileRoot, "claude-config");
  lane.appData = path.join(lane.profileRoot, "appdata");
  lane.localAppData = path.join(lane.profileRoot, "localappdata");
  lane.xdgConfig = path.join(lane.profileRoot, "xdg", "config");
  lane.xdgCache = path.join(lane.runtimeRoot, "xdg-cache");
  lane.xdgState = path.join(lane.profileRoot, "xdg", "state");
  lane.xdgData = path.join(lane.profileRoot, "xdg", "data");
  lane.npmCache = path.join(lane.runtimeRoot, "npm-cache");
  for (const directory of [
    lane.repository, path.join(lane.repository, "src"), path.join(lane.repository, "test"),
    path.join(lane.repository, "node_modules"), lane.home, lane.codexHome, lane.claudeConfig,
    lane.appData, lane.localAppData, lane.xdgConfig, lane.xdgCache, lane.xdgState, lane.xdgData,
    lane.npmCache,
  ]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(lane.repository, "package.json"), `${JSON.stringify({
    name: `devkit-native-${definition.name}`,
    private: true,
    version: "1.0.0",
    packageManager: "npm@10.9.8",
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`);
  writeFileSync(path.join(lane.repository, "src", "answer.js"), "export const answer = 42;\n");
  writeFileSync(
    path.join(lane.repository, "test", "answer.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { answer } from "../src/answer.js";\ntest("answer", () => assert.equal(answer, 42));\n',
  );
  const env = laneEnvironment(lane);
  await runCommand({ name: `${definition.name}-git-init`, executable: runtime.gitExecutable, args: ["init", "--template=", "--initial-branch=main"], cwd: lane.repository, env, timeoutMs: 30_000 });
  await runCommand({ name: `${definition.name}-git-add`, executable: runtime.gitExecutable, args: ["add", "."], cwd: lane.repository, env, timeoutMs: 30_000 });
  await runCommand({
    name: `${definition.name}-git-commit`, executable: runtime.gitExecutable,
    args: ["-c", "user.name=Devkit Native Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture"],
    cwd: lane.repository, env, timeoutMs: 30_000,
  });
  lane.env = env;
  return lane;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not emit one JSON document: ${error.message}`);
  }
}

function validateReport(report, lane, command) {
  assert.equal(report.schemaVersion, 1, `${command}: schemaVersion`);
  assert.equal(report.command, command, `${command}: command`);
  assert.equal(report.ok, true, `${command}: ok`);
  assert.deepEqual(report.conflicts ?? [], [], `${command}: conflicts`);
  assert.equal(realpathSync(report.projectRoot), realpathSync(lane.repository), `${command}: projectRoot`);
  const semctx = report.components?.find((component) => component.name === "semctx");
  assert(semctx, `${command}: semctx component missing`);
  assert.equal(semctx.version, config.expected.semctx, `${command}: semctx version`);
  const compass = report.components?.find((component) => component.name === "latent-compass");
  assert.equal(compass, undefined, `${command}: Latent Compass must not be selected`);
  if (lane.withAssertLedger) {
    const assertledger = report.components?.find((component) => component.name === "assertledger");
    assert(assertledger, `${command}: AssertLedger component missing`);
    assert.equal(assertledger.version, config.expected.assertledger, `${command}: AssertLedger version`);
  }
  for (const component of report.components ?? []) {
    for (const field of ["loaded", "approved", "observed"]) {
      if (field in component) {
        assert.equal(component[field], "unknown", `${command}: ${component.name}.${field} must remain unknown`);
      }
    }
  }
  return report;
}

async function runDevkit(lane, command, { dryRun = false } = {}) {
  const args = [devkitEntry, command, lane.repository, "--host", lane.host];
  if (lane.withAssertLedger) args.push("--with", "assertledger");
  if (dryRun) args.push("--dry-run");
  args.push("--json");
  const result = await runCommand({
    name: `${lane.name}-${command}${dryRun ? "-dry-run" : ""}`,
    executable: runtime.bunExecutable,
    args,
    cwd: lane.repository,
    env: lane.env,
    timeoutMs: 300_000,
  });
  return validateReport(parseJsonOutput(result, `${lane.name} ${command}`), lane, command);
}

async function requireUnchanged(lane, label, operation) {
  const before = snapshotProtected(lane);
  writeFileSync(path.join(evidenceRoot, `${lane.name}-${label}-before.json`), `${JSON.stringify(before, null, 2)}\n`);
  const value = await operation();
  const after = snapshotProtected(lane);
  writeFileSync(path.join(evidenceRoot, `${lane.name}-${label}-after.json`), `${JSON.stringify(after, null, 2)}\n`);
  const diff = diffSnapshots(before, after);
  writeFileSync(path.join(evidenceRoot, `${lane.name}-${label}-diff.json`), `${JSON.stringify(diff, null, 2)}\n`);
  assert.deepEqual(diff, [], `${lane.name} ${label} changed protected profile or repository`);
  return value;
}

async function runAssertLedgerDemo(lane) {
  assert.equal(
    config.allowAssertLedgerUnsafeDemo,
    true,
    "AssertLedger fixture requires explicit allowAssertLedgerUnsafeDemo=true",
  );
  const packageRoot = path.join(lane.repository, "node_modules", "assertledger");
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, config.expected.assertledger);
  const demoRoot = path.join(lane.root, "assertledger-demo");
  const createResult = await runCommand({
    name: `${lane.name}-assertledger-demo-create`,
    executable: process.execPath,
    args: [path.join(packageRoot, "examples", "git-history", "create-demo.mjs"), demoRoot],
    cwd: lane.root,
    env: lane.env,
    timeoutMs: 120_000,
  });
  const demo = parseJsonOutput(createResult, "AssertLedger demo creation");
  const cli = path.join(packageRoot, "dist", "cli.js");
  const checkResult = await runCommand({
    name: `${lane.name}-assertledger-demo-check`,
    executable: process.execPath,
    args: [
      cli, "check", demo.repository,
      "--before", demo.before,
      "--after", demo.after,
      "--neutral", demo.neutral,
      "--neutral-reason", demo.neutralReason,
      "--test", demo.test,
      ...demo.baseTests.flatMap((baseTest) => ["--base-test", baseTest]),
      "--out", demo.out,
      "--allow-unsafe-execution",
      "--json",
    ],
    cwd: demo.repository,
    env: lane.env,
    timeoutMs: 300_000,
  });
  const report = parseJsonOutput(checkResult, "AssertLedger fixture check");
  assert.equal(
    report.verdict ?? report.decision?.verdict ?? report.decision?.status,
    "VERIFIED",
    "AssertLedger strong fixture must verify",
  );
  writeFileSync(path.join(evidenceRoot, `${lane.name}-assertledger-demo.json`), `${JSON.stringify({ demo, report }, null, 2)}\n`);
}

const laneResults = [];
for (const definition of laneDefinitions) {
  const lane = await createLane(definition);
  const dryRun = await requireUnchanged(lane, "setup-dry-run", () => runDevkit(lane, "setup", { dryRun: true }));
  const apply = await runDevkit(lane, "setup");
  const doctor = await requireUnchanged(lane, "doctor", () => runDevkit(lane, "doctor"));
  const repeat = await requireUnchanged(lane, "setup-repeat", () => runDevkit(lane, "setup"));
  const upgrade = await requireUnchanged(lane, "upgrade-noop", () => runDevkit(lane, "upgrade"));
  if (lane.withAssertLedger) await runAssertLedgerDemo(lane);
  laneResults.push({ name: lane.name, host: lane.host, withAssertLedger: lane.withAssertLedger, dryRun, apply, doctor, repeat, upgrade });
}

const sourceAfter = snapshotTree(sourceCheckout);
writeFileSync(path.join(evidenceRoot, "source-after.json"), `${JSON.stringify(sourceAfter, null, 2)}\n`);
const sourceDiff = diffSnapshots({ source: sourceBefore }, { source: sourceAfter });
writeFileSync(path.join(evidenceRoot, "source-diff.json"), `${JSON.stringify(sourceDiff, null, 2)}\n`);
assert.deepEqual(sourceDiff, [], "Devkit source checkout changed during native smoke");

const summary = {
  schemaVersion: 1,
  kind: "devkit_no_lc_native_smoke",
  platform: expectedPlatform,
  artifact: {
    path: artifactPath,
    sha256: config.artifact.sha256,
    sourceSha: config.artifact.sourceSha,
    version: config.artifact.version,
  },
  publicVersions: {
    semctx: config.expected.semctx,
    semctxPublicationSha: config.expected.semctxPublicationSha,
    assertledger: config.expected.assertledger,
  },
  hostTools: {
    codex: {
      version: codexPackage.version,
      entrySha256: sha256File(codexBin),
      packageTreeSha256: sha256Bytes(JSON.stringify(snapshotTree(path.join(toolsRoot, "node_modules", "@openai", "codex")))),
    },
    claude: {
      version: claudePackage.version,
      entrySha256: sha256File(claudeBin),
      packageTreeSha256: sha256Bytes(JSON.stringify(snapshotTree(path.join(toolsRoot, "node_modules", "@anthropic-ai", "claude-code")))),
    },
  },
  lanes: laneResults.map((lane) => ({ name: lane.name, host: lane.host, withAssertLedger: lane.withAssertLedger })),
  protectedBoundaries: "full repository and full owned profile roots",
  cachesAndTempOutsideProtectedProfiles: true,
  actualUserProfilesUsed: false,
  modelInvoked: false,
  sourceCheckoutUnchanged: true,
};
writeFileSync(path.join(evidenceRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(path.join(evidenceRoot, "PASS"), `${sha256Bytes(JSON.stringify(summary))}\n`);
console.log(JSON.stringify(summary));
