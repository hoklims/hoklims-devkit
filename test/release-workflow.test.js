import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const bootstrapPath = new URL("../.github/workflows/bootstrap-verify.yml", import.meta.url);
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

function assertExactJobGraph(workflow, expected) {
  const jobs = workflow?.jobs;
  if (!jobs || JSON.stringify(Object.keys(jobs)) !== JSON.stringify(Object.keys(expected))) {
    throw new Error("workflow job set differs from the canonical graph");
  }
  for (const [name, dependencies] of Object.entries(expected)) {
    if (JSON.stringify([...needs(jobs[name])]) !== JSON.stringify(dependencies)) {
      throw new Error(`${name} dependencies differ from the canonical graph`);
    }
  }
}

function stepToken(step) {
  return step?.uses ?? step?.id ?? step?.name ?? (typeof step?.run === "string" ? "run" : null);
}

function assertOrderedSteps(job, expected, label, allowedIf = {}) {
  if (JSON.stringify((job?.steps ?? []).map(stepToken)) !== JSON.stringify(expected)) {
    throw new Error(`${label} step graph differs from the canonical order`);
  }
  for (const step of job.steps) {
    if (step["continue-on-error"] !== undefined || step.if !== allowedIf[stepToken(step)]) {
      throw new Error(`${label} step conditions must be canonical and fail closed`);
    }
  }
}

function assertExactRun(step, command, label, shell) {
  if (step?.run !== command || step.shell !== shell
    || step.if !== undefined || step["continue-on-error"] !== undefined) {
    throw new Error(`${label} command or shell is not canonical`);
  }
}

