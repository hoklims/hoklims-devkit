import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RELEASE_SMOKE_STAGES,
  assertReleaseSmokeStages,
  runReleaseSmoke,
  validSmokeDoctorReport,
} from "../scripts/release-smoke.js";

const versions = {
  semctx: "0.3.5",
  assertledger: "1.3.0",
  "latent-compass": "0.3.0",
};
const plannedFlags = {
  installed: "unknown",
  configured: "unknown",
  loaded: "unknown",
  approved: "unknown",
  observed: "unknown",
};
const configuredFlags = {
  installed: "yes",
  configured: "yes",
  loaded: "unknown",
  approved: "unknown",
  observed: "unknown",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-release-smoke-test-"));
  const consumer = join(root, "consumer");
  const smokeRoot = join(root, "fixture");
  const packagedBin = join(consumer, "node_modules", "hoklims-devkit", "bin");
  mkdirSync(packagedBin, { recursive: true });
  mkdirSync(smokeRoot);
  writeFileSync(join(packagedBin, "hoklims-devkit.js"), "#!/usr/bin/env bun\n");
  return { root, consumer, smokeRoot };
}

function reportFor(argv) {
  const command = argv[3];
  const repository = resolve(argv[4]);
  const full = argv.includes("assertledger,latent-compass");
  const names = full ? ["semctx", "assertledger", "latent-compass"] : ["semctx"];
  const dryRun = argv.includes("--dry-run");
  const doctor = command === "doctor";
  const flags = dryRun ? plannedFlags : configuredFlags;
  const state = dryRun ? "planned" : "configured";
  return JSON.stringify({
    ok: true,
    projectRoot: repository,
    components: names.map((name) => ({
      name,
      version: versions[name],
      ...(doctor ? {} : { state }),
      ...flags,
      ...(doctor && name === "latent-compass" ? { observed: "no" } : {}),
    })),
  });
}

