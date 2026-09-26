import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("runtime preserves a state destination replaced during temporary write", () => {
  for (const initiallyPresent of [false, true]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-state-destination-")));
    const statePath = join(root, "repository.json");
    const tempPath = `${statePath}.candidate.tmp`;
    if (initiallyPresent) writeFileSync(statePath, "original state\n");
    const rt = createRuntime({
      randomId: () => "candidate",
      writeStateData: (fd, data) => {
        writeFileSync(fd, data);
        if (existsSync(statePath)) unlinkSync(statePath);
        writeFileSync(statePath, "foreign replacement\n");
      },
    });
    let error;
    try { rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} }); } catch (caught) { error = caught; }
    expect(error?.code).toBe("STATE_CONFLICT");
    expect(readFileSync(statePath, "utf8")).toBe("foreign replacement\n");
    expect(existsSync(tempPath)).toBe(false);
  }
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

test("runtime distinguishes readable regular files from directories", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hoklims-devkit-readable-file-")));
  const filePath = join(root, "cli.js");
  const directoryPath = join(root, "cli-directory");
  writeFileSync(filePath, "#!/usr/bin/env node\n");
  mkdirSync(directoryPath);
  const rt = createRuntime();
  expect(rt.isReadableFile(filePath)).toBe(true);
  expect(rt.isReadableFile(directoryPath)).toBe(false);
  expect(rt.isReadableFile(join(root, "missing.js"))).toBe(false);

  const targetPath = join(root, "linked-target.js");
  const linkPath = join(root, "linked-cli.js");
  try {
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  expect(rt.pathPresent(linkPath)).toBe(true);
  expect(rt.isReadableFile(linkPath)).toBe(false);
  writeFileSync(targetPath, "#!/usr/bin/env node\n");
  expect(rt.isReadableFile(linkPath)).toBe(true);
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
