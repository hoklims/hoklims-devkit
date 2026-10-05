// Primary STATE_CONFLICT (destination replaced during temp write) followed by a secondary I/O error
// while removing the still-owned, unchanged temporary file.
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const { createRuntime } = await import(join(process.argv[2], "src/runtime.js"));
for (const api of ["writeState", "transaction"]) {
  for (const unlinkFails of [false, true]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "probe-cleanup-precedence-")));
    const statePath = join(root, "repository.json");
    let written = 0;
    const rt = createRuntime({
      randomId: () => "candidate",
      writeStateData: (fd, data) => { writeFileSync(fd, data); if (written++ === 0) writeFileSync(statePath, "FOREIGN\n"); },
      removeOwnedFile: (p) => { if (unlinkFails) throw Object.assign(new Error("unlink EBUSY"), { code: "EBUSY" }); unlinkSync(p); },
    });
    let code = null, msg = null;
    try {
      if (api === "writeState") rt.writeState(statePath, { schemaVersion: 1, projectRoot: "/repo", components: {} });
      else rt.openStateTransaction(statePath).write({ schemaVersion: 1, projectRoot: "/repo", components: {} });
    } catch (e) { code = e.code; msg = e.message.slice(0, 90); }
    console.log(JSON.stringify({ api, unlinkFails, code, msg, foreignPreserved: readFileSync(statePath, "utf8") === "FOREIGN\n", entries: readdirSync(root) }));
  }
}
