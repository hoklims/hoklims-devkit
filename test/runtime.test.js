import { expect, test } from "bun:test";
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, validateState } from "../src/runtime.js";

function danglingStateFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-link-")));
  const managed = join(root, "managed-state");
  const statePath = join(managed, "repository.json");
  const outsideTarget = join(root, "outside-target.json");
  mkdirSync(managed);
  try {
    symlinkSync(outsideTarget, statePath, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return null;
    throw error;
  }
  return { statePath, outsideTarget };
}

function linkedDirectoryFixture({ dangling = false, profileAlias = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-parent-link-")));
  const outside = join(root, "outside");
  const profile = join(root, "profile");
  mkdirSync(profile);
  if (!dangling) mkdirSync(outside);
  if (profileAlias) {
    const alias = join(root, "profile-alias");
    try {
      symlinkSync(outside, alias, process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if (error?.code === "EPERM") return null;
      throw error;
    }
    return {
      link: alias,
      outside,
      statePath: join(alias, "hoklims-devkit", "repository.json"),
      outsideStatePath: join(outside, "hoklims-devkit", "repository.json"),
    };
  }
  const linkedPath = join(profile, "hoklims-devkit");
  try {
    symlinkSync(outside, linkedPath, process.platform === "win32" ? (dangling ? "dir" : "junction") : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return null;
    throw error;
  }
  return {
    link: linkedPath,
    outside,
    statePath: join(linkedPath, "repository.json"),
    outsideStatePath: join(outside, "repository.json"),
  };
}

test("runtime rejects a dangling state symlink while reading", () => {
  const fixture = danglingStateFixture();
  if (!fixture) return;
  const rt = createRuntime();
  expect(() => rt.readState(fixture.statePath)).toThrow(/Unsafe managed state path/u);
  expect(lstatSync(fixture.statePath).isSymbolicLink()).toBe(true);
  expect(existsSync(fixture.outsideTarget)).toBe(false);
});

test("runtime binds state and lock reads to the inspected regular file", () => {
  for (const kind of ["state", "lock"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-${kind}-read-race-`)));
    const statePath = join(root, "repository.json");
    const readPath = kind === "state" ? statePath : `${statePath}.lock`;
    const outside = join(root, `outside-${kind}.json`);
    const state = { schemaVersion: 1, projectRoot: "/repo", components: {} };
    const lock = { token: "00000000-0000-4000-8000-000000000000", pid: 42 };
    writeFileSync(readPath, JSON.stringify(kind === "state" ? state : lock));
    writeFileSync(outside, JSON.stringify(kind === "state" ? state : lock));
    const probe = join(root, `probe-${kind}`);
    try {
      symlinkSync(outside, probe, process.platform === "win32" ? "file" : undefined);
      unlinkSync(probe);
    } catch (error) {
      if (error?.code === "EPERM") continue;
      throw error;
    }
    let replaced = false;
    const rt = createRuntime({
      beforeManagedReadOpen: (path) => {
        if (replaced || path !== readPath) return;
        replaced = true;
        unlinkSync(readPath);
        symlinkSync(outside, readPath, process.platform === "win32" ? "file" : undefined);
      },
    });
    let error;
    try {
      if (kind === "state") rt.readState(statePath);
      else rt.acquireLock(statePath);
    } catch (caught) { error = caught; }
    expect(replaced).toBe(true);
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(lstatSync(readPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual(kind === "state" ? state : lock);
  }
});

test("runtime classifies removal after inspection as ownership drift", () => {
  for (const kind of ["state", "lock", "destination"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-${kind}-removed-open-`)));
    const statePath = join(root, "repository.json");
    const openedPath = kind === "lock" ? `${statePath}.lock` : statePath;
    const content = kind === "lock"
      ? JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid: 42 })
      : JSON.stringify({ schemaVersion: 1, projectRoot: "/repo", components: {} });
    writeFileSync(openedPath, content);
    let removalExecuted = false;
    const rt = createRuntime({
      beforeManagedReadOpen: (path) => {
        if (path !== openedPath || removalExecuted) return;
        removalExecuted = true;
        unlinkSync(path);
      },
    });
    let error;
    try {
      if (kind === "state") rt.readState(statePath);
      else if (kind === "lock") rt.acquireLock(statePath);
      else rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
    } catch (caught) { error = caught; }
    expect(removalExecuted).toBe(true);
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(existsSync(openedPath)).toBe(false);
    expect(readdirSync(root)).toHaveLength(0);
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-open-io-")));
  const statePath = join(root, "repository.json");
  writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, projectRoot: "/repo", components: {} }));
  const denied = Object.assign(new Error("read denied"), { code: "EACCES" });
  let ioError;
  try { createRuntime({ openReadDescriptor: () => { throw denied; } }).readState(statePath); } catch (caught) { ioError = caught; }
  expect(ioError).toBe(denied);
  expect(readFileSync(statePath, "utf8")).toContain("schemaVersion");
});