function assertNoShellStartupOverrides(workflow) {
  const forbidden = new Set([
    "BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS", "PROMPT_COMMAND", "NODE_OPTIONS", "BUN_OPTIONS",
  ]);
  const inspect = (owner) => {
    if (owner && Object.prototype.hasOwnProperty.call(owner, "env")
      && (owner.env === null || typeof owner.env !== "object" || Array.isArray(owner.env))) {
      throw new Error("environment map must be a static mapping");
    }
    for (const name of Object.keys(owner?.env ?? {})) {
      if (/^BASH_FUNC_.+%%$/u.test(name)) {
        throw new Error(`forbidden shell startup override: ${name}`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error(`environment map contains an opaque key: ${name}`);
      }
      const upper = name.toUpperCase();
      if (forbidden.has(upper) || upper === "NPM_CONFIG" || upper === "NPMRC" || upper.startsWith("NPM_CONFIG_")) {
        throw new Error(`forbidden shell startup override: ${name}`);
      }
    }
    if (owner?.defaults?.run?.shell !== undefined) throw new Error("custom default shell is forbidden");
  };
  inspect(workflow);
  for (const job of Object.values(workflow?.jobs ?? {})) {
    inspect(job);
    for (const step of job.steps ?? []) inspect(step);
  }
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
  assertNoShellStartupOverrides(workflow);
  assertExactJobGraph(workflow, {
    build: [], verify: ["build"], publish: ["build", "verify"],
    "public-smoke": ["build", "publish"], release: ["public-smoke"],
  });
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object") throw new Error("release jobs missing");
  const { build, verify, publish, "public-smoke": publicSmoke, release } = jobs;
  if (![build, verify, publish, publicSmoke, release].every(Boolean)) {
    throw new Error("release graph jobs missing");
  }
  if (JSON.stringify(build.outputs) !== JSON.stringify({
    version: "${{ steps.package.outputs.version }}",
    sha256: "${{ steps.package.outputs.sha256 }}",
    integrity: "${{ steps.package.outputs.integrity }}",
  })) throw new Error("build outputs must retain the exact version and archive digests");
  assertOrderedSteps(build, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "package",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ], "build");
  assertOrderedSteps(verify, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "Install tested agent CLIs",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "Verify the identical release tarball and both host integrations",
  ], "verify");
  assertOrderedSteps(publish, [
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "Publish exact tag through npm trusted publishing",
  ], "publish");
  assertOrderedSteps(publicSmoke, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "Install tested agent CLIs",
    "Verify public registry install and both host dry-runs",
  ], "public smoke");
  assertOrderedSteps(release, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "Create GitHub release after registry verification",
  ], "release");
  const hostInstall = "npm install --global --registry=https://registry.npmjs.org @openai/codex@0.147.0 @anthropic-ai/claude-code@2.1.229";
  assertExactRun(verify.steps[5], hostInstall, "verify host CLI install", undefined);
  assertExactRun(publicSmoke.steps[5], hostInstall, "public host CLI install", undefined);
  for (const [name, job] of [["build", build], ["verify", verify], ["public smoke", publicSmoke]]) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    if (checkout?.with?.ref !== "${{ github.sha }}" || checkout.with["persist-credentials"] !== false
      || checkout.with["fetch-depth"] !== 0) {
      throw new Error(`${name} checkout must bind the full tagged source at github.sha`);
    }
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
    /^test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"$/u,
    /^git merge-base --is-ancestor HEAD origin\/main$/u,
    String.raw`version="$(node -p 'require("./package.json").version')"`,
    /^test "\$GITHUB_REF_NAME" = "v\$version"$/u,
    /^bun run check$/u,
    /^tarball="\$\(npm pack --silent\)"$/u,
    /^test "\$tarball" = "hoklims-devkit-\$\{version\}\.tgz"$/u,
    String.raw`digest="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$tarball")"`,
    String.raw`integrity="sha512-$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$tarball")"`,
    /^echo "version=\$version" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "sha256=\$digest" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "integrity=\$integrity" >> "\$GITHUB_OUTPUT"$/u,
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
  if (verifyStep?.env?.RELEASE_VERSION !== "${{ needs.build.outputs.version }}"
    || verifyStep?.env?.EXPECTED_SHA256 !== "${{ needs.build.outputs.sha256 }}") {
    throw new Error("verify digest inputs must bind to build outputs");
  }
  const verifyRuns = runs(verify).join("\n");
  if (verifyDownloads.length !== 1 || verifyDownloads[0].with?.name !== "tested-npm-tarball"
    || !verifyRuns.includes("EXPECTED_SHA256")
    || !verifyRuns.includes("tested tarball digest mismatch")) {
    throw new Error("verify must consume and smoke the identical digest-bound tarball");
  }
  assertCanonicalStep(verify, verifyStep, [
    /^test "\$\(git cat-file -t "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "tag"$/u,
    /^test "\$\(git rev-list -n 1 "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "\$GITHUB_SHA"$/u,
    /^test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"$/u,
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
  if (publishStep?.env?.RELEASE_VERSION !== "${{ needs.build.outputs.version }}"
    || publishStep?.env?.EXPECTED_SHA256 !== "${{ needs.build.outputs.sha256 }}"
    || publishStep?.env?.EXPECTED_INTEGRITY !== "${{ needs.build.outputs.integrity }}") {
    throw new Error("publish digest inputs must bind to build outputs");
  }
  assertCanonicalStep(publish, publishStep, [
    /^npm install --global --registry=https:\/\/registry\.npmjs\.org npm@11\.5\.1(?:\s+#.*)?$/u,
    /^version="\$RELEASE_VERSION"$/u,
    /^test "\$GITHUB_REF_NAME" = "v\$version"$/u,
    /^tarball="tested-package\/hoklims-devkit-\$\{version\}\.tgz"$/u,
    /^test -f "\$tarball"$/u,
    String.raw`node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const actual=crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");if(actual!==process.env.EXPECTED_SHA256)throw new Error("published tarball digest mismatch")' "$tarball"`,
    String.raw`integrity="sha512-$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$tarball")"`,
    /^test "\$integrity" = "\$EXPECTED_INTEGRITY"$/u,
    /^if npm view --registry=https:\/\/registry\.npmjs\.org "hoklims-devkit@\$version" version >\/dev\/null 2>&1; then$/u,
    /^test "\$\(npm view --registry=https:\/\/registry\.npmjs\.org "hoklims-devkit@\$version" dist\.integrity\)" = "\$integrity"$/u,
    /^else$/u,
    /^npm publish "\$tarball" --access public --registry=https:\/\/registry\.npmjs\.org$/u,
    /^fi$/u,
    /^test "\$\(npm view --registry=https:\/\/registry\.npmjs\.org "hoklims-devkit@\$version" version\)" = "\$version"$/u,
    /^test "\$\(npm view --registry=https:\/\/registry\.npmjs\.org "hoklims-devkit@\$version" dist\.integrity\)" = "\$integrity"$/u,
  ], "publish", "github.ref_name != 'v0.1.0'");

  if (JSON.stringify([...needs(publicSmoke)].sort()) !== JSON.stringify(["build", "publish"])) {
    throw new Error("public smoke must bind the built version and follow publication");
  }
  const publicStep = (publicSmoke.steps ?? []).find((step) => step.name?.startsWith("Verify public registry"));
  const requiredPublicLines = [
    /^test "\$\(git cat-file -t "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "tag"$/u,
    /^test "\$\(git rev-list -n 1 "refs\/tags\/\$\{GITHUB_REF_NAME\}"\)" = "\$GITHUB_SHA"$/u,
    /^test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"$/u,
    /^version="\$RELEASE_VERSION"$/u,
    /^test "\$GITHUB_REF_NAME" = "v\$version"$/u,
    /^consumer="\$\(mktemp -d\)"$/u,
    /^npm install --prefix "\$consumer" --ignore-scripts --package-lock=true --registry=https:\/\/registry\.npmjs\.org "hoklims-devkit@\$version"(?:\s+#.*)?$/u,
    /^node scripts\/public-install-integrity\.mjs "\$consumer" "\$version" "\$EXPECTED_INTEGRITY" "https:\/\/registry\.npmjs\.org"$/u,
    /^bun scripts\/release-smoke\.js "\$consumer"$/u,
  ];
  if (publicStep?.env?.RELEASE_VERSION !== "${{ needs.build.outputs.version }}"
    || publicStep?.env?.EXPECTED_INTEGRITY !== "${{ needs.build.outputs.integrity }}") {
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

function validateBootstrapGraph(workflow) {
  assertNoShellStartupOverrides(workflow);
  assertExactJobGraph(workflow, { verify: [], release: ["verify"] });
  const { verify, release } = workflow?.jobs ?? {};
  if (workflow?.name !== "Verify npm bootstrap release" || !verify || !release
    || verify["runs-on"] !== "ubuntu-latest" || release["runs-on"] !== "ubuntu-latest") {
    throw new Error("bootstrap workflow jobs or runners differ from the canonical graph");
  }
  const input = workflow?.on?.workflow_dispatch?.inputs?.verified_run_id;
  if (input?.required !== true || input.type !== "string") throw new Error("bootstrap verified run input is not required");
  assertOrderedSteps(verify, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "Install tested agent CLIs",
    "Verify the published bootstrap package and its exact tag",
  ], "bootstrap verify");
  assertOrderedSteps(release, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "Create GitHub release after public registry verification",
  ], "bootstrap release");
  const verifyCheckout = verify.steps[0];
  const releaseCheckout = release.steps[0];
  if (verifyCheckout.with?.ref !== "v0.1.0" || verifyCheckout.with?.["fetch-depth"] !== 0
    || verifyCheckout.with?.["persist-credentials"] !== false
    || releaseCheckout.with?.ref !== "v0.1.0" || releaseCheckout.with?.["persist-credentials"] !== false) {
    throw new Error("bootstrap checkouts must bind the immutable first tag without credentials");
  }
  assertExactRun(verify.steps[5],
    "npm install --global --registry=https://registry.npmjs.org @openai/codex@0.147.0 @anthropic-ai/claude-code@2.1.229",
    "bootstrap host CLI install", undefined);
  const verifyStep = verify.steps[6];
  if (JSON.stringify(verifyStep.env) !== JSON.stringify({
    GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", VERIFY_RUN_ID: "${{ inputs.verified_run_id }}",
  })) throw new Error("bootstrap verification inputs are not canonical");
  assertCanonicalStep(verify, verifyStep, [
    /^\[\[ "\$VERIFY_RUN_ID" =~ \^\[0-9\]\+\$ \]\]$/u,
    /^test "\$\(git cat-file -t refs\/tags\/v0\.1\.0\)" = "tag"$/u,
    /^test "\$\(git rev-list -n 1 refs\/tags\/v0\.1\.0\)" = "\$\(git rev-parse HEAD\)"$/u,
    /^git merge-base --is-ancestor HEAD origin\/main$/u,
    /^test "\$\(node -p 'require\("\.\/package\.json"\)\.version'\)" = "0\.1\.0"$/u,
    /^run_json="\$\(gh run view "\$VERIFY_RUN_ID" --repo hoklims\/hoklims-devkit --json workflowName,headSha,event,conclusion\)"$/u,
    /^test "\$\(jq -r '\.workflowName' <<< "\$run_json"\)" = "Publish npm release"$/u,
    /^test "\$\(jq -r '\.headSha' <<< "\$run_json"\)" = "\$\(git rev-parse HEAD\)"$/u,
    /^test "\$\(jq -r '\.event' <<< "\$run_json"\)" = "push"$/u,
    /^test "\$\(jq -r '\.conclusion' <<< "\$run_json"\)" = "success"$/u,
    /^gh run download "\$VERIFY_RUN_ID" --repo hoklims\/hoklims-devkit --name tested-npm-tarball --dir tested-package$/u,
    /^tarball="tested-package\/hoklims-devkit-0\.1\.0\.tgz"$/u,
    /^test -f "\$tarball"$/u,
    String.raw`integrity="sha512-$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$tarball")"`,
    /^test "\$\(npm view --registry=https:\/\/registry\.npmjs\.org hoklims-devkit@0\.1\.0 version\)" = "0\.1\.0"$/u,
    /^test "\$\(npm view --registry=https:\/\/registry\.npmjs\.org hoklims-devkit@0\.1\.0 dist\.integrity\)" = "\$integrity"$/u,
    /^bun run check$/u,
    /^consumer="\$\(mktemp -d\)"$/u,
    /^npm install --prefix "\$consumer" --ignore-scripts --package-lock=true --registry=https:\/\/registry\.npmjs\.org hoklims-devkit@0\.1\.0(?:\s+#.*)?$/u,
    /^node scripts\/public-install-integrity\.mjs "\$consumer" "0\.1\.0" "\$integrity" "https:\/\/registry\.npmjs\.org"$/u,
    /^bun scripts\/release-smoke\.js "\$consumer"$/u,
  ], "bootstrap verify");
  if (release.permissions?.contents !== "write") throw new Error("bootstrap release lacks contents write permission");
  assertExactRun(release.steps[1],
    "gh release view v0.1.0 >/dev/null 2>&1 || gh release create v0.1.0 --verify-tag --generate-notes",
    "bootstrap release", undefined);
  return true;
}

function validateCiCheckout(workflow) {
  assertNoShellStartupOverrides(workflow);
  assertExactJobGraph(workflow, { package: [] });
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
  assertOrderedSteps(job, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "run",
    "Test packaged CLI outside checkout",
  ], "CI package");
  assertExactRun(job.steps[3], "bun run check", "CI check", undefined);
  assertCanonicalStep(job, job.steps[4], [
    /^tarball="\$\(npm pack --silent\)"$/u,
    /^consumer="\$\(mktemp -d\)"$/u,
    /^npm install --prefix "\$consumer" --ignore-scripts "\$PWD\/\$tarball"(?:\s+#.*)?$/u,
    /^cd "\$consumer"$/u,
    /^bunx --no-install hoklims-devkit --help$/u,
    /^test "\$\(bunx --no-install hoklims-devkit --version\)" = "\$\(node -p 'require\("\.\/node_modules\/hoklims-devkit\/package\.json"\)\.version'\)"$/u,
  ], "CI packaged CLI");
  return true;
}

function directCheckout(job) {
  const checkout = (job?.steps ?? []).find((step) => step.uses?.startsWith("actions/checkout@"));
  return checkout?.with?.ref === "${{ github.event.pull_request.head.sha || github.sha }}"
    && checkout.with["persist-credentials"] === false;
}

function validateNativeNoLc(workflow, harnessSource) {
  assertNoShellStartupOverrides(workflow);
  assertExactJobGraph(workflow, { build: [], native: ["build"] });
  const { build, native } = workflow?.jobs ?? {};
  if (workflow?.name !== "Native no-LC" || !build || !native
    || JSON.stringify(Object.keys(workflow.on ?? {})) !== JSON.stringify(["pull_request"])) {
    throw new Error("native no-LC jobs or pull-request trigger missing");
  }
  if (!directCheckout(build) || !directCheckout(native)) throw new Error("native no-LC must test the direct head");
  assertOrderedSteps(build, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "package",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ], "native build");
  assertOrderedSteps(native, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "Run four owned native lanes without Latent Compass",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ], "native", {
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02": "always()",
  });
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
    String.raw`digest="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "native-package/$tarball")"`,
    /^echo "version=\$version" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "source-sha=\$source_sha" >> "\$GITHUB_OUTPUT"$/u,
    /^echo "sha256=\$digest" >> "\$GITHUB_OUTPUT"$/u,
  ], "native package");
  const uploads = uses(build, "actions/upload-artifact@");
  const downloads = uses(native, "actions/download-artifact@");
  if (uploads.length !== 1 || uploads[0].with?.name !== "devkit-native-package"
    || uploads[0].with?.path !== "native-package/hoklims-devkit-*.tgz"
    || downloads.length !== 1 || downloads[0].with?.name !== "devkit-native-package"
    || downloads[0].with?.path !== "${{ runner.temp }}/native-package") {
    throw new Error("native no-LC must preserve and consume one exact artifact");
  }
  const smoke = (native.steps ?? []).find((step) => step.name?.startsWith("Run four owned"));
  assertCanonicalStep(native, smoke, [
    /^tarball="\$RUNNER_TEMP\/native-package\/hoklims-devkit-\$\{DEVKIT_VERSION\}\.tgz"$/u,
    /^test -f "\$tarball"$/u,
    /^test "\$\(git rev-parse HEAD\)" = "\$DEVKIT_SOURCE_SHA"$/u,
    /^npm_cli="\$\(node scripts\/native-runtime-paths\.mjs\)"$/u,
    /^semctx_sha="\$\(npm view semctx@0\.3\.7 gitHead\)"$/u,
    String.raw`physical_temp="$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$RUNNER_TEMP")"`,
    /^run_root="\$physical_temp\/devkit-native-no-lc"$/u,
    /^config="\$physical_temp\/devkit-native-no-lc-config\.json"$/u,
    /^node scripts\/native-no-lc-config\.mjs "\$config" "\$run_root" "\$PWD" "\$tarball" "\$semctx_sha" "\$npm_cli"$/u,
    /^node scripts\/native-no-lc-smoke\.mjs "\$config"$/u,
    /^test -f "\$run_root\/evidence\/PASS"$/u,
  ], "native smoke");
  if (!harnessSource.includes('assert(["win32", "linux", "darwin"].includes(process.platform)')
    || !harnessSource.includes('semctx: config.expected.semctx')
    || !harnessSource.includes('allowAssertLedgerUnsafeDemo')
    || !harnessSource.includes('.map((value) => path.resolve(value))')) {
    throw new Error("native harness lacks its platform, Semctx, or explicit demo boundary");
  }
  return true;
}

