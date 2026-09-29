import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoopUpgradeUnchanged } from "../scripts/release-upgrade.js";
import { snapshot } from "../scripts/profile-snapshot.js";

const report = (version) => ({ components: [
  { name: "semctx", version },
  { name: "assertledger", version: "1.3.0" },
] });

test("same-version upgrade rejects changed managed bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-noop-upgrade-"));
  const managed = join(root, "managed.json");
  writeFileSync(managed, "before\n");
  const paths = [managed];
  const before = paths.map(snapshot);
  writeFileSync(managed, "foreign rewrite\n");
  expect(() => assertNoopUpgradeUnchanged(paths, before, report("0.3.5"), report("0.3.5"), report("0.3.5"), "noop"))
    .toThrow(/modified the host profile/u);

  expect(() => assertNoopUpgradeUnchanged(paths, before, report("0.3.5"), report("0.3.6"), report("0.3.5"), "noop applied"))
    .toThrow(/modified the host profile/u);
});

test("same-version upgrade accepts stable bytes and version-changing upgrade permits managed changes", () => {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-upgrade-control-"));
  const managed = join(root, "managed.json");
  writeFileSync(managed, "stable\n");
  const paths = [managed];
  let before = paths.map(snapshot);
  expect(assertNoopUpgradeUnchanged(paths, before, report("0.3.5"), report("0.3.5"), report("0.3.5"), "noop")).toBe(true);
  writeFileSync(managed, "version-changing rewrite\n");
  expect(assertNoopUpgradeUnchanged(paths, before, report("0.3.5"), report("0.3.6"), report("0.3.6"), "upgrade")).toBe(false);
  expect(() => assertNoopUpgradeUnchanged(paths, before, report("0.3.5"), report("0.3.6"), report("0.3.5"), "mismatch"))
    .toThrow(/modified the host profile|differ from the upgrade plan/u);
});

test("upgrade identity rejects version and component selection mismatches with stable snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "hoklims-devkit-upgrade-identity-"));
  const managed = join(root, "managed.json");
  writeFileSync(managed, "stable\n");
  const paths = [managed];
  const before = paths.map(snapshot);
  const installed = report("0.3.5");
  const versionPlan = report("0.3.6");
  const versionApplied = report("0.3.7");
  expect(() => assertNoopUpgradeUnchanged(
    paths, before, installed, versionPlan, versionApplied, "version mismatch",
  )).toThrow(/versions differ from the upgrade plan/u);

  const rename = (source, index, name) => ({
    components: source.components.map((component, itemIndex) => (
      itemIndex === index ? { ...component, name } : { ...component }
    )),
  });
  const reordered = { components: [...installed.components].reverse() };
  const missing = { components: installed.components.slice(0, -1) };
  const extra = { components: [...installed.components, { name: "latent-compass", version: "0.3.0" }] };
  const cases = [
    [rename(installed, 0, "semctx-renamed"), installed],
    [installed, rename(installed, 1, "assertledger-renamed")],
    [reordered, reordered],
    [missing, missing],
    [extra, extra],
  ];
  for (const [plan, applied] of cases) {
    expect(() => assertNoopUpgradeUnchanged(
      paths, before, installed, plan, applied, "selection mismatch",
    )).toThrow(/component selection differs/u);
  }
  expect(paths.map(snapshot)).toEqual(before);
});
