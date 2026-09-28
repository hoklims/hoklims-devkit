import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffSnapshots, runtimeCachePaths, snapshotTree, validateNativeReport } from "../scripts/native-no-lc-contract.mjs";
import { resolveBundledNpmCli } from "../scripts/native-runtime-paths.mjs";
import { buildNativeConfig } from "../scripts/native-no-lc-config.mjs";

function touch(path, bytes = "fixture\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

test("bundled npm resolution ignores a custom global prefix on Windows and Unix layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-bundled-npm-"));
  const windowsNode = touch(join(root, "windows", "node.exe"));
  const windowsNpm = touch(join(root, "windows", "node_modules", "npm", "bin", "npm-cli.js"));
  touch(join(root, "custom-prefix", "node_modules", "npm", "bin", "npm-cli.js"), "foreign\n");
  expect(resolveBundledNpmCli(windowsNode, "win32")).toBe(realpathSync(windowsNpm));

  const unixNode = touch(join(root, "unix", "bin", "node"));
  const unixNpm = touch(join(root, "unix", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  expect(resolveBundledNpmCli(unixNode, "linux")).toBe(realpathSync(unixNpm));
  expect(() => resolveBundledNpmCli(join(root, "missing", "node"), "linux")).toThrow(/Bundled npm CLI/u);
});

