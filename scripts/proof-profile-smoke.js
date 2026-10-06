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
  let repository = join(root, "repository");
  const home = join(root, "home");
  mkdirSync(repository);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'smoke_sentinel = "preserved"\n');
  writeFileSync(join(home, "gitconfig"), "");
  writeFileSync(join(repository, "value.js"), "export const value = 42;\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
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
  // Use the same Git-root/realpath producer as the CLI. Windows Git can return
  // canonical casing different from TEMP, even for the identical directory.
  repository = realpathSync(run(["git", "rev-parse", "--show-toplevel"]).trim());
  const head = run(["git", "rev-parse", "HEAD"]).trim();
  const packagedBefore = snapshot(packaged);
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
  const captureJournals = [];
  function capture(entry, label) {
    const journal = join(root, `${label}-commands.jsonl`);
    const policyPath = join(root, `${label}-policy.json`);
    writeFileSync(journal, "", { flag: "wx" });
    writeFileSync(policyPath, JSON.stringify({ repository, head, journal }), { flag: "wx" });
    const guard = join(packaged, "scripts", "capture-command-guard.js");
    const result = Bun.spawnSync({ cmd: [process.execPath, "--preload", guard, entry, ...workflowArgs], cwd: repository,
      env: { ...env, DEVKIT_CAPTURE_POLICY: policyPath }, stdout: "pipe", stderr: "pipe" });
    // Inspect the journal before the child exit/report. Swallowed attempts still fail.
    const events = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert(events.filter(event => event.kind === "ready").length === 1, "Capture guard did not initialize");
    const ready = events.find(event => event.kind === "ready");
    assert.deepEqual(ready.apis, ["Bun.spawn", "Bun.spawnSync", "fetch"]);
    assert.equal(ready.repository, repository);
    const calls = events.filter(event => event.kind === "call");
    const forbidden = calls.filter(event => event.allowed !== true);
    assert(forbidden.length === 0, `Capture guard recorded a forbidden operation (${label}): ${JSON.stringify(forbidden)}`);
    assert(calls.some(event => event.argv?.[0] === "bun" && event.argv[1] === "--version"), "Capture readiness command was not observed");
    assert(calls.some(event => event.argv?.[0] === "git" && event.argv.includes("diff")), "Capture Git diff was not observed");
    assert.equal(result.exitCode, 0, `Guarded ${label} capture failed\n${result.stdout}\n${result.stderr}`);
    captureJournals.push({ label, journal, events });
    return assertPlan(JSON.parse(result.stdout.toString()));
  }
  const report = capture(join(packaged, "bin", "hoklims-devkit.js"), "packaged");
  assert(JSON.stringify(snapshot(packaged)) === JSON.stringify(packagedBefore), "Packaged source changed during capture");
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
  const ownedBefore = snapshot(destination);
  assert.equal(capture(embedded, "embedded").requestDigest, report.requestDigest);
  assert(JSON.stringify(snapshot(destination)) === JSON.stringify(ownedBefore), "Embedded source changed during capture");
  assert(JSON.stringify(snapshot(packaged)) === JSON.stringify(packagedBefore), "Packaged source changed during embedded capture");
  assert(pluginPlan(destination).changes.every(change => change.action === "unchanged"), "Embedded snapshot is not idempotent after capture");
  assertSnapshotUnchanged([repository, ...paths], [before, ...profileBefore], "embedded workflow capture");
  process.stdout.write("PASS packaged common profile pins/resources/owned snapshot/read-only workflow; native install/loading/replay unproven\n");
  return { root, report, captureJournals };
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Pass a consumer prefix containing the installed hoklims-devkit package");
  await proofProfileSmoke(process.argv[2]);
}
