import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSnapshotUnchanged, protectedProfilePaths, snapshot } from "./profile-snapshot.js";
import { validComponentReport } from "./release-report.js";

const consumer = process.argv[2];
if (!consumer || !existsSync(join(consumer, "node_modules", "hoklims-devkit", "bin", "hoklims-devkit.js"))) {
  throw new Error("Pass a fresh consumer prefix containing the installed hoklims-devkit package");
}

// macOS exposes temporary directories through /var, a symlink to /private/var.
// Pass the canonical fixture home to installers that reject linked ancestors.
const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-release-smoke-")));
const repository = join(root, "repository");
const home = join(root, "home");
const cache = join(root, "cache");
mkdirSync(repository);
mkdirSync(cache);
mkdirSync(join(home, ".codex"), { recursive: true });
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(join(home, "AppData", "Local"), { recursive: true });
mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
writeFileSync(join(home, ".codex", "hooks.json"), '{"hooks":{}}\n');
writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}\n');
writeFileSync(join(repository, "package.json"), JSON.stringify({
  name: "hoklims-devkit-smoke",
  version: "1.0.0",
  private: true,
  type: "module",
  packageManager: "npm@10.9.8",
  scripts: { test: "node --test" },
}, null, 2) + "\n");
writeFileSync(join(repository, "package-lock.json"), JSON.stringify({
  name: "hoklims-devkit-smoke", version: "1.0.0", lockfileVersion: 3, requires: true,
  packages: { "": { name: "hoklims-devkit-smoke", version: "1.0.0" } },
}, null, 2) + "\n");
writeFileSync(join(repository, "index.ts"), "export const answer = 42;\n");
writeFileSync(join(repository, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022"},"include":["index.ts"]}\n');
mkdirSync(join(repository, "tests"));
writeFileSync(join(repository, "tests", "base.test.js"), 'import { test } from "node:test";\nimport { strict as assert } from "node:assert";\ntest("answer", () => assert.equal(42, 42));\n');

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: join(home, ".codex"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  APPDATA: join(home, "AppData", "Roaming"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(cache, "xdg"),
  npm_config_cache: join(cache, "npm"),
  UV_CACHE_DIR: join(cache, "uv"),
  UV_TOOL_DIR: join(home, "uv-tools"),
  UV_TOOL_BIN_DIR: join(home, "uv-bin"),
  UV_PYTHON_INSTALL_DIR: join(home, "uv-python"),
  UV_PYTHON_BIN_DIR: join(home, "uv-python-bin"),
  UV_PYTHON_NO_REGISTRY: "true",
  BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cache, "bun-runtime"),
};

function run(argv, cwd = consumer, runEnv = env) {
  const result = Bun.spawnSync({ cmd: argv, cwd, env: runEnv, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}\n${stdout}\n${stderr}`);
  return stdout;
}

run(["git", "init", "-b", "main", repository]);
run(["git", "-C", repository, "add", "."]);
run(["git", "-C", repository, "-c", "user.name=Devkit Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"]);
run(["git", "-C", repository, "status", "--porcelain"]);
const repositoryBefore = snapshot(repository);

const protectedPaths = protectedProfilePaths(home);
const profileBefore = protectedPaths.map(snapshot);

for (const host of ["codex", "claude", "all"]) {
  for (const withTools of [[], ["--with", "assertledger,latent-compass"]]) {
    const output = run(["bunx", "--no-install", "hoklims-devkit", "setup", repository, "--host", host, ...withTools, "--dry-run", "--json"]);
    const report = JSON.parse(output);
    const expected = withTools.length ? ["semctx", "assertledger", "latent-compass"] : ["semctx"];
    if (!validComponentReport(report, resolve(repository), expected, { expectedState: "planned" })) {
      throw new Error(`Unexpected ${host} preflight: ${output}`);
    }
    if (run(["git", "-C", repository, "status", "--porcelain"]).trim()) {
      throw new Error(`${host} dry-run modified the Git fixture`);
    }
    assertSnapshotUnchanged([repository], [repositoryBefore], host);
    assertSnapshotUnchanged(protectedPaths, profileBefore, host);
    process.stdout.write(`PASS ${host} ${expected.join("+")} dry-run\n`);
  }
}

for (const host of ["codex", "claude", "all"]) {
  for (const withTools of [[], ["--with", "assertledger,latent-compass"]]) {
    const scenario = `${host}-${withTools.length ? "full" : "default"}`;
    const scenarioRepository = join(root, `repository-${scenario}`);
    const scenarioHome = join(root, `home-${scenario}`);
    const scenarioCache = cache;
    cpSync(repository, scenarioRepository, { recursive: true });
    mkdirSync(join(scenarioHome, ".codex"), { recursive: true });
    mkdirSync(join(scenarioHome, ".claude"), { recursive: true });
    writeFileSync(join(scenarioHome, ".codex", "hooks.json"), '{"hooks":{}}\n');
    writeFileSync(join(scenarioHome, ".claude", "settings.json"), '{"hooks":{}}\n');
    const scenarioEnv = {
      ...env,
      HOME: scenarioHome, USERPROFILE: scenarioHome,
      CODEX_HOME: join(scenarioHome, ".codex"), CLAUDE_CONFIG_DIR: join(scenarioHome, ".claude"),
      LOCALAPPDATA: join(scenarioHome, "AppData", "Local"), APPDATA: join(scenarioHome, "AppData", "Roaming"),
      XDG_STATE_HOME: join(scenarioHome, ".local", "state"), XDG_CACHE_HOME: join(scenarioCache, "xdg"),
      npm_config_cache: join(scenarioCache, "npm"), UV_CACHE_DIR: join(scenarioCache, "uv"),
      UV_TOOL_DIR: join(scenarioHome, "uv-tools"), UV_TOOL_BIN_DIR: join(scenarioHome, "uv-bin"),
      UV_PYTHON_INSTALL_DIR: join(scenarioHome, "uv-python"), UV_PYTHON_BIN_DIR: join(scenarioHome, "uv-python-bin"),
      UV_PYTHON_NO_REGISTRY: "true",
      BUN_INSTALL_CACHE_DIR: join(scenarioCache, "bun"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scenarioCache, "bun-runtime"),
    };
    const scenarioProtectedPaths = protectedProfilePaths(scenarioHome);
    const selectors = ["--host", host, ...withTools, "--json"];
    const expected = withTools.length ? ["semctx", "assertledger", "latent-compass"] : ["semctx"];
    const installed = JSON.parse(run(["bunx", "--no-install", "hoklims-devkit", "setup", scenarioRepository, ...selectors], consumer, scenarioEnv));
    if (!validComponentReport(installed, resolve(scenarioRepository), expected, {
      expectedState: "configured",
      requireInstalledAndConfigured: true,
    })) {
      throw new Error(`Unexpected ${host} installation: ${JSON.stringify(installed)}`);
    }
    run(["git", "-C", scenarioRepository, "status", "--porcelain"], consumer, scenarioEnv);
    const targets = [scenarioRepository, ...scenarioProtectedPaths];
    const installedSnapshot = targets.map(snapshot);
    const repeated = JSON.parse(run(["bunx", "--no-install", "hoklims-devkit", "setup", scenarioRepository, ...selectors], consumer, scenarioEnv));
    if (!validComponentReport(repeated, resolve(scenarioRepository), expected, {
      expectedState: "configured",
      requireInstalledAndConfigured: true,
    })) throw new Error(`${host} repeated setup failed: ${JSON.stringify(repeated)}`);
    assertSnapshotUnchanged(targets, installedSnapshot, `${host} repeated setup`);

    const beforeDoctor = targets.map(snapshot);
    const diagnosed = JSON.parse(run(["bunx", "--no-install", "hoklims-devkit", "doctor", scenarioRepository, ...selectors], consumer, scenarioEnv));
    if (!validComponentReport(diagnosed, resolve(scenarioRepository), expected, {
      requireInstalledAndConfigured: true,
    })) {
      throw new Error(`${host} doctor did not confirm installation: ${JSON.stringify(diagnosed)}`);
    }
    assertSnapshotUnchanged(targets, beforeDoctor, `${host} doctor`);
    const beforeUpgradePlan = targets.map(snapshot);
    const upgrade = JSON.parse(run(["bunx", "--no-install", "hoklims-devkit", "upgrade", scenarioRepository, ...selectors.slice(0, -1), "--dry-run", "--json"], consumer, scenarioEnv));
    if (!validComponentReport(upgrade, resolve(scenarioRepository), expected, { expectedState: "planned" })) {
      throw new Error(`${host} upgrade plan failed: ${JSON.stringify(upgrade)}`);
    }
    assertSnapshotUnchanged(targets, beforeUpgradePlan, `${host} upgrade plan`);
    const appliedUpgrade = JSON.parse(run(["bunx", "--no-install", "hoklims-devkit", "upgrade", scenarioRepository, ...selectors], consumer, scenarioEnv));
    if (!validComponentReport(appliedUpgrade, resolve(scenarioRepository), expected, {
      expectedState: "configured",
      requireInstalledAndConfigured: true,
    })) {
      throw new Error(`${host} upgrade did not configure every component: ${JSON.stringify(appliedUpgrade)}`);
    }
    const afterUpgrade = targets.map(snapshot);
    const diagnosedUpgrade = JSON.parse(run(["bunx", "--no-install", "hoklims-devkit", "doctor", scenarioRepository, ...selectors], consumer, scenarioEnv));
    if (!validComponentReport(diagnosedUpgrade, resolve(scenarioRepository), expected, {
      requireInstalledAndConfigured: true,
    })) {
      throw new Error(`${host} post-upgrade doctor did not confirm installation: ${JSON.stringify(diagnosedUpgrade)}`);
    }
    assertSnapshotUnchanged(targets, afterUpgrade, `${host} post-upgrade doctor`);
    process.stdout.write(`PASS ${host} ${expected.join("+")} setup/repeat/doctor/upgrade\n`);
  }
}

if (readFileSync(join(repository, "index.ts"), "utf8") !== "export const answer = 42;\n") {
  throw new Error("Dry-run changed source bytes");
}
process.stdout.write(`PASS disposable fixture at ${root}\n`);