test("runtime revalidates every pathname after descriptor reads", () => {
  for (const kind of ["state", "lock", "project"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-${kind}-post-read-`)));
    const statePath = join(root, "repository.json");
    const readPath = kind === "lock" ? `${statePath}.lock`
      : kind === "project" ? join(root, "package.json") : statePath;
    const original = kind === "lock"
      ? JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid: 42 })
      : kind === "state" ? JSON.stringify({ schemaVersion: 1, projectRoot: "/repo", components: {} })
        : JSON.stringify({ name: "fixture" });
    const foreign = `foreign-${kind}-replacement\n`;
    writeFileSync(readPath, original);
    let replaced = false;
    const rt = createRuntime({
      readFileData: (descriptor, encoding, path) => {
        const content = readFileSync(descriptor, encoding);
        if (!replaced && path === readPath) {
          replaced = true;
          unlinkSync(readPath);
          writeFileSync(readPath, foreign);
        }
        return content;
      },
    });
    let error;
    try {
      if (kind === "state") rt.readState(statePath);
      else if (kind === "lock") rt.acquireLock(statePath);
      else rt.readPlainText(readPath);
    } catch (caught) { error = caught; }
    expect(replaced).toBe(true);
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(readFileSync(readPath, "utf8")).toBe(foreign);
  }
});

test("runtime refuses a substituted POSIX FIFO without blocking", async () => {
  if (process.platform === "win32") return;
  const runtimeUrl = new URL("../src/runtime.js", import.meta.url).href;
  const script = `
    import { lstatSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
    import { spawnSync } from "node:child_process";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createRuntime } from ${JSON.stringify(runtimeUrl)};
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-fifo-read-")));
    const statePath = join(root, "repository.json");
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, projectRoot: "/repo", components: {} }));
    let replacementExecuted = false;
    let mkfifoStatus = null;
    const rt = createRuntime({ beforeManagedReadOpen: (path) => {
      replacementExecuted = true;
      unlinkSync(path);
      const made = spawnSync("mkfifo", [path], { encoding: "utf8" });
      mkfifoStatus = made.status;
      if (made.status !== 0) throw new Error(made.stderr || String(made.error));
    } });
    let error;
    try { rt.readState(statePath); } catch (caught) { error = caught; }
    const probe = spawnSync("test", ["-p", statePath], { encoding: "utf8" });
    const stat = lstatSync(statePath);
    process.stdout.write(JSON.stringify({
      code: error?.code ?? null,
      fifo: probe.status === 0,
      probeStatus: probe.status,
      probeStderr: probe.stderr,
      replacementExecuted,
      mkfifoStatus,
      mode: stat.mode,
      isFile: stat.isFile(),
    }));
    rmSync(root, { recursive: true, force: true });
  `;
  const child = Bun.spawn({ cmd: [process.execPath, "--eval", script], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 2_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timer);
  expect(timedOut).toBe(false);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout);
  expect(result.code).toBe("STATE_CONFLICT");
  expect(result.fifo).toBe(true);
  expect(result.probeStatus).toBe(0);
  expect(result.probeStderr).toBe("");
  expect(result.replacementExecuted).toBe(true);
  expect(result.mkfifoStatus).toBe(0);
  expect(result.isFile).toBe(false);
});

test("runtime refuses a present POSIX FIFO project manifest without blocking", async () => {
  if (process.platform === "win32") return;
  const runtimeUrl = new URL("../src/runtime.js", import.meta.url).href;
  const script = `
    import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
    import { spawnSync } from "node:child_process";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createRuntime } from ${JSON.stringify(runtimeUrl)};
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-package-fifo-")));
    const manifestPath = join(root, "package.json");
    const made = spawnSync("mkfifo", [manifestPath], { encoding: "utf8" });
    let error;
    try { createRuntime().readPlainText(manifestPath); } catch (caught) { error = caught; }
    process.stdout.write(JSON.stringify({
      code: error?.code ?? null,
      fifo: lstatSync(manifestPath).isFIFO(),
      mkfifoStatus: made.status,
    }));
    rmSync(root, { recursive: true, force: true });
  `;
  const child = Bun.spawn({ cmd: [process.execPath, "--eval", script], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 2_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timer);
  expect(timedOut).toBe(false);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ code: "STATE_CONFLICT", fifo: true, mkfifoStatus: 0 });
});

test("runtime project-file inspection rejects linked and non-file entries", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-project-files-")));
  const regular = join(root, "package.json");
  const directory = join(root, "directory-lock");
  const target = join(root, "target-lock");
  const linked = join(root, "linked-lock");
  const dangling = join(root, "dangling-lock");
  writeFileSync(regular, "{}\n");
  mkdirSync(directory);
  writeFileSync(target, "lock\n");
  try {
    symlinkSync(target, linked, process.platform === "win32" ? "file" : undefined);
    symlinkSync(join(root, "missing-target"), dangling, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  const rt = createRuntime();
  expect(rt.plainFilePresent(regular)).toBe(true);
  expect(rt.plainFilePresent(join(root, "missing"))).toBe(false);
  for (const unsafe of [directory, linked, dangling]) {
    let error;
    try { rt.plainFilePresent(unsafe); } catch (caught) { error = caught; }
    expect(error?.code).toBe("STATE_CONFLICT");
  }
  expect(rt.readPlainText(regular)).toBe("{}\n");
});

test("runtime distinguishes absent, linked, and unsafe package directories", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-package-directory-")));
  const nodeModules = join(root, "node_modules");
  const packagePath = join(nodeModules, "assertledger");
  const storePackage = join(root, ".pnpm", "assertledger");
  mkdirSync(nodeModules);
  const rt = createRuntime();
  expect(rt.directoryPresent(packagePath)).toBe(false);
  mkdirSync(storePackage, { recursive: true });
  writeFileSync(join(storePackage, "package.json"), "{\"version\":\"1.2.0\"}\n");
  try {
    symlinkSync(storePackage, packagePath, process.platform === "win32" ? "junction" : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  expect(rt.directoryPresent(packagePath)).toBe(true);
  expect(rt.readPlainText(join(packagePath, "package.json"))).toBe("{\"version\":\"1.2.0\"}\n");
  unlinkSync(packagePath);
  symlinkSync(join(root, "missing-store"), packagePath, process.platform === "win32" ? "junction" : undefined);
  let dangling;
  try { rt.directoryPresent(packagePath); } catch (error) { dangling = error; }
  expect(dangling?.code).toBe("STATE_CONFLICT");
});

test("runtime preserves a dangling state symlink and its target while writing", () => {
  const fixture = danglingStateFixture();
  if (!fixture) return;
  const rt = createRuntime();
  const state = { schemaVersion: 1, projectRoot: "/repo", components: {} };
  expect(() => rt.writeState(fixture.statePath, state)).toThrow(/Unsafe managed state path/u);
  expect(lstatSync(fixture.statePath).isSymbolicLink()).toBe(true);
  expect(existsSync(fixture.outsideTarget)).toBe(false);
});

test("runtime refuses a linked state directory before every managed-state operation", () => {
  for (const operation of ["read", "write", "lock"]) {
    const fixture = linkedDirectoryFixture();
    if (!fixture) continue;
    const rt = createRuntime();
    const action = operation === "read" ? () => rt.readState(fixture.statePath)
      : operation === "write" ? () => rt.writeState(fixture.statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })
        : () => rt.acquireLock(fixture.statePath);
    expect(action).toThrow(/Unsafe managed state path/u);
    expect(lstatSync(fixture.link).isSymbolicLink()).toBe(true);
    expect(existsSync(fixture.outsideStatePath)).toBe(false);
    expect(existsSync(`${fixture.outsideStatePath}.lock`)).toBe(false);
    expect(readdirSync(fixture.outside)).toHaveLength(0);
  }
});

test("runtime refuses dangling state-directory links and linked profile roots", () => {
  for (const settings of [{ dangling: true }, { profileAlias: true }]) {
    const fixture = linkedDirectoryFixture(settings);
    if (!fixture) continue;
    const rt = createRuntime();
    expect(() => rt.readState(fixture.statePath)).toThrow(/Unsafe managed state path/u);
    expect(() => rt.writeState(fixture.statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })).toThrow(/Unsafe managed state path/u);
    expect(() => rt.acquireLock(fixture.statePath)).toThrow(/Unsafe managed state path/u);
    expect(lstatSync(fixture.link).isSymbolicLink()).toBe(true);
    expect(existsSync(fixture.outsideStatePath)).toBe(false);
  }
});

test("runtime classifies a regular ancestor raced during parent creation as a conflict", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-parent-race-")));
  const foreignAncestor = join(root, "profile");
  const statePath = join(foreignAncestor, "hoklims-devkit", "repository.json");
  const foreign = "FOREIGN-PARENT\n";
  let replacementExecuted = false;
  const rt = createRuntime({
    createManagedParent: (path, options) => {
      replacementExecuted = true;
      writeFileSync(foreignAncestor, foreign);
      return mkdirSync(path, options);
    },
  });
  let error;
  try {
    rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
  } catch (caught) { error = caught; }
  expect(replacementExecuted).toBe(true);
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(readFileSync(foreignAncestor, "utf8")).toBe(foreign);
  expect(existsSync(statePath)).toBe(false);

  const io = Object.assign(new Error("parent creation denied"), { code: "EACCES" });
  const denied = createRuntime({ createManagedParent: () => { throw io; } });
  let deniedError;
  try {
    denied.writeState(join(root, "genuine-io", "repository.json"), {
      schemaVersion: 1, projectRoot: "/repo", components: {},
    });
  } catch (caught) { deniedError = caught; }
  expect(deniedError).toBe(io);
  expect(deniedError?.code).toBe("EACCES");
});

test("runtime rechecks parents after every exclusive owned-file open failure", () => {
  for (const kind of ["temporary", "lock"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-${kind}-exclusive-parent-`)));
    const parent = join(root, "profile");
    const statePath = join(parent, "repository.json");
    const outside = join(root, "outside.txt");
    const foreign = `FOREIGN-${kind.toUpperCase()}-PARENT\n`;
    mkdirSync(parent);
    writeFileSync(outside, "OUTSIDE-UNCHANGED\n");
    let hookExecuted = false;
    const replaceParent = () => {
      hookExecuted = true;
      rmdirSync(parent);
      writeFileSync(parent, foreign);
    };
    const rt = createRuntime(kind === "temporary"
      ? { randomId: () => { replaceParent(); return "candidate"; } }
      : { beforeLockOpen: replaceParent });
    let error;
    try {
      if (kind === "temporary") {
        rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
      } else rt.acquireLock(statePath);
    } catch (caught) { error = caught; }
    expect(hookExecuted).toBe(true);
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(readFileSync(parent, "utf8")).toBe(foreign);
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE-UNCHANGED\n");
    expect(readdirSync(root).sort()).toEqual(["outside.txt", "profile"]);
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-exclusive-open-io-")));
  const statePath = join(root, "repository.json");
  const denied = Object.assign(new Error("exclusive open denied"), { code: "EACCES" });
  let ioError;
  try {
    createRuntime({ createOwnedFile: () => { throw denied; } })
      .writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
  } catch (caught) { ioError = caught; }
  expect(ioError).toBe(denied);
  expect(existsSync(statePath)).toBe(false);
});

