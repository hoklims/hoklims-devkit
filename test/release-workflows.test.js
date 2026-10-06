import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const release = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const bootstrap = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/bootstrap-verify.yml", import.meta.url), "utf8"));
const buildRun = release.jobs.build.steps.find(step => step.id === "package").run;
const verifyRun = release.jobs.verify.steps.find(step => step.env?.EXPECTED_SHA256).run;
const bootstrapRun = bootstrap.jobs.verify.steps.find(step => step.env?.VERIFY_RUN_ID).run;
const fixtures = [];
afterAll(() => { for (const root of fixtures) if (dirname(root) === realpathSync(tmpdir())) rmSync(root, { recursive: true, force: true }); });

test("first-publication version and artifact bindings agree across all release entrypoints", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
  // The current package may advance; the bootstrap remains bound to its first tag.
  expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
  for (const path of ["plugin.json", ".codex-plugin/plugin.json"]) {
    expect(JSON.parse(readFileSync(new URL(`../plugins/hoklims-proof/${path}`, import.meta.url))).version).toBe(version);
  }
  expect(release.jobs.publish.if).toBe("github.ref_name != 'v0.1.1'");
  expect(bootstrap.jobs.verify.steps[0].with.ref).toBe("v0.1.1");
  expect(bootstrap.jobs.release.steps[0].with.ref).toBe("v0.1.1");
  for (const run of [buildRun, verifyRun, bootstrapRun]) {
    const fetch = run.indexOf("git fetch --no-tags origin");
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeLessThan(run.indexOf("git cat-file -t"));
    expect(run).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(run).toContain("git rev-list -n 1");
  }
  expect(bootstrapRun).toContain("tested-package/hoklims-devkit-0.1.1.tgz");
  expect(bootstrapRun).toContain("npm view hoklims-devkit@0.1.1 dist.integrity");
  expect(release.jobs.verify.needs).toBe("build");
  expect(release.jobs.publish.needs).toEqual(["build", "verify"]);
  expect(release.jobs.verify.steps.find(step => step.env?.EXPECTED_SHA256).env.EXPECTED_SHA256).toBe("${{ needs.build.outputs.sha256 }}");
});

function git(cwd, ...args) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

for (const mode of ["annotated", "lightweight", "wrong-commit", "non-main"]) {
  test(`actual Git fallback and workflow preflights: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-tag-ref-")));
    fixtures.push(root);
    const origin = join(root, "origin"), consumer = join(root, "consumer");
    const init = Bun.spawnSync(["git", "init", "-b", "main", origin], { stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);
    writeFileSync(join(origin, "package.json"), '{"version":"0.1.1"}\n');
    git(origin, "add", ".");
    git(origin, "-c", "user.name=Tag Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "main");
    const main = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-b", "side");
    writeFileSync(join(origin, "side.txt"), "isolated side\n");
    git(origin, "add", ".");
    git(origin, "-c", "user.name=Tag Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "side");
    const side = git(origin, "rev-parse", "HEAD");
    const tagged = ["wrong-commit", "non-main"].includes(mode) ? side : main;
    if (mode === "lightweight") git(origin, "tag", "v0.1.1", tagged);
    else git(origin, "-c", "user.name=Tag Fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", "v0.1.1", tagged, "-m", "fixture");
    const originalTag = git(origin, "rev-parse", "refs/tags/v0.1.1");
    expect(Bun.spawnSync(["git", "init", consumer], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    git(consumer, "remote", "add", "origin", origin);
    git(consumer, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/tags/*:refs/tags/*");
    const expected = mode === "non-main" ? side : main;
    // Replay the observed actions/checkout fallback, which flattens only the local ref.
    git(consumer, "fetch", "--no-tags", "origin", `+${expected}:refs/tags/v0.1.1`);
    expect(git(consumer, "cat-file", "-t", "refs/tags/v0.1.1")).toBe("commit");
    git(consumer, "checkout", "--detach", expected);
    for (const [entry, run] of [["build", buildRun], ["verify", verifyRun], ["bootstrap", bootstrapRun]]) {
      const preflight = entry === "bootstrap" ? run.split("run_json=")[0] : run.split("bun run check")[0];
      const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
      const result = Bun.spawnSync([bash, "--noprofile", "--norc", "-e", "-c", preflight], {
        cwd: consumer, env: { ...process.env, GITHUB_REF_NAME: "v0.1.1", GITHUB_SHA: expected, RELEASE_VERSION: "0.1.1", VERIFY_RUN_ID: "123" }, stdout: "pipe", stderr: "pipe",
      });
      process.stdout.write(`TAG_REF_CASE ${mode} ${entry} exit=${result.exitCode}\n${result.stdout.toString()}${result.stderr.toString()}`);
      expect(result.exitCode).toBe(mode === "annotated" ? 0 : 1);
    }
    expect(git(origin, "rev-parse", "refs/tags/v0.1.1")).toBe(originalTag);
    expect(git(consumer, "rev-parse", "refs/tags/v0.1.1")).toBe(originalTag);
  }, 20000);
}
