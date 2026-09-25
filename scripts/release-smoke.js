import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const consumer = process.argv[2];
if (!consumer || !existsSync(join(consumer, "node_modules", "hoklims-devkit", "bin", "hoklims-devkit.js"))) {
  throw new Error("Pass a fresh consumer prefix containing the installed hoklims-devkit package");
}

const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-release-smoke-"));
const repository = join(root, "repository");
const home = join(root, "home");
mkdirSync(repository);
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
};

function run(argv, cwd = consumer) {
  const result = Bun.spawnSync({ cmd: argv, cwd, env, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}\n${stdout}\n${stderr}`);
  return stdout;
}

run(["git", "init", "-b", "main", repository]);
run(["git", "-C", repository, "add", "."]);
run(["git", "-C", repository, "-c", "user.name=Devkit Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"]);

for (const host of ["codex", "claude"]) {
  for (const withTools of [[], ["--with", "assertledger,latent-compass"]]) {
    const output = run(["bunx", "--no-install", "hoklims-devkit", "setup", repository, "--host", host, ...withTools, "--dry-run", "--json"]);
    const report = JSON.parse(output);
    const expected = withTools.length ? ["semctx", "assertledger", "latent-compass"] : ["semctx"];
    if (report.ok !== true || report.projectRoot !== resolve(repository)
      || JSON.stringify(report.components.map((item) => item.name)) !== JSON.stringify(expected)
      || report.components.some((item) => item.state !== "planned")) {
      throw new Error(`Unexpected ${host} preflight: ${output}`);
    }
    if (run(["git", "-C", repository, "status", "--porcelain"]).trim()) {
      throw new Error(`${host} dry-run modified the Git fixture`);
    }
    process.stdout.write(`PASS ${host} ${expected.join("+")} dry-run\n`);
  }
}

if (readFileSync(join(repository, "index.ts"), "utf8") !== "export const answer = 42;\n") {
  throw new Error("Dry-run changed source bytes");
}
process.stdout.write(`PASS disposable fixture at ${root}\n`);
