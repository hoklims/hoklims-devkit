// No hooks: real concurrent churn in /tmp (an unrelated ancestor) while writeState runs 2000 times.
import { mkdtempSync, realpathSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const { createRuntime } = await import(join(process.argv[2], "src/runtime.js"));
const rt = createRuntime(); const codes = {};
for (let i = 0; i < 2000; i++) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "probe-churn-")));
  try { rt.writeState(join(root, "profile", "state.json"), { schemaVersion: 1, projectRoot: "/repo", components: {} }); codes.ok = (codes.ok ?? 0) + 1; }
  catch (e) { codes[e.code] = (codes[e.code] ?? 0) + 1; if (!codes.sample) codes.sample = e.message.slice(0, 110); }
  rmSync(root, { recursive: true, force: true });
}
console.log(process.argv[3], JSON.stringify(codes));