test("native helper CLIs execute under the pinned Node 22.15 runtime", () => {
  const windowsNode = "C:\\Users\\Hokli\\Documents\\Codex\\2026-09-25\\aujourd-hui-j-ai-un-probl-2\\work\\node-v22.15.0-win-x64\\node.exe";
  const node = process.platform === "win32" && existsSync(windowsNode) ? windowsNode : Bun.which("node");
  expect(node).toBeTruthy();
  expect(Bun.spawnSync({ cmd: [node, "--version"] }).stdout.toString().trim()).toMatch(/^v22\.15\./u);
  const runtimeCli = fileURLToPath(new URL("../scripts/native-runtime-paths.mjs", import.meta.url));
  const configCli = fileURLToPath(new URL("../scripts/native-no-lc-config.mjs", import.meta.url));
  for (const modulePath of [runtimeCli, configCli]) {
    const imported = Bun.spawnSync({
      cmd: [node, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(modulePath).href)})`],
      stdout: "pipe", stderr: "pipe",
    });
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    expect(imported.stdout.toString()).toBe("");
  }
  const resolved = Bun.spawnSync({ cmd: [node, runtimeCli], stdout: "pipe", stderr: "pipe" });
  expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
  expect(resolved.stdout.toString().trim()).toMatch(/npm-cli\.js$/u);

  const root = mkdtempSync(join(tmpdir(), "devkit-config-cli-"));
  const output = join(root, "config.json");
  const env = {
    ...process.env,
    DEVKIT_SHA256: "a".repeat(64),
    DEVKIT_SOURCE_SHA: "b".repeat(40),
    DEVKIT_VERSION: "0.1.0",
  };
  const generated = Bun.spawnSync({
    cmd: [node, configCli, output, join(root, "run"), root, join(root, "artifact.tgz"), "c".repeat(40), resolved.stdout.toString().trim()],
    env, stdout: "pipe", stderr: "pipe",
  });
  expect(generated.exitCode, generated.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
    artifact: { version: "0.1.0" }, expected: { semctx: "0.3.7" },
  });
  const malformed = Bun.spawnSync({ cmd: [node, configCli], env, stdout: "pipe", stderr: "pipe" });
  expect(malformed.exitCode).not.toBe(0);
  expect(malformed.stderr.toString()).toContain("Usage: node native-no-lc-config.mjs");
});

test("native report contract rejects missing, false, duplicate, and foreign evidence", () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "devkit-native-report-")));
  const component = {
    name: "semctx", version: "0.3.7", state: "configured",
    installed: "yes", configured: "yes", loaded: "unknown", approved: "unknown", observed: "unknown",
  };
  const report = {
    schemaVersion: 1, command: "setup", ok: true, projectRoot, hosts: ["codex"], conflicts: [],
    components: [component],
  };
  const options = {
    projectRoot, command: "setup", hosts: ["codex"], names: ["semctx"],
    versions: { semctx: "0.3.7" }, dryRun: false,
  };
  expect(validateNativeReport(structuredClone(report), options)).toEqual(report);
  const mutants = [
    (value) => { delete value.components[0].installed; },
    (value) => { value.components[0].installed = "no"; },
    (value) => { value.components[0].configured = "no"; },
    (value) => { delete value.components[0].state; },
    (value) => { value.hosts = ["claude"]; },
    (value) => { value.components.push({ ...value.components[0] }); },
    (value) => { value.conflicts = [{ code: "APPLY_FAILED" }]; },
  ];
  for (const mutate of mutants) {
    const candidate = structuredClone(report);
    mutate(candidate);
    expect(() => validateNativeReport(candidate, options)).toThrow(/invalid complete component report/u);
  }
});

test("native snapshots detect permission-only mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-native-mode-"));
  const file = touch(join(root, "tool"));
  const recorded = snapshotTree(root);
  expect(recorded.find((item) => item.path === "tool")).toHaveProperty("mode");
  const synthetic = structuredClone(recorded);
  synthetic.find((item) => item.path === "tool").mode ^= 0o111;
  expect(diffSnapshots({ source: recorded }, { source: synthetic })).not.toEqual([]);
  if (process.platform === "win32") return;
  chmodSync(root, 0o755);
  const rootBefore = { source: snapshotTree(root) };
  chmodSync(root, 0o700);
  expect(diffSnapshots(rootBefore, { source: snapshotTree(root) })).not.toEqual([]);
  chmodSync(file, 0o644);
  const before = { source: snapshotTree(root) };
  chmodSync(file, 0o755);
  expect(diffSnapshots(before, { source: snapshotTree(root) })).not.toEqual([]);
});

test("native snapshots distinguish absent empty and linked roots", () => {
  const parent = mkdtempSync(join(tmpdir(), "devkit-native-root-"));
  const absent = snapshotTree(join(parent, "absent"));
  const emptyRoot = join(parent, "empty");
  mkdirSync(emptyRoot);
  const empty = snapshotTree(emptyRoot);
  expect(absent).toEqual([{ path: ".", kind: "absent" }]);
  expect(empty[0]).toMatchObject({ path: ".", kind: "directory" });
  expect(empty[0]).toHaveProperty("device");
  expect(empty[0]).toHaveProperty("inode");
  if (process.platform !== "win32") {
    const link = join(parent, "linked");
    symlinkSync(emptyRoot, link, "dir");
    expect(snapshotTree(link)).toEqual([expect.objectContaining({
      path: ".", kind: "symlink", target: emptyRoot,
    })]);
  }
});

test("native snapshots inspect root presence and never follow a root symlink", () => {
  const calls = [];
  const io = {
    lstatSync(path, options) {
      calls.push(["lstat", path, options]);
      if (path.endsWith("absent")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (path.endsWith("link")) return {
        mode: 0o120777n, dev: 7n, ino: 11n,
        isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false,
      };
      return {
        mode: 0o040755n, dev: 7n, ino: 10n,
        isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
      };
    },
    readlinkSync(path) { calls.push(["readlink", path]); return "target"; },
    readdirSync(path) { calls.push(["readdir", path]); return []; },
    readFileSync() { throw new Error("unexpected read"); },
  };
  expect(snapshotTree("/fixture/absent", io)).toEqual([{ path: ".", kind: "absent" }]);
  expect(snapshotTree("/fixture/empty", io)).toEqual([{
    path: ".", kind: "directory", mode: 0o755, device: "7", inode: "10",
  }]);
  expect(snapshotTree("/fixture/link", io)).toEqual([{
    path: ".", kind: "symlink", mode: 0o777, target: "target", device: "7", inode: "11",
  }]);
  expect(calls.filter(([kind, path]) => kind === "readdir" && path.endsWith("link"))).toHaveLength(0);
});

test("native runtime cache paths stay outside the fully protected home", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-native-cache-"));
  const runtime = join(root, "runtime");
  const protectedHome = join(root, "profile", "home");
  const caches = runtimeCachePaths(runtime);
  expect(Object.keys(caches)).toContain("BUN_INSTALL_CACHE_DIR");
  for (const cache of Object.values(caches)) {
    expect(cache.startsWith(`${protectedHome}\\`) || cache.startsWith(`${protectedHome}/`)).toBe(false);
    expect(cache.startsWith(runtime)).toBe(true);
  }
});

test("real native startup accepts generated owned config and rejects wrong expected versions before network", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "devkit-native-startup-")));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "README.md"), "fixture\n");
  for (const args of [
    ["init", "--initial-branch=main"],
    ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
  ]) expect(Bun.spawnSync({ cmd: ["git", ...args], cwd: source }).exitCode).toBe(0);
  const sourceSha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: source }).stdout.toString().trim();
  const artifact = touch(join(root, "artifact", "hoklims-devkit-0.1.0.tgz"), "artifact\n");
  const npmCli = touch(join(root, "runtime", "npm-cli.js"));
  const harness = fileURLToPath(new URL("../scripts/native-no-lc-smoke.mjs", import.meta.url));
  const base = {
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    sourceCheckout: source,
    artifact: {
      path: artifact,
      sha256: createHash("sha256").update("artifact\n").digest("hex"),
      sourceSha,
      version: "0.1.0",
    },
    expected: {
      semctx: "0.3.7", semctxPublicationSha: "a".repeat(40), assertledger: "1.3.0",
      codex: "0.147.0", claude: "2.1.229",
    },
    runtime: { npmCliJs: npmCli, bunExecutable: process.execPath, gitExecutable: "git" },
    allowAssertLedgerUnsafeDemo: true,
    startupProbeOnly: true,
  };
  const execute = (name, expected = base.expected) => {
    const config = join(root, `${name}.json`);
    const runRoot = join(root, name);
    const generated = buildNativeConfig({
      runRoot,
      sourceCheckout: source,
      artifactPath: artifact,
      artifactSha256: base.artifact.sha256,
      sourceSha,
      version: "0.1.0",
      semctxPublicationSha: base.expected.semctxPublicationSha,
      npmCliJs: npmCli,
      startupProbeOnly: true,
    });
    writeFileSync(config, `${JSON.stringify({ ...generated, expected })}\n`);
    return Bun.spawnSync({ cmd: [process.execPath, harness, config], cwd: root, stdout: "pipe", stderr: "pipe" });
  };
  const accepted = execute("accepted");
  expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);
  const refused = execute("refused", { ...base.expected, semctx: "0.3.8" });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain("Expected Semctx version gate");
});
