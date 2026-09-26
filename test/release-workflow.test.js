import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);

function needs(job) {
  return new Set(Array.isArray(job?.needs) ? job.needs : job?.needs ? [job.needs] : []);
}

function runs(job) {
  return (job?.steps ?? []).map((step) => step?.run).filter((run) => typeof run === "string");
}

function uses(job, prefix) {
  return (job?.steps ?? []).filter((step) => (
    typeof step?.uses === "string" && step.uses.startsWith(prefix)
  ));
}

function validateReleaseGraph(workflow) {
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object") throw new Error("release jobs missing");
  const { build, verify, publish, "public-smoke": publicSmoke, release } = jobs;
  if (![build, verify, publish, publicSmoke, release].every(Boolean)) {
    throw new Error("release graph jobs missing");
  }

  const buildRuns = runs(build).join("\n");
  if ((buildRuns.match(/\bnpm pack\b/gu) ?? []).length !== 1) {
    throw new Error("build must create exactly one npm tarball");
  }
  const uploads = uses(build, "actions/upload-artifact@");
  if (uploads.length !== 1 || uploads[0].with?.name !== "tested-npm-tarball"
    || uploads[0].with?.path !== "hoklims-devkit-*.tgz") {
    throw new Error("build must preserve exactly the tested npm tarball");
  }

  if (JSON.stringify(verify.strategy?.matrix?.os) !== JSON.stringify([
    "ubuntu-latest", "windows-latest", "macos-latest",
  ])) throw new Error("verify must cover the exact three operating systems");
  if (JSON.stringify([...needs(verify)]) !== JSON.stringify(["build"])) {
    throw new Error("verify must depend on build");
  }
  const verifyDownloads = uses(verify, "actions/download-artifact@");
  const verifyRuns = runs(verify).join("\n");
  if (verifyDownloads.length !== 1 || verifyDownloads[0].with?.name !== "tested-npm-tarball"
    || !verifyRuns.includes("EXPECTED_SHA256")
    || !verifyRuns.includes("tested tarball digest mismatch")
    || !verifyRuns.includes("bun scripts/release-smoke.js")) {
    throw new Error("verify must consume and smoke the identical digest-bound tarball");
  }

  if (JSON.stringify([...needs(publish)].sort()) !== JSON.stringify(["build", "verify"])) {
    throw new Error("publish must depend on build and verify");
  }
  if (uses(publish, "actions/checkout@").length !== 0) {
    throw new Error("publish must not check out repository code");
  }
  const publishDownloads = uses(publish, "actions/download-artifact@");
  const publishRuns = runs(publish).join("\n");
  if (publishDownloads.length !== 1 || publishDownloads[0].with?.name !== "tested-npm-tarball"
    || !publishRuns.includes("EXPECTED_SHA256")
    || !publishRuns.includes('npm publish "$tarball"')
    || /(?:bun|node)\s+(?:run\s+)?scripts\//u.test(publishRuns)
    || /\bnpm\s+(?:run|test)\b/u.test(publishRuns)) {
    throw new Error("publish must use only the verified artifact without repository code");
  }

  if (JSON.stringify([...needs(publicSmoke)]) !== JSON.stringify(["publish"])) {
    throw new Error("public smoke must follow publication");
  }
  if (JSON.stringify([...needs(release)]) !== JSON.stringify(["public-smoke"])) {
    throw new Error("GitHub release must follow public registry smoke");
  }
  if (!runs(release).join("\n").includes("gh release create")) {
    throw new Error("release job must create the GitHub release");
  }
  return true;
}

test("release workflow builds once, verifies one artifact on three OSes, then publishes in order", () => {
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  expect(validateReleaseGraph(workflow)).toBe(true);
});

test("release graph tripwire rejects selected semantic mutants", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const mutants = [];

  let mutant = structuredClone(original);
  mutant.jobs.build.steps.push({ run: "npm pack" });
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs.verify.strategy.matrix.os = ["ubuntu-latest", "windows-latest"];
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs.verify.steps.find((step) => step.name?.startsWith("Verify the identical")).run = "bun scripts/release-smoke.js consumer";
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs.publish.needs = ["build"];
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs.publish.steps.unshift({ uses: "actions/checkout@mutant" });
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs.publish.steps.find((step) => typeof step.run === "string").run += "\nbun scripts/release-smoke.js consumer";
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs["public-smoke"].needs = "verify";
  mutants.push(mutant);

  mutant = structuredClone(original);
  mutant.jobs.release.needs = "publish";
  mutants.push(mutant);

  for (const candidate of mutants) {
    expect(() => validateReleaseGraph(candidate)).toThrow();
  }
});
