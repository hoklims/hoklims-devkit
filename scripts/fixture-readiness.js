import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROOF_PINS } from "../src/proof-plugin.js";
import { semctxReadiness } from "../src/semctx-readiness.js";

const semctx = ["bunx", `semctx@${PROOF_PINS.semctx}`];

export function canonicalFixtureRoot(run, repository) {
  return dirname(realpathSync(run(["git", "-C", repository, "rev-parse", "--show-toplevel"]).trim()));
}

export function initializeFixtureScope(run, repository) {
  run([...semctx, "init", "--polyglot", "--root", repository, "--json"]);
  const path = join(repository, ".semctx", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.version !== 2 || config.selectionMode !== "globs-v1") throw new Error("Fixture needs native Semctx V2 glob selection");
  config.include = ["index.ts"];
  config.languages = { ...config.languages, typescript: "on" };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function prepareFixtureScope(run, repository) {
  initializeFixtureScope(run, repository);
  // Bootstrap repository files before the first real host installation. Native
  // semantic incompleteness is retained; only a fresh positive readback can pass.
  const prepared = run([...semctx, "setup", "--root", repository, "--json"], { acceptedCodes: [0, 1], captureResult: true });
  const report = JSON.parse(prepared.stdout);
  if (![0, 1].includes(prepared.code) || report.schemaVersion !== 1 || report.kind !== "setup"
    || report.repositoryRoot !== repository || !["SETUP_READY", "SETUP_NOT_READY"].includes(report.verdict)
    || typeof report.check?.ok !== "boolean"
    || (report.check.errors !== undefined && report.check.errors !== 0)) {
    throw new Error("Native fixture repository preparation failed");
  }
  return qualifyInstalledFixture(run, repository);
}

export function requireFixtureReady(doctor, health, root = "") {
  const readiness = semctxReadiness(doctor, health, PROOF_PINS.semctx, root, realpathSync);
  if (readiness.configuration !== "yes") throw new Error("Fixture requires verified positive configuration readiness");
  return readiness;
}

export function commitGeneratedFixtureSources(run, repository) {
  run(["git", "-C", repository, "add", "."]);
  const staged = run(["git", "-C", repository, "diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  if (staged.some(path => /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/u.test(path)
    || /^\.semctx\/(?:.*\.(?:db|sqlite)(?:-|$)|cache(?:\/|$))/u.test(path))) {
    throw new Error("Fixture commit must not include database, Git internals or dependency caches");
  }
  if (staged.length) run(["git", "-C", repository, "-c", "user.name=Devkit Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "qualified generated fixture sources"]);
}

export function qualifyInstalledFixture(run, repository) {
  commitGeneratedFixtureSources(run, repository);
  run([...semctx, "index", "--root", repository, "--json"]);
  const doctor = run([...semctx, "doctor", "--root", repository, "--json"], { acceptedCodes: [0, 1], captureResult: true });
  const health = run([...semctx, "index-health", "--root", repository, "--json"], { acceptedCodes: [0, 2, 3], captureResult: true });
  const readiness = requireFixtureReady({ ...doctor, report: JSON.parse(doctor.stdout) }, { ...health, report: JSON.parse(health.stdout) }, realpathSync(repository));
  if (run(["git", "-C", repository, "status", "--porcelain"]).trim()) throw new Error("Qualified fixture must remain Git clean");
  return readiness;
}
