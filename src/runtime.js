import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export function createRuntime() {
  return {
    which: (name) => Bun.which(name),
    exec: async (argv, cwd, timeoutMs = 120_000) => {
      let child;
      try {
        child = Bun.spawn({ cmd: argv, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (error) {
        return { code: 5, stdout: "", stderr: String(error) };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { code: timedOut ? 5 : code, stdout, stderr: timedOut ? `Timed out after ${timeoutMs} ms` : stderr };
      } finally {
        clearTimeout(timer);
      }
    },
    fetchJson: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    },
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
    realpath: realpathSync,
    statePath: (root) => {
      const base = platform() === "win32"
        ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
        : process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
      const key = createHash("sha256").update(root).digest("hex");
      return join(base, "hoklims-devkit", `${key}.json`);
    },
    readState: (path) => {
      if (!existsSync(path)) return null;
      if (!lstatSync(path).isFile()) throw new Error(`Unsafe state path: ${path}`);
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (state?.schemaVersion !== 1 || typeof state.projectRoot !== "string" || typeof state.components !== "object") {
        throw new Error(`Invalid state file: ${path}`);
      }
      return state;
    },
    writeState: (path, state) => {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`Unsafe state path: ${path}`);
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    },
    acquireLock: (statePath) => {
      mkdirSync(dirname(statePath), { recursive: true });
      const lockPath = `${statePath}.lock`;
      const token = randomUUID();
      try {
        writeFileSync(lockPath, JSON.stringify({ token, pid: process.pid }), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code === "EEXIST") throw new Error(`Another setup may be running. Inspect ${lockPath} before removing a stale lock.`);
        throw error;
      }
      return () => {
        if (existsSync(lockPath) && lstatSync(lockPath).isFile()) {
          try {
            if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath);
          } catch { /* Preserve a lock changed by another process. */ }
        }
      };
    },
    resolve,
    join,
  };
}

export function parseJsonOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function shortError(result) {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 600);
}
