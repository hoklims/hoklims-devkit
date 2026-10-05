// Unrelated sibling churn inside an ANCESTOR directory (not the state parent) during the root-down walk.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const W = process.argv[2];
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "probe-ancestor-ctime-")));
const statePath = path.join(base, "home", "state", "hoklims-devkit", "repo.json");
fs.mkdirSync(path.dirname(statePath), { recursive: true });
const home = path.join(base, "home");
const native = fs.lstatSync; let churned = 0; const mode = process.argv[3];
fs.lstatSync = function (p, o) {
  const r = native.call(this, p, o);
  if (mode === "churn" && p === home && churned < 1) { churned++; fs.writeFileSync(path.join(home, ".bash_history"), "x"); }
  return r;
};
syncBuiltinESMExports();
const { createRuntime } = await import(path.join(W, "src/runtime.js"));
let code = null; try { createRuntime().writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} }); } catch (e) { code = e.code; var msg = e.message; }
console.log(JSON.stringify({ mode, churned, code, msg: msg?.slice(0, 140) ?? null, written: fs.existsSync(statePath) }));
