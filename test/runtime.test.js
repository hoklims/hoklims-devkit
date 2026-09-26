import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";

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

test("runtime preserves a foreign temporary-file collision", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-collision-")));
  const statePath = join(root, "repository.json");
  const foreignTemp = `${statePath}.foreign.tmp`;
  writeFileSync(foreignTemp, "foreign\n");
  const rt = createRuntime({ randomId: () => "foreign" });
  expect(() => rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })).toThrow();
  expect(readFileSync(foreignTemp, "utf8")).toBe("foreign\n");
  expect(existsSync(statePath)).toBe(false);
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
  expect(() => rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })).toThrow(/ownership changed/u);
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
  expect(() => rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} })).toThrow(/ownership changed/u);
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
  expect(() => rt.acquireLock(statePath)).toThrow(/ownership changed/u);
  expect(readFileSync(lockPath, "utf8")).toBe("foreign lock\n");
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
