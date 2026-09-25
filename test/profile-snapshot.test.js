import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSnapshotUnchanged, snapshot } from "../scripts/profile-snapshot.js";

test("release smoke rejects a host mutation despite a valid planned report", () => {
  const home = mkdtempSync(join(tmpdir(), "hoklims-devkit-smoke-oracle-"));
  const codex = join(home, ".codex");
  mkdirSync(codex);
  const hooks = join(codex, "hooks.json");
  writeFileSync(hooks, '{"hooks":{}}\n');
  const protectedPaths = [codex, join(home, "state")];
  const before = protectedPaths.map(snapshot);
  const plannedReport = { ok: true, components: [{ name: "semctx", state: "planned" }] };
  expect(plannedReport.ok).toBe(true);
  assertSnapshotUnchanged(protectedPaths, before, "codex");
  writeFileSync(hooks, '{"hooks":{"SessionStart":[]}}\n');
  expect(() => assertSnapshotUnchanged(protectedPaths, before, "codex")).toThrow(/modified the host profile/u);
});
