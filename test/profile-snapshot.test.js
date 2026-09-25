import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSnapshotUnchanged, protectedProfilePaths, snapshot } from "../scripts/profile-snapshot.js";

test("release smoke rejects a host mutation despite a valid planned report", () => {
  const home = mkdtempSync(join(tmpdir(), "hoklims-devkit-smoke-oracle-"));
  const codex = join(home, ".codex");
  mkdirSync(codex);
  const hooks = join(codex, "hooks.json");
  writeFileSync(hooks, '{"hooks":{}}\n');
  const protectedPaths = [codex, join(home, "state")];
  const before = protectedPaths.map(snapshot);
  const hookBefore = [snapshot(hooks)];
  const plannedReport = { ok: true, components: [{ name: "semctx", state: "planned" }] };
  expect(plannedReport.ok).toBe(true);
  assertSnapshotUnchanged(protectedPaths, before, "codex");
  writeFileSync(hooks, '{"hooks":{"SessionStart":[]}}\n');
  expect(() => assertSnapshotUnchanged(protectedPaths, before, "codex")).toThrow(/modified the host profile/u);
  expect(() => assertSnapshotUnchanged([hooks], hookBefore, "codex")).toThrow(/modified the host profile/u);
  writeFileSync(hooks, '{"hooks":{}}\n');
  mkdirSync(protectedPaths[1]);
  writeFileSync(join(protectedPaths[1], "repo.json"), '{}\n');
  expect(() => assertSnapshotUnchanged(protectedPaths, before, "codex")).toThrow(/modified the host profile/u);
});

test("release smoke detects ignored and Git metadata writes", () => {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-repository-oracle-"));
  const repository = join(root, "repository");
  const git = join(repository, ".git");
  mkdirSync(git, { recursive: true });
  const config = join(git, "config");
  writeFileSync(config, "[core]\n");
  let before = [snapshot(repository)];
  writeFileSync(join(repository, ".ignored-local"), "unexpected\n");
  expect(() => assertSnapshotUnchanged([repository], before, "codex")).toThrow();
  before = [snapshot(repository)];
  writeFileSync(config, "[core]\n\tbare = true\n");
  expect(() => assertSnapshotUnchanged([repository], before, "codex")).toThrow();
});

test("release smoke detects a persistent tool written outside host config folders", () => {
  const home = mkdtempSync(join(tmpdir(), "hoklims-devkit-tool-oracle-"));
  const paths = protectedProfilePaths(home);
  const bin = join(home, "uv-bin");
  expect(paths).toContain(bin);
  const before = paths.map(snapshot);
  mkdirSync(bin);
  writeFileSync(join(bin, "latent-compass"), "unexpected\n");
  expect(() => assertSnapshotUnchanged(paths, before, "codex")).toThrow(/modified the host profile/u);
});

test("release smoke records Unix npm executable links without following them", () => {
  if (process.platform === "win32") return;
  const repository = mkdtempSync(join(tmpdir(), "hoklims-devkit-link-oracle-"));
  const bin = join(repository, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync("../assertledger/cli.js", join(bin, "assertledger"));
  const before = [snapshot(repository)];
  expect(JSON.stringify(before)).toContain('"link":"../assertledger/cli.js"');
  assertSnapshotUnchanged([repository], before, "codex");
});
