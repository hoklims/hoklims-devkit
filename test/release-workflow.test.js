import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const ciPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const nativePath = new URL("../.github/workflows/native-no-lc.yml", import.meta.url);
const nativeHarnessPath = new URL("../scripts/native-no-lc-smoke.mjs", import.meta.url);

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

function assertCanonicalStep(job, step, patterns, label, expectedJobIf) {
  if (job?.if !== expectedJobIf || job?.["continue-on-error"] !== undefined) {
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
  if (build["runs-on"] !== "ubuntu-latest" || verify["runs-on"] !== "${{ matrix.os }}"
    || publish["runs-on"] !== "ubuntu-latest" || publicSmoke["runs-on"] !== "ubuntu-latest"
    || release["runs-on"] !== "ubuntu-latest") {
    throw new Error("release jobs must use their canonical runners");
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
  const buildStep = (build.steps ?? []).find((step) => step.id === "package");
  assertCanonicalStep(build, buildStep, [
    /^test "\$\(git cat-file -t "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "tag"$/u,
    /^test "\$\(git rev-list -n 1 "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "\$GITHUB_SHA"$/u,
    /^git merge-base --is-ancestor HEAD origin\/main$/u,
    String.raw`version="$(node -p 'require("./package.json").version')"`,
    /^test "\$GITHUB_REF_NAME" = "v\$version"$/u,
    /^bun run check$/u,
    /^tarball="\$\(npm pack --silent\)"$/u,
    /^test "\$tarball" = "hoklims-devkit-\$\{version\}\.tgz"$/u,
    String.raw`digest="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$tarball")"`,
    /^echo "version=\$version" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "sha256=\$digest" >> "\$GITHUB_OUTPUT"$/u,
  ], "build package");

  if (JSON.stringify(Object.keys(verify.strategy?.matrix ?? {})) !== JSON.stringify(["os"])
    || JSON.stringify(verify.strategy?.matrix?.os) !== JSON.stringify([
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
  const publishStep = (publish.steps ?? []).find((step) => step.name?.startsWith("Publish exact tag"));
  assertCanonicalStep(publish, publishStep, [
    /^npm install --global npm@11\.5\.1(?:\s+#.*)?$/u,
    /^version="\$RELEASE_VERSION"$/u,
    /^test "\$GITHUB_REF_NAME" = "v\$version"$/u,
    /^tarball="tested-package\/hoklims-devkit-\$\{version\}\.tgz"$/u,
    /^test -f "\$tarball"$/u,
    String.raw`node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const actual=crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");if(actual!==process.env.EXPECTED_SHA256)throw new Error("published tarball digest mismatch")' "$tarball"`,
    String.raw`integrity="sha512-$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$tarball")"`,
    /^if npm view "hoklims-devkit@\$version" version >\/dev\/null 2>&1; then$/u,
    /^test "\$\(npm view "hoklims-devkit@\$version" dist\.integrity\)" = "\$integrity"$/u,
    /^else$/u,
    /^npm publish "\$tarball" --access public$/u,
    /^fi$/u,
    /^test "\$\(npm view "hoklims-devkit@\$version" version\)" = "\$version"$/u,
    /^test "\$\(npm view "hoklims-devkit@\$version" dist\.integrity\)" = "\$integrity"$/u,
  ], "publish", "github.ref_name != 'v0.1.0'");

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
  const releaseStep = (release.steps ?? []).find((step) => step.name?.startsWith("Create GitHub release"));
  assertCanonicalStep(release, releaseStep, [
    /^gh release view "\$GITHUB_REF_NAME" >\/dev\/null 2>&1 \|\| gh release create "\$GITHUB_REF_NAME" --verify-tag --generate-notes$/u,
  ], "release");
  return true;
}

function validateCiCheckout(workflow) {
  const job = workflow?.jobs?.package;
  if (!job || job["runs-on"] !== "${{ matrix.os }}"
    || JSON.stringify(Object.keys(job.strategy?.matrix ?? {})) !== JSON.stringify(["os"])
    || JSON.stringify(job.strategy.matrix.os) !== JSON.stringify([
      "ubuntu-latest", "windows-latest", "macos-latest",
    ])) throw new Error("CI package matrix is not the exact three-runner set");
  const checkout = (job.steps ?? []).find((step) => step.uses?.startsWith("actions/checkout@"));
  if (checkout?.with?.ref !== "${{ github.event.pull_request.head.sha || github.sha }}") {
    throw new Error("CI must test the direct pull-request head or push SHA");
  }
  return true;
}

function directCheckout(job) {
  const checkout = (job?.steps ?? []).find((step) => step.uses?.startsWith("actions/checkout@"));
  return checkout?.with?.ref === "${{ github.event.pull_request.head.sha || github.sha }}"
    && checkout.with["persist-credentials"] === false;
}

function validateNativeNoLc(workflow, harnessSource) {
  const { build, native } = workflow?.jobs ?? {};
  if (workflow?.name !== "Native no-LC" || !build || !native
    || JSON.stringify(Object.keys(workflow.on ?? {})) !== JSON.stringify(["pull_request"])) {
    throw new Error("native no-LC jobs or pull-request trigger missing");
  }
  if (!directCheckout(build) || !directCheckout(native)) throw new Error("native no-LC must test the direct head");
  if (build["runs-on"] !== "ubuntu-latest" || native["runs-on"] !== "${{ matrix.os }}"
    || JSON.stringify([...needs(native)]) !== JSON.stringify(["build"])
    || JSON.stringify(Object.keys(native.strategy?.matrix ?? {})) !== JSON.stringify(["os"])
    || JSON.stringify(native.strategy.matrix.os) !== JSON.stringify([
      "ubuntu-latest", "windows-latest", "macos-latest",
    ])) throw new Error("native no-LC must execute the exact three-runner matrix");
  const packageStep = (build.steps ?? []).find((step) => step.id === "package");
  if (runs(build).length !== 1 || runs(native).length !== 1) {
    throw new Error("native no-LC must have one canonical executable script per job");
  }
  assertCanonicalStep(build, packageStep, [
    /^bun run check$/u,
    String.raw`version="$(node -p 'require("./package.json").version')"`,
    /^source_sha="\$\(git rev-parse HEAD\)"$/u,
    /^mkdir native-package$/u,
    /^tarball="\$\(npm pack --silent --ignore-scripts --pack-destination native-package\)"$/u,
    /^test "\$tarball" = "hoklims-devkit-\$\{version\}\.tgz"$/u,
    /^digest="\$\(node -e '.+' "native-package\/\$tarball"\)"$/u,
    /^echo "version=\$version" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "source-sha=\$source_sha" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "sha256=\$digest" >> "\$GITHUB_OUTPUT"$/u,
  ], "native package");
  const uploads = uses(build, "actions/upload-artifact@");
  const downloads = uses(native, "actions/download-artifact@");
  if (uploads.length !== 1 || uploads[0].with?.name !== "devkit-native-package"
    || uploads[0].with?.path !== "native-package/hoklims-devkit-*.tgz"
    || downloads.length !== 1 || downloads[0].with?.name !== "devkit-native-package") {
    throw new Error("native no-LC must preserve and consume one exact artifact");
  }
  const smoke = (native.steps ?? []).find((step) => step.name?.startsWith("Run four owned"));
  assertCanonicalStep(native, smoke, [
    /^tarball="\$PWD\/native-package\/hoklims-devkit-\$\{DEVKIT_VERSION\}\.tgz"$/u,
    /^test -f "\$tarball"$/u,
    /^test "\$\(git rev-parse HEAD\)" = "\$DEVKIT_SOURCE_SHA"$/u,
    /^npm_cli="\$\(npm root -g\)\/npm\/bin\/npm-cli\.js"$/u,
    /^test -f "\$npm_cli"$/u,
    /^semctx_sha="\$\(npm view semctx@0\.3\.7 gitHead\)"$/u,
    /^run_root="\$RUNNER_TEMP\/devkit-native-no-lc"$/u,
    /^config="\$RUNNER_TEMP\/devkit-native-no-lc-config\.json"$/u,
    /^node -e '.+' "\$config" "\$run_root" "\$PWD" "\$tarball" "\$semctx_sha" "\$npm_cli"$/u,
    /^node scripts\/native-no-lc-smoke\.mjs "\$config"$/u,
    /^test -f "\$run_root\/evidence\/PASS"$/u,
  ], "native smoke");
  if (!harnessSource.includes('assert(["win32", "linux", "darwin"].includes(process.platform)')
    || !harnessSource.includes('semctx: config.expected.semctx')
    || !harnessSource.includes('allowAssertLedgerUnsafeDemo')) {
    throw new Error("native harness lacks its platform, Semctx, or explicit demo boundary");
  }
  return true;
}

test("release workflow builds once, verifies one artifact on three OSes, then publishes in order", () => {
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  expect(validateReleaseGraph(workflow)).toBe(true);
});

test("CI checks out and tests the direct candidate SHA on all three runners", () => {
  expect(validateCiCheckout(Bun.YAML.parse(readFileSync(ciPath, "utf8")))).toBe(true);
});

test("native no-LC workflow binds one artifact to direct-head three-OS execution", () => {
  expect(validateNativeNoLc(
    Bun.YAML.parse(readFileSync(nativePath, "utf8")), readFileSync(nativeHarnessPath, "utf8"),
  )).toBe(true);
});

test("native no-LC workflow rejects head, artifact, matrix, and silent-skip mutants", () => {
  const original = Bun.YAML.parse(readFileSync(nativePath, "utf8"));
  const harness = readFileSync(nativeHarnessPath, "utf8");
  const cases = [
    (workflow) => { delete workflow.jobs.native.steps[0].with.ref; },
    (workflow) => { workflow.jobs.native.strategy.matrix.exclude = [{ os: "macos-latest" }]; },
    (workflow) => { workflow.jobs.native["runs-on"] = "ubuntu-latest"; },
    (workflow) => { workflow.jobs.native.steps.find((step) => step.name?.startsWith("Run four owned")).if = "${{ false }}"; },
    (workflow) => { workflow.jobs.native.steps.find((step) => step.name?.startsWith("Run four owned")).run += " || true"; },
    (workflow) => { workflow.jobs.build.steps.push({ run: "npm pack --silent" }); },
    (workflow) => { workflow.jobs.native.steps.find((step) => step.uses?.startsWith("actions/download-artifact@")).with.name = "other"; },
  ];
  for (const mutate of cases) {
    const mutant = structuredClone(original);
    mutate(mutant);
    expect(() => validateNativeNoLc(mutant, harness)).toThrow();
  }
});

test("release critical jobs reject runner, condition, and inert-script bypasses", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const cases = [
    ["matrix exclusion", (workflow) => {
      workflow.jobs.verify.strategy.matrix.exclude = [
        { os: "windows-latest" }, { os: "macos-latest" },
      ];
    }],
    ["verify fixed runner", (workflow) => { workflow.jobs.verify["runs-on"] = "ubuntu-latest"; }],
    ["publish always", (workflow) => { workflow.jobs.publish.if = "${{ always() }}"; }],
    ["publish continues", (workflow) => { workflow.jobs.publish["continue-on-error"] = true; }],
    ["publish step disabled", (workflow) => {
      workflow.jobs.publish.steps.find((step) => step.name?.startsWith("Publish exact tag")).if = "${{ false }}";
    }],
    ["build commands in heredoc", (workflow) => {
      const step = workflow.jobs.build.steps.find((item) => item.id === "package");
      step.run = `: <<'EOF'\n${step.run}\nEOF`;
    }],
    ["publish commands in heredoc", (workflow) => {
      const step = workflow.jobs.publish.steps.find((item) => item.name?.startsWith("Publish exact tag"));
      step.run = `: <<'EOF'\n${step.run}\nEOF`;
    }],
    ["release step disabled", (workflow) => {
      workflow.jobs.release.steps.find((step) => step.name?.startsWith("Create GitHub release")).if = "${{ false }}";
    }],
  ];
  for (const [name, mutate] of cases) {
    const mutant = structuredClone(original);
    mutate(mutant);
    expect(() => validateReleaseGraph(mutant), name).toThrow();
  }
});

test("CI direct-head checkout rejects merge-ref and reduced-matrix mutants", () => {
  const original = Bun.YAML.parse(readFileSync(ciPath, "utf8"));
  const cases = [
    (workflow) => { delete workflow.jobs.package.steps[0].with.ref; },
    (workflow) => { workflow.jobs.package.steps[0].with.ref = "${{ github.sha }}"; },
    (workflow) => { workflow.jobs.package.strategy.matrix.exclude = [{ os: "windows-latest" }]; },
  ];
  for (const mutate of cases) {
    const mutant = structuredClone(original);
    mutate(mutant);
    expect(() => validateCiCheckout(mutant)).toThrow();
  }
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