test("runtime validates owned files before writing through a raced parent link", () => {
  for (const kind of ["temporary", "lock"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-${kind}-owned-link-`)));
    const parent = join(root, "profile");
    const outside = join(root, "outside");
    const statePath = join(parent, "repository.json");
    const ownedName = kind === "temporary" ? "repository.json.candidate.tmp" : "repository.json.lock";
    mkdirSync(parent);
    mkdirSync(outside);
    writeFileSync(join(outside, "marker.txt"), "FOREIGN-MARKER\n");
    let hookExecuted = false;
    let markerWriteExecuted = false;
    const linkParent = () => {
      hookExecuted = true;
      rmdirSync(parent);
      symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
    };
    const rt = createRuntime(kind === "temporary" ? {
      randomId: () => { linkParent(); return "candidate"; },
      writeStateData: () => { markerWriteExecuted = true; },
    } : {
      beforeLockOpen: linkParent,
      writeLockData: () => { markerWriteExecuted = true; },
    });
    let error;
    try {
      if (kind === "temporary") rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
      else rt.acquireLock(statePath);
    } catch (caught) { error = caught; }
    expect(hookExecuted).toBe(true);
    expect(markerWriteExecuted).toBe(false);
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "marker.txt"), "utf8")).toBe("FOREIGN-MARKER\n");
    expect(readFileSync(join(outside, ownedName))).toHaveLength(0);

    const controlRoot = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-${kind}-owned-control-`)));
    const controlState = join(controlRoot, "repository.json");
    let controlWriteExecuted = false;
    const control = createRuntime(kind === "temporary" ? {
      randomId: () => "candidate",
      writeStateData: (descriptor, data) => { controlWriteExecuted = true; writeFileSync(descriptor, data); },
    } : {
      writeLockData: (descriptor, data) => { controlWriteExecuted = true; writeFileSync(descriptor, data); },
    });
    if (kind === "temporary") control.writeState(controlState, { schemaVersion: 1, projectRoot: "/repo", components: {} });
    else control.acquireLock(controlState)();
    expect(controlWriteExecuted).toBe(true);
  }
});

