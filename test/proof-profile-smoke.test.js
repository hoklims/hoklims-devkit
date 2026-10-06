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
  for (const path of ["package.json", "src", "bin", "plugins", "scripts"]) cpSync(resolve(import.meta.dir, "..", path), join(packaged, path), { recursive: true });
  return { root, packaged };
}
test("the installed package and embedded runtime retain the common read-only profile", async () => {
  const { root } = consumer();
  const result = await proofProfileSmoke(root);
  fixtures.push(result.root);
  expect(result.report.source.version).toBe("0.4.2");
  expect(result.captureJournals.map(item => item.label)).toEqual(["packaged", "embedded"]);
  expect(result.captureJournals.every(item => item.events.some(event => event.kind === "ready"))).toBe(true);
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

function mutateWorkflow(packaged, code) {
  const path = join(packaged, "src", "workflow.js");
  const source = readFileSync(path, "utf8");
  const marker = "export async function prepareWorkflow(options, rt, root, report) {";
  writeFileSync(path, source.replace(marker, `${marker}\n${code}`));
}

for (const api of ["spawn", "spawnSync"]) {
  for (const embedded of [false, true]) {
  test(`capture guard rejects a swallowed forbidden Bun.${api} request in ${embedded ? "embedded" : "packaged"} capture with unchanged report labels`, async () => {
    const { root, packaged } = consumer();
    // A deliberately nonexistent executable cannot perform an operation even on
    // the unguarded baseline. The mutant swallows failure and still plans normally.
    mutateWorkflow(packaged, `  ${embedded ? 'if (import.meta.url.includes("hoklims-proof/runtime/")) ' : ""}try { Bun.${api}({ cmd: ["__devkit_forbidden_probe__"], cwd: root }); } catch {}`);
    await expect(proofProfileSmoke(root)).rejects.toThrow("Capture guard recorded a forbidden operation");
  }, 15000);
  }
}

test("capture guard rejects a swallowed fetch attempt before network access", async () => {
  const { root, packaged } = consumer();
  mutateWorkflow(packaged, '  try { await fetch("https://devkit-smoke.invalid/forbidden"); } catch {}');
  await expect(proofProfileSmoke(root)).rejects.toThrow("Capture guard recorded a forbidden operation");
}, 15000);

for (const embedded of [false, true]) {
  test(`consumed source snapshot rejects ${embedded ? "embedded" : "packaged"} mutation during capture`, async () => {
    const { root, packaged } = consumer();
    mutateWorkflow(packaged, `  ${embedded ? 'if (import.meta.url.includes("hoklims-proof/runtime/")) ' : ""}{ const fs = await import("node:fs"); fs.writeFileSync(new URL("../capture-mutant.txt", import.meta.url), "harmless fixture mutation"); }`);
    await expect(proofProfileSmoke(root)).rejects.toThrow(embedded ? "Embedded source changed during capture" : "Packaged source changed during capture");
  }, 15000);
}
