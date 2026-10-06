import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSnapshotUnchanged, protectedProfilePaths, snapshot } from "./profile-snapshot.js";

// Inspect the installed package, never the checkout's runtime or plugin templates.
// No provider install, native Codex command, evidence replay or candidate execution.
export async function proofProfileSmoke(consumer) {
  const packaged = resolve(consumer, "node_modules", "hoklims-devkit");
  const { pluginPlan, applyPlugin, PROOF_PINS } = await import(pathToFileURL(join(packaged, "src", "proof-plugin.js")).href);
  const { parseArgs } = await import(pathToFileURL(join(packaged, "src", "app.js")).href);
  assert.deepEqual(PROOF_PINS, { semctx: "0.4.2", assertledger: "1.4.0" }, "Packaged common profile pins drifted");
  const onboard = parseArgs(["onboard", ".", "--dry-run", "--json"]);
  assert.equal(onboard.host, "codex");
  assert.deepEqual(onboard.with, ["assertledger"]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-proof-profile-")));
  const repository = join(root, "repository"), home = join(root, "home");
  mkdirSync(repository);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'smoke_sentinel = "preserved"\n');
  writeFileSync(join(repository, "value.js"), "export const value = 42;\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"), XDG_STATE_HOME: join(home, ".local", "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-runtime") };
  function run(argv) {
    const result = Bun.spawnSync({ cmd: argv, cwd: repository, env, stdout: "pipe", stderr: "pipe" });
    assert.equal(result.exitCode, 0, `${argv.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
    return result.stdout.toString();
  }
  run(["git", "init", "-b", "main"]);
  run(["git", "add", "."]);
  run(["git", "-c", "user.name=Proof Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"]);
  const before = snapshot(repository), paths = protectedProfilePaths(home), profileBefore = paths.map(snapshot);
  const plan = pluginPlan(repository);
  assert.deepEqual(plan.report.runtimes, PROOF_PINS);
  assert.deepEqual(plan.report.providerDeclarations, []);
  for (const resource of ["plugin.json", ".codex-plugin/plugin.json", "skills/proof-workflow/SKILL.md", "skills/proof-workflow/references/evidence.md", "runtime/bin/hoklims-devkit.js", "runtime/src/workflow.js", "runtime/src/workflow-evidence.js"]) {
    assert(plan.changes.some(change => change.name === `.agents/plugins/hoklims-proof/${resource}`), `Missing packaged plugin resource: ${resource}`);
  }
  assertSnapshotUnchanged([repository, ...paths], [before, ...profileBefore], "packaged plugin plan");
  const workflowArgs = ["workflow", repository, "--base", "HEAD", "--obligation", "smoke.packaged-profile", "--json"];
  function assertPlan(report) {
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "PLANNED");
    assert.deepEqual(report.source, { provider: "semctx", version: PROOF_PINS.semctx });
    assert.equal(report.execution, "not-run");
    assert.equal(report.authority, "none");
    assert.deepEqual(report.unprovenObligationIds, ["smoke.packaged-profile"]);
    return report;
  }
  const report = assertPlan(JSON.parse(run([process.execPath, join(packaged, "bin", "hoklims-devkit.js"), ...workflowArgs])));
  assertSnapshotUnchanged([repository, ...paths], [before, ...profileBefore], "packaged workflow capture");
  // Exercise the embedded runtime as well, against a separate owned snapshot.
  const destination = join(root, "plugin-source");
  mkdirSync(destination);
  const installed = applyPlugin(pluginPlan(destination));
  assert.equal(installed.installed, "yes");
  for (const field of ["loaded", "approved", "observed"]) assert.equal(installed[field], "unknown");
  const owner = JSON.parse(readFileSync(join(destination, ".agents", "plugins", "hoklims-proof", "ownership.json")));
  assert.deepEqual(owner.runtimes, PROOF_PINS);
  assert(pluginPlan(destination).changes.every(change => change.action === "unchanged"), "Packaged snapshot is not idempotent");
  const embedded = join(destination, ".agents", "plugins", "hoklims-proof", "runtime", "bin", "hoklims-devkit.js");
  assert.equal(assertPlan(JSON.parse(run([process.execPath, embedded, ...workflowArgs]))).requestDigest, report.requestDigest);
  assertSnapshotUnchanged([repository, ...paths], [before, ...profileBefore], "embedded workflow capture");
  process.stdout.write("PASS packaged common profile pins/resources/owned snapshot/read-only workflow; native install/loading/replay unproven\n");
  return { root, report };
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Pass a consumer prefix containing the installed hoklims-devkit package");
  await proofProfileSmoke(process.argv[2]);
}