test("release workflow builds once, verifies one artifact on three OSes, then publishes in order", () => {
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  expect(validateReleaseGraph(workflow)).toBe(true);
});

test("bootstrap verification binds the downloaded first-release archive before release", () => {
  expect(validateBootstrapGraph(Bun.YAML.parse(readFileSync(bootstrapPath, "utf8")))).toBe(true);
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
    (workflow) => {
      const step = workflow.jobs.native.steps.find((item) => item.name?.startsWith("Run four owned"));
      step.run = step.run.replace(
        /node scripts\/native-no-lc-config\.mjs .+/u,
        'node -e \'const fs=require("node:fs");fs.mkdirSync(process.argv[2]+"/evidence",{recursive:true});fs.writeFileSync(process.argv[2]+"/evidence/PASS","synthetic");fs.writeFileSync("scripts/native-no-lc-smoke.mjs","process.exit(0);")\' "$config" "$run_root" "$PWD" "$tarball" "$semctx_sha" "$npm_cli"',
      );
    },
  ];
  for (const mutate of cases) {
    const mutant = structuredClone(original);
    mutate(mutant);
    expect(() => validateNativeNoLc(mutant, harness)).toThrow();
  }
});

test("native configuration command rejects opaque JavaScript harness bypass", () => {
  const workflow = Bun.YAML.parse(readFileSync(nativePath, "utf8"));
  const harness = readFileSync(nativeHarnessPath, "utf8");
  const step = workflow.jobs.native.steps.find((item) => item.name?.startsWith("Run four owned"));
  step.run = step.run.replace(
    /node scripts\/native-no-lc-config\.mjs .+/u,
    'node -e \'const fs=require("node:fs");fs.mkdirSync(process.argv[2]+"/evidence",{recursive:true});fs.writeFileSync(process.argv[2]+"/evidence/PASS","synthetic");fs.writeFileSync("scripts/native-no-lc-smoke.mjs","process.exit(0);")\' "$config" "$run_root" "$PWD" "$tarball" "$semctx_sha" "$npm_cli"',
  );
  expect(() => validateNativeNoLc(workflow, harness)).toThrow();
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
    ["duplicate verify step", (workflow) => {
      workflow.jobs.verify.steps.push(structuredClone(
        workflow.jobs.verify.steps.find((step) => step.name?.startsWith("Verify the identical")),
      ));
    }],
    ["disconnected verify digest", (workflow) => {
      workflow.jobs.verify.steps.find((step) => step.name?.startsWith("Verify the identical"))
        .env.EXPECTED_SHA256 = "deadbeef";
    }],
    ["root bash startup override", (workflow) => {
      workflow.env = { BASH_ENV: ".github/bypass.sh" };
    }],
    ["publish bash startup override", (workflow) => {
      workflow.jobs.publish.env = { BASH_ENV: ".github/bypass.sh" };
    }],
    ["verify host install neutralized", (workflow) => { workflow.jobs.verify.steps[5].run = "true"; }],
    ["public host install neutralized", (workflow) => { workflow.jobs["public-smoke"].steps[5].run = "true"; }],
  ];
  for (const [name, mutate] of cases) {
    const mutant = structuredClone(original);
    mutate(mutant);
    expect(() => validateReleaseGraph(mutant), name).toThrow();
  }
});

