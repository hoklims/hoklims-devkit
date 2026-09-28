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

function assertCanonicalStep(job, step, patterns, label) {
  if (job?.if !== undefined || job?.["continue-on-error"] !== undefined) {
    throw new Error(`${label} job must be unconditional and fail closed`);
  }
  if (step?.shell !== "bash" || step.if !== undefined || step["continue-on-error"] !== undefined
    || typeof step.run !== "string") {
    throw new Error(`${label} must be an unconditional fail-closed bash step`);
  }
  const lines = step.run.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== patterns.length) {
    throw new Error(`${label} must contain only its canonical executable lines`);
  }
  for (let index = 0; index < patterns.length; index += 1) {
    const matches = typeof patterns[index] === "string"
      ? patterns[index] === lines[index] : patterns[index].test(lines[index]);
    if (!matches) {
      throw new Error(`${label} commands are missing, changed, or out of order`);
    }
  }
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
  const verifyStep = (verify.steps ?? []).find((step) => step.name?.startsWith("Verify the identical"));
  const verifyRuns = runs(verify).join("\n");
  if (verifyDownloads.length !== 1 || verifyDownloads[0].with?.name !== "tested-npm-tarball"
    || !verifyRuns.includes("EXPECTED_SHA256")
    || !verifyRuns.includes("tested tarball digest mismatch")) {
    throw new Error("verify must consume and smoke the identical digest-bound tarball");
  }
  assertCanonicalStep(verify, verifyStep, [
    /^test "\$\(git cat-file -t "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "tag"$/u,
    /^git merge-base --is-ancestor HEAD origin\/main$/u,
    /^test "\$\{GITHUB_REF_NAME\}" = "v\$RELEASE_VERSION"$/u,
    /^test "\$\(node -p 'require\("\.\/package\.json"\)\.version'\)" = "\$RELEASE_VERSION"$/u,
    /^bun run check$/u,
    /^tarball="tested-package\/hoklims-devkit-\$\{RELEASE_VERSION\}\.tgz"$/u,
    /^test -f "\$tarball"$/u,
    String.raw`node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const actual=crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");if(actual!==process.env.EXPECTED_SHA256)throw new Error("tested tarball digest mismatch")' "$tarball"`,
    /^consumer="\$\(mktemp -d\)"$/u,
    /^npm install --prefix "\$consumer" --ignore-scripts "\$PWD\/\$tarball"(?:\s+#.*)?$/u,
    /^bun scripts\/release-smoke\.js "\$consumer"$/u,
  ], "verify smoke");

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

  if (JSON.stringify([...needs(publicSmoke)].sort()) !== JSON.stringify(["build", "publish"])) {
    throw new Error("public smoke must bind the built version and follow publication");
  }
  const publicStep = (publicSmoke.steps ?? []).find((step) => step.name?.startsWith("Verify public registry"));
  const requiredPublicLines = [
    /^version="\$RELEASE_VERSION"$/u,
    /^test "\$GITHUB_REF_NAME" = "v\$version"$/u,
    /^consumer="\$\(mktemp -d\)"$/u,
    /^npm install --prefix "\$consumer" --ignore-scripts "hoklims-devkit@\$version"(?:\s+#.*)?$/u,
    String.raw`test "$(node -p 'require(process.argv[1]).version' "$consumer/node_modules/hoklims-devkit/package.json")" = "$version"`,
    /^bun scripts\/release-smoke\.js "\$consumer"$/u,
  ];
  if (publicStep?.env?.RELEASE_VERSION !== "${{ needs.build.outputs.version }}") {
    throw new Error("public smoke must install, attest, and smoke the exact built public version with failure propagation");
  }
  assertCanonicalStep(publicSmoke, publicStep, requiredPublicLines, "public smoke");
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

  for (const replacement of [
    ["npm install --prefix", "true # npm install --prefix"],
    ['"hoklims-devkit@$version"', '"hoklims-devkit@latest"'],
    ["test \"$(node -p", "true # test \"$(node -p"],
    ["bun scripts/release-smoke.js \"$consumer\"", "true # smoke disabled"],
    ["bun scripts/release-smoke.js \"$consumer\"", "bun scripts/release-smoke.js \"$consumer\" || true"],
  ]) {
    mutant = structuredClone(original);
    const step = mutant.jobs["public-smoke"].steps.find((candidate) => candidate.name?.startsWith("Verify public registry"));
    step.run = step.run.replace(...replacement);
    mutants.push(mutant);
  }

  mutant = structuredClone(original);
  mutant.jobs.release.needs = "publish";
  mutants.push(mutant);

  for (const candidate of mutants) {
    expect(() => validateReleaseGraph(candidate)).toThrow();
  }
});

