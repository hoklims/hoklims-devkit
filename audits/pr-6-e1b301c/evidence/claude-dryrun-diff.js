import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshot, protectedProfilePaths } from "/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/devkit-audit/scripts/profile-snapshot.js";
const consumer = process.argv[2]; const host = process.argv[3] ?? "claude";
const root = realpathSync(mkdtempSync(join(tmpdir(), "diag-")));
const repo = join(root, "repository"), home = join(root, "home"), cache = join(root, "cache");
mkdirSync(repo); mkdirSync(cache);
for (const d of [".codex", ".claude", "AppData/Local", "AppData/Roaming"]) mkdirSync(join(home, d), { recursive: true });
writeFileSync(join(home, ".codex", "hooks.json"), '{"hooks":{}}\n');
writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}\n');
writeFileSync(join(repo, "index.ts"), "export const answer = 42;\n");
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
  LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(cache, "xdg"), npm_config_cache: join(cache, "npm"), UV_CACHE_DIR: join(cache, "uv"),
  UV_TOOL_DIR: join(home, "uv-tools"), UV_TOOL_BIN_DIR: join(home, "uv-bin"), UV_PYTHON_INSTALL_DIR: join(home, "uv-python"),
  UV_PYTHON_BIN_DIR: join(home, "uv-python-bin"), UV_PYTHON_NO_REGISTRY: "true", BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cache, "bun-runtime") };
const sh = (cmd, cwd = consumer) => { const r = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" }); return r; };
sh(["git", "init", "-q", "-b", "main", repo]); sh(["git", "-C", repo, "add", "."]); sh(["git", "-C", repo, "-c", "user.name=a", "-c", "user.email=a@b.c", "commit", "-qm", "f"]);
const paths = protectedProfilePaths(home);
const before = paths.map(snapshot);
const r = sh(["bunx", "--no-install", "hoklims-devkit", "setup", repo, "--host", host, "--dry-run", "--json"]);
console.log("exit", r.exitCode, r.stdout.toString().slice(0, 300));
const after = paths.map(snapshot);
function walk(p, a, b) { if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a?.entries && b?.entries) { const m = new Map(b.entries); const n = new Map(a.entries);
    for (const k of new Set([...m.keys(), ...n.keys()])) walk(join(p, k), n.get(k), m.get(k)); return; }
  console.log("CHANGED", p.replace(home, "~"), a === undefined ? "(created)" : b === undefined ? "(removed)" : "(modified)"); }
paths.forEach((p, i) => walk(p, before[i], after[i]));