test("release source checkouts bind build verify and public smoke to github.sha", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  for (const jobName of ["build", "verify", "public-smoke"]) {
    const oldRef = structuredClone(original);
    oldRef.jobs[jobName].steps[0].with.ref = "31be7ba18da0397391bb55d5db12afcb65893c0f";
    expect(() => validateReleaseGraph(oldRef), `${jobName}:old-ref`).toThrow(/checkout/u);
  }
});

test("release executable steps bind HEAD to the tagged github.sha before source execution", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  for (const jobName of ["build", "verify", "public-smoke"]) {
    const bypass = structuredClone(original);
    const step = bypass.jobs[jobName].steps.find((item) => typeof item.run === "string"
      && item.run.includes("git rev-parse HEAD"));
    step.run = step.run.replace('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"', "true");
    expect(() => validateReleaseGraph(bypass), `${jobName}:head-binding`).toThrow(/commands/u);
  }
});

test("CI direct-head checkout rejects merge-ref and reduced-matrix mutants", () => {
  const original = Bun.YAML.parse(readFileSync(ciPath, "utf8"));
  const cases = [
    (workflow) => { delete workflow.jobs.package.steps[0].with.ref; },
    (workflow) => { workflow.jobs.package.steps[0].with.ref = "${{ github.sha }}"; },
    (workflow) => { workflow.jobs.package.strategy.matrix.exclude = [{ os: "windows-latest" }]; },
    (workflow) => { workflow.jobs.package.if = "${{ false }}"; },
    (workflow) => { workflow.jobs.package["continue-on-error"] = true; },
    (workflow) => { workflow.jobs.package.steps[3].if = "${{ false }}"; },
    (workflow) => { workflow.jobs.package.steps[3].run = "true"; },
    (workflow) => { workflow.jobs.package.steps[3].shell = "bash -c 'exit 0' {0}"; },
    (workflow) => { workflow.jobs.package.steps[3].run = `exit 0\n${workflow.jobs.package.steps[3].run}`; },
    (workflow) => {
      const step = workflow.jobs.package.steps.find((item) => item.name?.startsWith("Test packaged"));
      step.run = `: <<'EOF'\n${step.run}\nEOF`;
    },
    (workflow) => { workflow.env = { BASH_ENV: ".github/bypass.sh" }; },
  ];
  for (const mutate of cases) {
    const mutant = structuredClone(original);
    mutate(mutant);
    expect(() => validateCiCheckout(mutant)).toThrow();
  }
});

