import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Release/test oracle for the current Bun runtime APIs, not a general sandbox.
const policy = JSON.parse(readFileSync(process.env.DEVKIT_CAPTURE_POLICY, "utf8"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = event => appendFileSync(policy.journal, `${JSON.stringify(event)}\n`);
const gitPrefix = ["git", "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", policy.repository];
const gitReads = [
  ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
  ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
  ["rev-parse", "--verify", "HEAD"],
  ["rev-parse", "--verify", `${policy.head}^{commit}`],
  ["ls-files", "-v", "-z"], ["ls-files", "--stage", "-z"],
  ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
  ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", policy.head, policy.head],
];
for (const api of ["spawn", "spawnSync"]) {
  const original = Bun[api].bind(Bun);
  Object.defineProperty(Bun, api, { configurable: false, writable: false, value: (...args) => {
    const options = Array.isArray(args[0]) ? args[1] ?? {} : args[0] ?? {};
    const argv = Array.isArray(args[0]) ? args[0] : options.cmd;
    const cwd = typeof options.cwd === "string" ? resolve(options.cwd) : process.cwd();
    const allowed = cwd === policy.repository && options.env === undefined && Array.isArray(argv)
      && argv.every(arg => typeof arg === "string") && (
        same(argv, ["bun", "--version"])
        || same(argv, ["git", "-C", policy.repository, "rev-parse", "--show-toplevel"])
        || (same(argv.slice(0, gitPrefix.length), gitPrefix) && gitReads.some(read => same(argv.slice(gitPrefix.length), read)))
      );
    record({ kind: "call", api: `Bun.${api}`, argv: Array.isArray(argv) ? argv : null, cwd, allowed });
    if (!allowed) throw new Error("Capture guard blocked a forbidden operation before execution");
    return original(...args);
  } });
}
Object.defineProperty(globalThis, "fetch", { configurable: false, writable: false, value: (...args) => {
  record({ kind: "call", api: "fetch", url: String(args[0]), allowed: false });
  throw new Error("Capture guard blocked fetch before execution");
} });
record({ kind: "ready", apis: ["Bun.spawn", "Bun.spawnSync", "fetch"], repository: policy.repository, bun: Bun.version });