test("runtime preserves a lock replaced by a third-party link during release", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-link-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const outsideTarget = join(root, "outside-lock-target.json");
  const release = createRuntime().acquireLock(statePath);
  unlinkSync(lockPath);
  try {
    symlinkSync(outsideTarget, lockPath, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  expect(release).toThrow(/ownership changed/u);
  expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
  expect(existsSync(outsideTarget)).toBe(false);
});

test("runtime removes an owned partial temporary state file after a write failure", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-partial-")));
  const statePath = join(root, "repository.json");
  const rt = createRuntime({
    randomId: () => "partial",
    writeStateData: (fd, data) => {
      writeFileSync(fd, data.slice(0, 8));
      throw Object.assign(new Error("disk quota exceeded"), { code: "ENOSPC" });
    },
  });
  expect(() => rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })).toThrow(/disk quota exceeded/u);
  expect(existsSync(`${statePath}.partial.tmp`)).toBe(false);
  expect(existsSync(statePath)).toBe(false);
});

test("runtime keeps the owned temporary descriptor open through commit and cleanup", () => {
  for (const outcome of ["commit", "cleanup"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-state-owned-${outcome}-`)));
    const statePath = join(root, "repository.json");
    let descriptor;
    let checkedOpen = false;
    const rt = createRuntime({
      randomId: () => "owned",
      writeStateData: (fd, data) => {
        descriptor = fd;
        writeFileSync(fd, data);
        if (outcome === "cleanup") throw Object.assign(new Error("forced cleanup"), { code: "ENOSPC" });
      },
      commitOwnedFile: (from, to) => {
        checkedOpen = fstatSync(descriptor).isFile();
        renameSync(from, to);
      },
      removeOwnedFile: (path) => {
        checkedOpen = fstatSync(descriptor).isFile();
        unlinkSync(path);
      },
    });
    let error;
    try { rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} }); } catch (caught) { error = caught; }
    expect(checkedOpen).toBe(true);
    expect(() => fstatSync(descriptor)).toThrow();
    if (outcome === "commit") {
      expect(error).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, "utf8")).projectRoot).toBe("/repo");
    } else {
      expect(error?.message).toMatch(/forced cleanup/u);
      expect(existsSync(statePath)).toBe(false);
    }
  }
});

test("runtime preserves a state destination replaced during temporary write", () => {
  for (const scenario of ["appeared", "recreated", "distinct-replacement"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-destination-")));
    const statePath = join(root, "repository.json");
    const tempPath = `${statePath}.candidate.tmp`;
    const foreignPath = join(root, "foreign-replacement.json");
    if (scenario !== "appeared") writeFileSync(statePath, "original state\n");
    if (scenario === "distinct-replacement") writeFileSync(foreignPath, "foreign replacement\n");
    const rt = createRuntime({
      randomId: () => "candidate",
      writeStateData: (fd, data) => {
        writeFileSync(fd, data);
        if (existsSync(statePath)) unlinkSync(statePath);
        if (scenario === "distinct-replacement") renameSync(foreignPath, statePath);
        else writeFileSync(statePath, "foreign replacement\n");
      },
    });
    let error;
    try { rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} }); } catch (caught) { error = caught; }
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(readFileSync(statePath, "utf8")).toBe("foreign replacement\n");
    expect(existsSync(tempPath)).toBe(false);
  }
});

test("runtime revalidates Windows destination bytes after publication fails", () => {
  for (const scenario of ["unchanged", "same-inode-changed-bytes", "different-inode-same-bytes", "replacement-decoding-equivalent"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-windows-publish-")));
    const statePath = join(root, "repository.json");
    const foreignPath = join(root, "foreign.json");
    const projectRoot = scenario === "replacement-decoding-equivalent" ? "/repo\uFFFD" : "/repo";
    const original = `${JSON.stringify({ schemaVersion: 1, projectRoot, components: {} }, null, 2)}\n`;
    const originalBytes = Buffer.from(original, "utf8");
    const replacement = Buffer.from("\uFFFD", "utf8");
    const replacementIndex = originalBytes.indexOf(replacement);
    const invalidBytes = scenario === "replacement-decoding-equivalent"
      ? Buffer.concat([originalBytes.subarray(0, replacementIndex), Buffer.from([0xff]), originalBytes.subarray(replacementIndex + replacement.length)])
      : null;
    writeFileSync(statePath, original);
    if (scenario === "different-inode-same-bytes") writeFileSync(foreignPath, original);
    let platformObserved = false;
    const rt = createRuntime({
      currentPlatform: () => { platformObserved = true; return "win32"; },
      randomId: () => "candidate",
      commitOwnedFile: () => { throw Object.assign(new Error("Windows rename failed"), { code: "EIO" }); },
      removeOwnedFile: (path) => {
        if (scenario === "same-inode-changed-bytes") writeFileSync(statePath, "FOREIGN STATE\n");
        if (scenario === "replacement-decoding-equivalent") writeFileSync(statePath, invalidBytes);
        if (scenario === "different-inode-same-bytes") {
          unlinkSync(statePath);
          renameSync(foreignPath, statePath);
        }
        unlinkSync(path);
      },
    });
    const transaction = rt.openStateTransaction(statePath);
    let writeError;
    try {
      transaction.write({ schemaVersion: 1, projectRoot, components: { semctx: { version: "0.3.4", hosts: ["codex"] } } });
    } catch (error) {
      writeError = error;
    }
    expect(platformObserved).toBe(true);
    expect(writeError?.code).toBe("EIO");
    if (scenario !== "unchanged") {
      expect(() => transaction.close()).toThrow(/validated|state bytes changed/u);
      if (scenario === "replacement-decoding-equivalent") expect(readFileSync(statePath).equals(invalidBytes)).toBe(true);
      else expect(readFileSync(statePath, "utf8")).toBe(scenario === "same-inode-changed-bytes" ? "FOREIGN STATE\n" : original);
    } else {
      expect(() => transaction.close()).not.toThrow();
      expect(readFileSync(statePath, "utf8")).toBe(original);
    }
  }
});

test("runtime rejects invalid UTF-8 state bytes without overwriting them", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-invalid-utf8-")));
  const statePath = join(root, "repository.json");
  const bytes = Buffer.from('{"schemaVersion":1,"projectRoot":"/repo\uFFFD","components":{}}\n', "utf8");
  const marker = Buffer.from("\uFFFD", "utf8");
  const index = bytes.indexOf(marker);
  const invalid = Buffer.concat([bytes.subarray(0, index), Buffer.from([0xff]), bytes.subarray(index + marker.length)]);
  writeFileSync(statePath, invalid);
  let error;
  try { createRuntime().openStateTransaction(statePath); } catch (caught) { error = caught; }
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(readFileSync(statePath).equals(invalid)).toBe(true);
});

test("runtime preserves and classifies every foreign temporary-file collision", () => {
  for (const kind of ["file", "directory", "symlink"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `hoklims-devkit-state-${kind}-collision-`)));
    const statePath = join(root, "repository.json");
    const foreignTemp = `${statePath}.foreign.tmp`;
    if (kind === "file") writeFileSync(foreignTemp, "foreign\n");
    else if (kind === "directory") mkdirSync(foreignTemp);
    else {
      try {
        symlinkSync(join(root, "foreign-target"), foreignTemp, process.platform === "win32" ? "file" : undefined);
      } catch (error) {
        if (error?.code === "EPERM") continue;
        throw error;
      }
    }
    let error;
    try {
      createRuntime({ randomId: () => "foreign" })
        .writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
    } catch (caught) { error = caught; }
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(lstatSync(foreignTemp)[kind === "file" ? "isFile" : kind === "directory" ? "isDirectory" : "isSymbolicLink"]()).toBe(true);
    if (kind === "file") expect(readFileSync(foreignTemp, "utf8")).toBe("foreign\n");
    expect(existsSync(statePath)).toBe(false);
  }
});

test("runtime preserves a replacement temporary file when the writer fails", () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-replaced-failure-")));
  const statePath = join(root, "repository.json");
  const tempPath = `${statePath}.replaced.tmp`;
  const rt = createRuntime({
    randomId: () => "replaced",
    writeStateData: () => {
      unlinkSync(tempPath);
      writeFileSync(tempPath, "foreign replacement\n");
      throw Object.assign(new Error("disk write failed"), { code: "ENOSPC" });
    },
  });
  let error;
  try { rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} }); } catch (caught) { error = caught; }
  expect(error?.message).toMatch(/ownership changed/u);
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(readFileSync(tempPath, "utf8")).toBe("foreign replacement\n");
  expect(existsSync(statePath)).toBe(false);
});

test("runtime never commits a replacement temporary file after a successful callback", () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-replaced-success-")));
  const statePath = join(root, "repository.json");
  const tempPath = `${statePath}.replaced.tmp`;
  const rt = createRuntime({
    randomId: () => "replaced",
    writeStateData: () => {
      unlinkSync(tempPath);
      writeFileSync(tempPath, "foreign replacement\n");
    },
  });
  let error;
  try { rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} }); } catch (caught) { error = caught; }
  expect(error?.message).toMatch(/ownership changed/u);
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(readFileSync(tempPath, "utf8")).toBe("foreign replacement\n");
  expect(existsSync(statePath)).toBe(false);
});

test("runtime removes an owned partial lock after its write fails", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-partial-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const rt = createRuntime({
    writeLockData: (fd, data) => {
      writeFileSync(fd, data.slice(0, 5));
      throw Object.assign(new Error("lock write failed"), { code: "ENOSPC" });
    },
  });
  expect(() => rt.acquireLock(statePath)).toThrow(/lock write failed/u);
  expect(existsSync(lockPath)).toBe(false);
});

test("runtime keeps the owned lock descriptor open through release", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-owned-release-")));
  const statePath = join(root, "repository.json");
  let descriptor;
  let checkedOpen = false;
  const rt = createRuntime({
    writeLockData: (fd, data) => {
      descriptor = fd;
      writeFileSync(fd, data);
    },
    removeOwnedFile: (path) => {
      checkedOpen = fstatSync(descriptor).isFile();
      unlinkSync(path);
    },
  });
  const release = rt.acquireLock(statePath);
  expect(fstatSync(descriptor).isFile()).toBe(true);
  release();
  expect(checkedOpen).toBe(true);
  expect(() => fstatSync(descriptor)).toThrow();
  expect(existsSync(`${statePath}.lock`)).toBe(false);
});

test("runtime preserves a replacement lock after its writer returns", () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-replaced-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const rt = createRuntime({
    writeLockData: () => {
      unlinkSync(lockPath);
      writeFileSync(lockPath, "foreign lock\n");
    },
  });
  let error;
  try { rt.acquireLock(statePath); } catch (caught) { error = caught; }
  expect(error?.message).toMatch(/ownership changed/u);
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(readFileSync(lockPath, "utf8")).toBe("foreign lock\n");
});

test("runtime reclassifies an EEXIST directory race as a state conflict", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-directory-race-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const rt = createRuntime({ beforeLockOpen: () => mkdirSync(lockPath) });
  let error;
  try { rt.acquireLock(statePath); } catch (caught) { error = caught; }
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(lstatSync(lockPath).isDirectory()).toBe(true);
});

test("runtime reclassifies an EEXIST symlink race as a state conflict", () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-link-race-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const outsideTarget = join(root, "outside-lock.json");
  const rt = createRuntime({ beforeLockOpen: () => symlinkSync(outsideTarget, lockPath) });
  let error;
  try { rt.acquireLock(statePath); } catch (caught) { error = caught; }
  expect(error?.code).toBe("STATE_CONFLICT");
  expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
  expect(existsSync(outsideTarget)).toBe(false);
});

test("runtime propagates an owned lock unlink failure", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-lock-unlink-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const rt = createRuntime({
    removeOwnedFile: () => { throw Object.assign(new Error("lock unlink denied"), { code: "EACCES" }); },
  });
  const release = rt.acquireLock(statePath);
  expect(release).toThrow(/lock unlink denied/u);
  expect(existsSync(lockPath)).toBe(true);
});

test("runtime distinguishes malformed lock records from contention", () => {
  for (const content of [
    "not-json",
    JSON.stringify({ token: "", pid: 0 }),
    JSON.stringify({ token: "foreign" }),
    JSON.stringify({ token: "foreign", pid: 42 }),
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-malformed-lock-")));
    const statePath = join(root, "repository.json");
    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, content);
    let error;
    try { createRuntime().acquireLock(statePath); } catch (caught) { error = caught; }
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(readFileSync(lockPath, "utf8")).toBe(content);
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-valid-lock-")));
  const statePath = join(root, "repository.json");
  const lockPath = `${statePath}.lock`;
  const valid = JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid: 42 });
  writeFileSync(lockPath, valid);
  let contention;
  try { createRuntime().acquireLock(statePath); } catch (caught) { contention = caught; }
  expect(contention?.code).toBe("RUN_LOCKED");
  expect(readFileSync(lockPath, "utf8")).toBe(valid);
});

test("runtime verifies plain project files and preserves metadata, open, and read I/O errors", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-readable-file-")));
  const filePath = join(root, "cli.js");
  const directoryPath = join(root, "cli-directory");
  writeFileSync(filePath, "#!/usr/bin/env node\n");
  mkdirSync(directoryPath);
  const rt = createRuntime();
  expect(rt.readPlainText(filePath)).toBe("#!/usr/bin/env node\n");
  expect(() => rt.readPlainText(directoryPath)).toThrow(/not a regular file/u);
  expect(rt.readPlainText(join(root, "missing.js"))).toBeNull();

  for (const phase of ["metadata", "open", "read"]) {
    const io = Object.assign(new Error(`${phase} EIO`), { code: "EIO" });
    const failing = createRuntime({
      inspectPlainFile: phase === "metadata" ? () => { throw io; } : undefined,
      openReadDescriptor: phase === "open" ? () => { throw io; } : undefined,
      readFileData: phase === "read" ? () => { throw io; } : undefined,
    });
    let error;
    try { failing.readPlainText(filePath); } catch (caught) { error = caught; }
    expect(error?.code).toBe("EIO");
  }

  const targetPath = join(root, "linked-target.js");
  const linkPath = join(root, "linked-cli.js");
  try {
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  expect(rt.pathPresent(linkPath)).toBe(true);
  expect(() => rt.readPlainText(linkPath)).toThrow(/symbolic link/u);
  writeFileSync(targetPath, "#!/usr/bin/env node\n");
  expect(() => rt.readPlainText(linkPath)).toThrow(/symbolic link/u);
});

test("state validation accepts only canonical component and host order", () => {
  const canonical = {
    schemaVersion: 1,
    projectRoot: "/repo",
    components: {
      semctx: { version: "0.3.5", hosts: ["codex", "claude"] },
      assertledger: { version: "1.3.0", hosts: ["codex"] },
      "latent-compass": { version: "0.3.0", hosts: ["claude"] },
    },
    inProgress: {
      command: "upgrade",
      selected: ["semctx", "assertledger", "latent-compass"],
      hosts: ["codex", "claude"],
      versions: { semctx: "0.3.5", assertledger: "1.3.0", "latent-compass": "0.3.0" },
    },
  };
  expect(validateState(canonical)).toBe(canonical);
  expect(validateState(canonical).inProgress.versions).toEqual({
    semctx: "0.3.5", assertledger: "1.3.0", "latent-compass": "0.3.0",
  });

  const wrongComponents = structuredClone(canonical);
  wrongComponents.inProgress.selected = ["semctx", "latent-compass", "assertledger"];
  expect(() => validateState(wrongComponents)).toThrow(/Invalid in-progress installation plan/u);

  const wrongPlanHosts = structuredClone(canonical);
  wrongPlanHosts.inProgress.hosts = ["claude", "codex"];
  expect(() => validateState(wrongPlanHosts)).toThrow(/Invalid in-progress installation plan/u);

  const wrongComponentHosts = structuredClone(canonical);
  wrongComponentHosts.components.semctx.hosts = ["claude", "codex"];
  expect(() => validateState(wrongComponentHosts)).toThrow(/Invalid devkit state component/u);

  for (const version of ["01.2.3", "1.02.3", "1.2.03"]) {
    const wrongComponentVersion = structuredClone(canonical);
    wrongComponentVersion.components.semctx.version = version;
    expect(() => validateState(wrongComponentVersion)).toThrow(/Invalid devkit state component/u);

    const wrongPlanVersion = structuredClone(canonical);
    wrongPlanVersion.inProgress.versions.semctx = version;
    expect(() => validateState(wrongPlanVersion)).toThrow(/Invalid in-progress installation plan/u);
  }

  for (const selected of [["semctx", "assertledger", "assertledger"], ["semctx", "unknown"]]) {
    const invalid = structuredClone(canonical);
    invalid.inProgress.selected = selected;
    expect(() => validateState(invalid)).toThrow(/Invalid in-progress installation plan/u);
  }

  const narrowSetup = structuredClone(canonical);
  narrowSetup.inProgress.command = "setup";
  narrowSetup.inProgress.selected = ["semctx"];
  narrowSetup.inProgress.versions = { semctx: "0.3.5" };
  expect(validateState(narrowSetup)).toBe(narrowSetup);

  const setupVersionChange = structuredClone(narrowSetup);
  setupVersionChange.inProgress.versions.semctx = "0.3.6";
  expect(() => validateState(setupVersionChange)).toThrow(/Invalid in-progress installation plan/u);

  const explicitUpgradeSubset = structuredClone(canonical);
  explicitUpgradeSubset.inProgress.selected = ["semctx", "assertledger"];
  explicitUpgradeSubset.inProgress.versions = { semctx: "0.3.6", assertledger: "1.3.0" };
  expect(validateState(explicitUpgradeSubset)).toBe(explicitUpgradeSubset);

  const semctxOnlyUpgrade = structuredClone(canonical);
  semctxOnlyUpgrade.inProgress.selected = ["semctx"];
  semctxOnlyUpgrade.inProgress.versions = { semctx: "0.3.5" };
  expect(validateState(semctxOnlyUpgrade)).toBe(semctxOnlyUpgrade);

  const narrowedVersionChange = {
    schemaVersion: 1,
    projectRoot: "/repo",
    components: { semctx: { version: "0.3.4", hosts: ["codex", "claude"] } },
    inProgress: {
      command: "upgrade",
      selected: ["semctx"],
      hosts: ["codex"],
      versions: { semctx: "0.3.5" },
    },
  };
  expect(() => validateState(narrowedVersionChange)).toThrow(/Invalid in-progress installation plan/u);
});

test("runtime classifies a regular-file ancestor as a state conflict", () => {
  for (const operation of ["read", "write", "lock"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-file-ancestor-")));
    const ancestor = join(root, "not-a-directory");
    const statePath = join(ancestor, "child", "repository.json");
    writeFileSync(ancestor, "foreign ancestor\n");
    const rt = createRuntime();
    const action = operation === "read" ? () => rt.readState(statePath)
      : operation === "write" ? () => rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })
        : () => rt.acquireLock(statePath);
    let error;
    try { action(); } catch (caught) { error = caught; }
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(error?.message).toMatch(/is not a directory/u);
    expect(readFileSync(ancestor, "utf8")).toBe("foreign ancestor\n");
  }
});