test("all workflow oracles reject skipped prerequisites on their entry job", () => {
  const sources = [
    [workflowPath, validateReleaseGraph, "build", null],
    [bootstrapPath, validateBootstrapGraph, "verify", null],
    [ciPath, validateCiCheckout, "package", null],
    [nativePath, (workflow) => validateNativeNoLc(workflow, readFileSync(nativeHarnessPath, "utf8")), "build", null],
  ];
  for (const [file, validate, entryJob] of sources) {
    const workflow = Bun.YAML.parse(readFileSync(file, "utf8"));
    workflow.jobs.omitted = { if: "${{ false }}", "runs-on": "ubuntu-latest", steps: [{ run: "true" }] };
    workflow.jobs[entryJob].needs = ["omitted"];
    expect(() => validate(workflow), file.pathname).toThrow(/job set|dependencies/u);
  }
});

test("exported Bash functions are rejected at workflow job and step scope", () => {
  const sources = [
    [workflowPath, validateReleaseGraph, "verify", 7],
    [bootstrapPath, validateBootstrapGraph, "verify", 6],
    [ciPath, validateCiCheckout, "package", 3],
    [nativePath, (workflow) => validateNativeNoLc(
      workflow, readFileSync(nativeHarnessPath, "utf8"),
    ), "native", 4],
  ];
  for (const [path, validate, jobName, stepIndex] of sources) {
    for (const scope of ["workflow", "job", "step"]) {
      const workflow = Bun.YAML.parse(readFileSync(path, "utf8"));
      const env = { "BASH_FUNC_bun%%": "() { :; }" };
      if (scope === "workflow") workflow.env = env;
      if (scope === "job") workflow.jobs[jobName].env = env;
      if (scope === "step") workflow.jobs[jobName].steps[stepIndex].env = {
        ...(workflow.jobs[jobName].steps[stepIndex].env ?? {}), ...env,
      };
      expect(() => validate(workflow), `${path.pathname}:${scope}`).toThrow(/shell startup override/u);
    }
  }
});