test("verify and public smoke steps reject independent execution bypasses", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const stepFor = (workflow, job) => workflow.jobs[job].steps.find((step) => (
    step.name?.startsWith(job === "verify" ? "Verify the identical" : "Verify public registry")
  ));
  const cases = [
    ["verify ignores failure", "verify", (step) => {
      step.run = step.run.replace(
        'bun scripts/release-smoke.js "$consumer"',
        'bun scripts/release-smoke.js "$consumer" || true',
      );
    }],
    ["verify is disabled", "verify", (step) => { step.if = "${{ false }}"; }],
    ["public smoke is disabled", "public-smoke", (step) => { step.if = "${{ false }}"; }],
    ["verify continues on error", "verify", (step) => { step["continue-on-error"] = true; }],
    ["public smoke continues on error", "public-smoke", (step) => { step["continue-on-error"] = true; }],
    ["verify smoke is commented out", "verify", (step) => {
      step.run = step.run.replace(
        'bun scripts/release-smoke.js "$consumer"',
        '# bun scripts/release-smoke.js "$consumer"',
      );
    }],
    ["public smoke is trapped in an unused function", "public-smoke", (step) => {
      step.run = `unused() {\n${step.run}\n}\ntrue`;
    }],
  ];
  for (const job of ["verify", "public-smoke"]) {
    const smoke = 'bun scripts/release-smoke.js "$consumer"';
    cases.push(
      [`${job} job is disabled`, job, (_step, workflow) => { workflow.jobs[job].if = "${{ false }}"; }],
      [`${job} job continues on error`, job, (_step, workflow) => {
        workflow.jobs[job]["continue-on-error"] = true;
      }],
      [`${job} exits before commands`, job, (step) => { step.run = `exit 0\n${step.run}`; }],
      [`${job} commands are sheltered by heredoc`, job, (step) => { step.run = `: <<'EOF'\n${step.run}\nEOF`; }],
      [`${job} smoke uses eval`, job, (step) => { step.run = step.run.replace(smoke, `eval '${smoke}'`); }],
      [`${job} smoke is quoted inert text`, job, (step) => { step.run = step.run.replace(smoke, `'${smoke}'`); }],
      [`${job} smoke is split across lines`, job, (step) => {
        step.run = step.run.replace(smoke, 'bun scripts/release-smoke.js \\\n  "$consumer"');
      }],
    );
  }
  for (const [name, job, mutate] of cases) {
    const mutant = structuredClone(original);
    mutate(stepFor(mutant, job), mutant);
    expect(() => validateReleaseGraph(mutant), name).toThrow();
  }
});

test("verify cannot replace the digest assertion with inert JavaScript", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const step = original.jobs.verify.steps.find((item) => item.name?.startsWith("Verify the identical"));
  step.run = step.run.replace(/node -e '.+' "\$tarball"/u,
    `node -e 'void "EXPECTED_SHA256 tested tarball digest mismatch";' "$tarball"`);
  expect(() => validateReleaseGraph(original)).toThrow();
});

test("public version assertion cannot substitute a constant for installed metadata", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const step = original.jobs["public-smoke"].steps.find((item) => item.name?.startsWith("Verify public registry"));
  step.run = step.run.replace(`require(process.argv[1]).version`, `process.env.RELEASE_VERSION`);
  expect(() => validateReleaseGraph(original)).toThrow();
});
