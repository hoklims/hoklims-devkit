// Probe: STATE_CONFLICT observed during a state write, then a secondary I/O error while cleaning the owned temp.
import { mkdtempSync, writeFileSync, renameSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/devkit-audit/src/runtime.js";

const valid = { schemaVersion: 1, projectRoot: "/p", components: {} };
function scenario(label, opts) {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  const statePath = join(dir, "hoklims-devkit", "s.json");
  const rt = createRuntime(opts(statePath));
  rt.writeState(statePath, valid); // create destination
  try { rt.writeState(statePath, valid); console.log(label, "NO ERROR"); }
  catch (e) { console.log(label, "->", e.code ?? "(no code)", "|", e.message.slice(0, 110)); }
  console.log("   files:", readdirSync(join(dir, "hoklims-devkit")));
}
let armed = false;
const ioFail = () => { throw Object.assign(new Error("EIO: simulated unlink failure"), { code: "EIO" }); };
// A: destination replaced by a third party during the write (conflict), temp unlink succeeds -> expect STATE_CONFLICT
scenario("A conflict, cleanup ok     ", (p) => ({
  writeStateData: (fd, data) => { writeFileSync(fd, data); if (armed) { writeFileSync(p + ".x", "{}"); renameSync(p + ".x", p); } armed = true; },
}));
armed = false;
// B: same conflict, but secondary I/O error while removing the owned temp -> spec: must stay STATE_CONFLICT
scenario("B conflict, cleanup EIO    ", (p) => ({
  writeStateData: (fd, data) => { writeFileSync(fd, data); if (armed) { writeFileSync(p + ".x", "{}"); renameSync(p + ".x", p); } armed = true; },
  removeOwnedFile: (path) => { if (armed) ioFail(); },
}));

// C/D: the path app.js uses (openStateTransaction().write), same two cases.
function txScenario(label, failCleanup) {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  const p = join(dir, "hoklims-devkit", "s.json");
  createRuntime().writeState(p, valid);
  const rt = createRuntime({
    writeStateData: (fd, data) => { writeFileSync(fd, data); writeFileSync(p + ".x", readFileSync(p)); renameSync(p + ".x", p); },
    removeOwnedFile: (path) => { if (failCleanup) ioFail(); },
  });
  const tx = rt.openStateTransaction(p);
  try { tx.write({ ...valid, components: { semctx: { version: "1.0.0", hosts: ["codex"] } } }); console.log(label, "NO ERROR"); }
  catch (e) { console.log(label, "->", e.code ?? "(no code)", "|", e.message.slice(0, 110)); }
  try { tx.close(); } catch (e) { console.log("   close ->", e.code); }
  console.log("   files:", readdirSync(join(dir, "hoklims-devkit")));
}
txScenario("C tx conflict, cleanup ok  ", false);
txScenario("D tx conflict, cleanup EIO ", true);