test("runtime preload options are rejected at workflow job and step scope", () => {
  const sources = [
    [workflowPath, validateReleaseGraph, "verify", 7],
    [bootstrapPath, validateBootstrapGraph, "verify", 6],
    [ciPath, validateCiCheckout, "package", 3],
    [nativePath, (workflow) => validateNativeNoLc(
      workflow, readFileSync(nativeHarnessPath, "utf8"),
    ), "native", 4],
  ];
  for (const [path, validate, jobName, stepIndex] of sources) {
    for (const name of ["NODE_OPTIONS", "BUN_OPTIONS"]) {
      for (const scope of ["workflow", "job", "step"]) {
        const workflow = Bun.YAML.parse(readFileSync(path, "utf8"));
        const env = { [name]: "--import=data:text/javascript,process.exit(0)" };
        if (scope === "workflow") workflow.env = env;
        if (scope === "job") workflow.jobs[jobName].env = env;
        if (scope === "step") workflow.jobs[jobName].steps[stepIndex].env = {
          ...(workflow.jobs[jobName].steps[stepIndex].env ?? {}), ...env,
        };
        expect(() => validate(workflow), `${path.pathname}:${name}:${scope}`).toThrow(/startup override/u);
      }
    }
  }
});

test("opaque environment maps are rejected at every workflow job and step scope", () => {
  const sources = [
    [workflowPath, validateReleaseGraph, "verify", 7],
    [bootstrapPath, validateBootstrapGraph, "verify", 6],
    [ciPath, validateCiCheckout, "package", 3],
    [nativePath, (workflow) => validateNativeNoLc(
      workflow, readFileSync(nativeHarnessPath, "utf8"),
    ), "native", 4],
  ];
  const opaqueValues = [
    null,
    [],
    "${{ fromJSON('{\"NODE_OPTIONS\":\"--import=data:text/javascript,process.exit(0)\"}') }}",
    { "${{ fromJSON('[]')[0] }}": "hidden" },
  ];
  for (const [path, validate, jobName, stepIndex] of sources) {
    for (const env of opaqueValues) {
      for (const scope of ["workflow", "job", "step"]) {
        const workflow = Bun.YAML.parse(readFileSync(path, "utf8"));
        if (scope === "workflow") workflow.env = structuredClone(env);
        if (scope === "job") workflow.jobs[jobName].env = structuredClone(env);
        if (scope === "step") workflow.jobs[jobName].steps[stepIndex].env = structuredClone(env);
        expect(() => validate(workflow), `${path.pathname}:${scope}:${JSON.stringify(env)}`).toThrow(/environment map/u);
      }
    }
  }
});

