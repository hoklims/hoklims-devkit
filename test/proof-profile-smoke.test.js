import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { proofProfileSmoke } from "../scripts/proof-profile-smoke.js";

const fixtures = [];
afterAll(() => { for (const root of fixtures) if (dirname(root) === realpathSync(tmpdir())) rmSync(root, { recursive: true, force: true }); });
function consumer() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-proof-package-test-")));
  fixtures.push(root);
  const packaged = join(root, "node_modules", "hoklims-devkit");
  mkdirSync(packaged, { recursive: true });
  for (const path of ["package.json", "src", "bin", "plugins"]) cpSync(resolve(import.meta.dir, "..", path), join(packaged, path), { recursive: true });
  return { root, packaged };
}
test("the installed package and embedded runtime retain the common read-only profile", async () => {
  const { root } = consumer();
  const result = await proofProfileSmoke(root);
  fixtures.push(result.root);
  expect(result.report.source.version).toBe("0.4.2");
}, 15000);
test("the packaging smoke refuses an omitted skill reference", async () => {
  const { root, packaged } = consumer();
  unlinkSync(join(packaged, "plugins", "hoklims-proof", "skills", "proof-workflow", "references", "evidence.md"));
  await expect(proofProfileSmoke(root)).rejects.toThrow("The common plugin cannot bundle additional providers, hooks or unknown resources");
});
test("the packaging smoke refuses a stale common pin", async () => {
  const { root, packaged } = consumer();
  const path = join(packaged, "src", "proof-plugin.js");
  writeFileSync(path, readFileSync(path, "utf8").replace('semctx: "0.4.2"', 'semctx: "0.4.1"'));
  await expect(proofProfileSmoke(root)).rejects.toThrow("Packaged common profile pins drifted");
});
