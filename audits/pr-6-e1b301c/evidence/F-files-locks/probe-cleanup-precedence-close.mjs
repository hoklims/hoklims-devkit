// Same scenario via the transaction API: does close() re-detect the conflict that write() reported as EBUSY?
import * as __fsmod from "node:fs"; globalThis.__fs = __fsmod;
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const { createRuntime } = await import(join(process.argv[2], "src/runtime.js"));
for (const seeded of [false, true]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "probe-cleanup-close-")));
  const statePath = join(root, "repository.json");
  if (seeded) writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, projectRoot: "/repo", components: {} }));
  let written = 0;
  const rt = createRuntime({
    randomId: () => "candidate",
    writeStateData: (fd, data) => { writeFileSync(fd, data); if (written++ === 0) { writeFileSync(statePath + ".x", "FOREIGN\n"); (await_rename(statePath + ".x", statePath)); } },
    removeOwnedFile: () => { throw Object.assign(new Error("unlink EBUSY"), { code: "EBUSY" }); },
  });
  const tx = rt.openStateTransaction(statePath);
  let writeCode = null, closeCode = null;
  try { tx.write({ schemaVersion: 1, projectRoot: "/repo", components: { semctx: { version: "0.3.4", hosts: ["codex"] } } }); } catch (e) { writeCode = e.code; }
  try { tx.close(); } catch (e) { closeCode = e.code; }
  console.log(JSON.stringify({ seeded, writeCode, closeCode }));
}
function await_rename(a, b) { return require_fs().renameSync(a, b); }
function require_fs() { return globalThis.__fs; }