test("all workflow oracles reject registry and npm config overrides at every scope and casing", () => {
  const sources = [
    [workflowPath, validateReleaseGraph, "public-smoke", 6],
    [bootstrapPath, validateBootstrapGraph, "verify", 6],
    [ciPath, validateCiCheckout, "package", 3],
    [nativePath, (workflow) => validateNativeNoLc(
      workflow, readFileSync(nativeHarnessPath, "utf8"),
    ), "native", 4],
  ];
  for (const key of [
    "npm_config_registry", "NPM_CONFIG_REGISTRY", "Npm_Config_UserConfig",
    "npm_config_globalconfig", "NPM_CONFIG_PREFIX", "npmrc",
  ]) {
    for (const [source, validate, jobName, stepIndex] of sources) {
      for (const scope of ["workflow", "job", "step"]) {
        const workflow = Bun.YAML.parse(readFileSync(source, "utf8"));
        const target = scope === "workflow" ? workflow : scope === "job" ? workflow.jobs[jobName]
          : workflow.jobs[jobName].steps[stepIndex];
        target.env = { ...(target.env ?? {}), [key]: "https://registry.example.invalid" };
        expect(() => validate(workflow), `${source.pathname}:${scope}:${key}`).toThrow(/startup override/u);
      }
    }
  }
});