function runner(calls, mutateOnUpgradeApply = false) {
  let mutated = false;
  return (argv, context) => {
    calls.push({ argv: [...argv], cwd: context.cwd });
    if (argv[0] === "git") return "";
    if (argv[0] !== "bunx") throw new Error(`Unexpected native command: ${argv.join(" ")}`);
    if (mutateOnUpgradeApply && argv[3] === "upgrade" && !argv.includes("--dry-run") && !mutated) {
      const bin = join(context.env.HOME, "uv-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "foreign-tool"), "unexpected\n");
      mutated = true;
    }
    return reportFor(argv);
  };
}

test("doctor smoke admits only fresh Latent Compass no-or-unknown observation state", () => {
  const projectRoot = "/fixture/repository";
  const names = ["semctx", "assertledger", "latent-compass"];
  const doctor = (compassObserved = "no") => ({
    ok: true,
    projectRoot,
    components: names.map((name) => ({
      name,
      version: versions[name],
      ...configuredFlags,
      ...(name === "latent-compass" ? { observed: compassObserved } : {}),
    })),
  });

  expect(validSmokeDoctorReport(doctor("no"), projectRoot, names)).toBe(true);
  expect(validSmokeDoctorReport(doctor("unknown"), projectRoot, names)).toBe(true);
  expect(validSmokeDoctorReport(doctor("yes"), projectRoot, names)).toBe(false);
  const semctxObserved = doctor("no");
  semctxObserved.components[0].observed = "no";
  expect(validSmokeDoctorReport(semctxObserved, projectRoot, names)).toBe(false);
  const assertNotConfigured = doctor("unknown");
  assertNotConfigured.components[1].configured = "no";
  expect(validSmokeDoctorReport(assertNotConfigured, projectRoot, names)).toBe(false);
});

test("runReleaseSmoke executes and reports the seven-stage packaged sequence", () => {
  const { consumer, smokeRoot } = fixture();
  const calls = [];
  const output = [];
  const result = runReleaseSmoke({
    consumer,
    root: smokeRoot,
    runCommand: runner(calls),
    write: (message) => output.push(message),
  });

  expect(result.preflights).toHaveLength(6);
  expect(result.preflights.every(({ stage, snapshotVerified }) => (
    stage === "setup-dry-run" && snapshotVerified === true
  ))).toBe(true);
  expect(result.scenarios).toHaveLength(6);
  expect(assertReleaseSmokeStages(result.scenarios)).toBe(true);
  for (const scenario of result.scenarios) {
    expect(scenario.stages.map(({ stage }) => stage)).toEqual(RELEASE_SMOKE_STAGES);
    expect(scenario.stages.find(({ stage }) => stage === "repeated-setup")?.snapshotVerified)
      .toBe(true);
    expect(scenario.stages.find(({ stage }) => stage === "no-op-snapshot")?.snapshotVerified)
      .toBe(true);
    expect(scenario.stages.at(-1)).toEqual({
      stage: "post-upgrade-doctor",
      snapshotVerified: true,
    });
  }
  const native = calls.filter(({ argv }) => argv[0] === "bunx");
  expect(native.filter(({ argv }) => argv[3] === "setup" && argv.includes("--dry-run")))
    .toHaveLength(6);
  expect(native.filter(({ argv }) => argv[3] === "setup" && !argv.includes("--dry-run")))
    .toHaveLength(12);
  expect(native.filter(({ argv }) => argv[3] === "doctor")).toHaveLength(12);
  expect(native.filter(({ argv }) => argv[3] === "upgrade" && argv.includes("--dry-run")))
    .toHaveLength(6);
  expect(native.filter(({ argv }) => argv[3] === "upgrade" && !argv.includes("--dry-run")))
    .toHaveLength(6);
  expect(output.at(-1)).toMatch(/^PASS disposable fixture/u);
});

test("stage oracle rejects missing repeat, no-op snapshot, and post-upgrade doctor", () => {
  const exact = [{
    scenario: "codex-default",
    stages: RELEASE_SMOKE_STAGES.map((stage) => ({
      stage,
      ...(["setup-apply", "upgrade-apply"].includes(stage)
        ? {}
        : { snapshotVerified: true }),
    })),
  }];
  expect(assertReleaseSmokeStages(exact)).toBe(true);
  for (const missing of ["repeated-setup", "no-op-snapshot", "post-upgrade-doctor"]) {
    const mutant = structuredClone(exact);
    mutant[0].stages = mutant[0].stages.filter(({ stage }) => stage !== missing);
    expect(() => assertReleaseSmokeStages(mutant)).toThrow(/stage sequence is incomplete/u);
  }
  const snapshotMutant = structuredClone(exact);
  delete snapshotMutant[0].stages.find(({ stage }) => stage === "no-op-snapshot").snapshotVerified;
  expect(() => assertReleaseSmokeStages(snapshotMutant)).toThrow(/lacks snapshot verification/u);
});

test("runReleaseSmoke catches a same-version upgrade profile mutation", () => {
  const { consumer, smokeRoot } = fixture();
  expect(() => runReleaseSmoke({
    consumer,
    root: smokeRoot,
    runCommand: runner([], true),
    write: () => {},
  })).toThrow(/modified the host profile or devkit state/u);
});

test("the packed npm artifact exposes and executes the same release smoke module", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-packed-smoke-test-"));
  const packageOutput = join(root, "package");
  const consumer = join(root, "consumer");
  const npmCache = join(root, "npm-cache");
  const smokeRoot = join(root, "fixture");
  mkdirSync(packageOutput);
  mkdirSync(smokeRoot);
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const packed = Bun.spawnSync({
    cmd: ["npm", "pack", "--silent", "--ignore-scripts", "--pack-destination", packageOutput],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  expect(packed.exitCode, packed.stderr.toString()).toBe(0);
  const tarball = join(packageOutput, packed.stdout.toString().trim());
  const installed = Bun.spawnSync({
    cmd: [
      "npm", "install", "--prefix", consumer, "--ignore-scripts",
      "--no-audit", "--no-fund", "--offline", tarball,
    ],
    cwd: root,
    env: { ...process.env, npm_config_cache: npmCache },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  expect(installed.exitCode, installed.stderr.toString()).toBe(0);
  const packagedModule = await import(pathToFileURL(join(
    consumer, "node_modules", "hoklims-devkit", "scripts", "release-smoke.js",
  )).href);
  const result = packagedModule.runReleaseSmoke({
    consumer,
    root: smokeRoot,
    runCommand: runner([]),
    write: () => {},
  });

  expect(packagedModule.RELEASE_SMOKE_STAGES).toEqual(RELEASE_SMOKE_STAGES);
  expect(result.scenarios).toHaveLength(6);
  expect(packagedModule.assertReleaseSmokeStages(result.scenarios)).toBe(true);
}, 45_000);
