import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";

function danglingStateFixture() {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-state-link-"));
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

test("runtime rejects a dangling state symlink while reading", () => {
  const fixture = danglingStateFixture();
  if (!fixture) return;
  const rt = createRuntime();
  expect(() => rt.readState(fixture.statePath)).toThrow(/Unsafe state path/u);
  expect(lstatSync(fixture.statePath).isSymbolicLink()).toBe(true);
  expect(existsSync(fixture.outsideTarget)).toBe(false);
});

test("runtime preserves a dangling state symlink and its target while writing", () => {
  const fixture = danglingStateFixture();
  if (!fixture) return;
  const rt = createRuntime();
  const state = { schemaVersion: 1, projectRoot: "/repo", components: {} };
  expect(() => rt.writeState(fixture.statePath, state)).toThrow(/Unsafe state path/u);
  expect(lstatSync(fixture.statePath).isSymbolicLink()).toBe(true);
  expect(existsSync(fixture.outsideTarget)).toBe(false);
});