test("public smoke binds same-version installation integrity before CLI and GitHub release", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const mutatePublic = (mutate) => {
    const workflow = structuredClone(original);
    const step = workflow.jobs["public-smoke"].steps.find((candidate) => candidate.name?.startsWith("Verify public registry"));
    mutate(workflow, step);
    expect(() => validateReleaseGraph(workflow)).toThrow();
  };
  mutatePublic((workflow) => { workflow.jobs.build.outputs.integrity = "same-registry-metadata"; });
  mutatePublic((_workflow, step) => { delete step.env.EXPECTED_INTEGRITY; });
  mutatePublic((_workflow, step) => {
    step.run = step.run.replace(/node scripts\/public-install-integrity\.mjs[^\n]+\n/u, "");
  });
  mutatePublic((_workflow, step) => {
    step.run = step.run.replace(
      'node scripts/public-install-integrity.mjs "$consumer" "$version" "$EXPECTED_INTEGRITY" "https://registry.npmjs.org"\n' +
      'bun scripts/release-smoke.js "$consumer"',
      'bun scripts/release-smoke.js "$consumer"\n' +
      'node scripts/public-install-integrity.mjs "$consumer" "$version" "$EXPECTED_INTEGRITY" "https://registry.npmjs.org"',
    );
  });
  mutatePublic((_workflow, step) => {
    step.run = step.run.replace("--registry=https://registry.npmjs.org", "--registry=https://registry.example.invalid");
  });
  mutatePublic((workflow) => { workflow.jobs.release.needs = "publish"; });
});

test("bootstrap refuses integrity neutralization before smoke and GitHub release", () => {
  const original = Bun.YAML.parse(readFileSync(bootstrapPath, "utf8"));
  const mutate = (change) => {
    const workflow = structuredClone(original);
    const step = workflow.jobs.verify.steps.find((candidate) => candidate.name?.startsWith("Verify the published bootstrap"));
    change(workflow, step);
    expect(() => validateBootstrapGraph(workflow)).toThrow();
  };
  mutate((_workflow, step) => {
    step.run = step.run.replace(/node scripts\/public-install-integrity\.mjs[^\n]+\n/u, "");
  });
  mutate((_workflow, step) => {
    step.run = step.run.replace(
      'node scripts/public-install-integrity.mjs "$consumer" "0.1.0" "$integrity" "https://registry.npmjs.org"\n' +
      'bun scripts/release-smoke.js "$consumer"',
      'bun scripts/release-smoke.js "$consumer"\n' +
      'node scripts/public-install-integrity.mjs "$consumer" "0.1.0" "$integrity" "https://registry.npmjs.org"',
    );
  });
  mutate((_workflow, step) => {
    step.run = step.run.replace('"$integrity" "https://registry.npmjs.org"', '"sha512-AAAAAAAA" "https://registry.npmjs.org"');
  });
  mutate((_workflow, step) => {
    step.run = step.run.replaceAll("--registry=https://registry.npmjs.org", "--registry=https://registry.example.invalid");
  });
  mutate((workflow) => { workflow.jobs.release.needs = []; });
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
    ["node scripts/public-install-integrity.mjs", "true # node scripts/public-install-integrity.mjs"],
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

test("public integrity assertion cannot substitute build environment constants for installed metadata", () => {
  const original = Bun.YAML.parse(readFileSync(workflowPath, "utf8"));
  const step = original.jobs["public-smoke"].steps.find((item) => item.name?.startsWith("Verify public registry"));
  step.run = step.run.replace(/node scripts\/public-install-integrity\.mjs[^\n]+/u,
    `test "$EXPECTED_INTEGRITY" = "$EXPECTED_INTEGRITY"`);
  expect(() => validateReleaseGraph(original)).toThrow();
});
