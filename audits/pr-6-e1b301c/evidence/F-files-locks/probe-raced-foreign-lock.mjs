import { mkdtempSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { createRuntime } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-F-files-locks/src/runtime.js";
const root = realpathSync(mkdtempSync(join(tmpdir(), "probe-raced-lock-")));
const statePath = join(root, "repository.json"); const lockPath = statePath + ".lock";
const rt = createRuntime({ beforeLockOpen: () => writeFileSync(lockPath, JSON.stringify({ token: "foreign", pid: 42 })) });
let code; try { rt.acquireLock(statePath); } catch (e) { code = e.code; }
console.log(JSON.stringify({ code, preserved: readFileSync(lockPath, "utf8") }));
