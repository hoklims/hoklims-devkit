import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPONENT_NAMES = new Set(["semctx", "assertledger", "latent-compass"]);
const HOST_NAMES = new Set(["codex", "claude"]);

export function validateState(state) {
  if (state === null) return null;
  if (!state || Array.isArray(state) || typeof state !== "object" || state.schemaVersion !== 1
    || typeof state.projectRoot !== "string" || !state.projectRoot
    || !state.components || Array.isArray(state.components) || typeof state.components !== "object") {
    throw new Error("Invalid devkit state structure");
  }
  for (const [name, component] of Object.entries(state.components)) {
    if (!COMPONENT_NAMES.has(name) || !component || Array.isArray(component) || typeof component !== "object"
      || typeof component.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(component.version)
      || !Array.isArray(component.hosts) || component.hosts.length === 0
      || component.hosts.some((host) => !HOST_NAMES.has(host))
      || new Set(component.hosts).size !== component.hosts.length) {
      throw new Error(`Invalid devkit state component: ${name}`);
    }
  }
  if (state.inProgress !== undefined) {
    const plan = state.inProgress;
    if (!plan || Array.isArray(plan) || typeof plan !== "object"
      || !["setup", "upgrade"].includes(plan.command)
      || !Array.isArray(plan.selected) || plan.selected[0] !== "semctx"
      || plan.selected.some((name) => !COMPONENT_NAMES.has(name))
      || new Set(plan.selected).size !== plan.selected.length
      || !Array.isArray(plan.hosts) || plan.hosts.length === 0
      || plan.hosts.some((host) => !HOST_NAMES.has(host))
      || new Set(plan.hosts).size !== plan.hosts.length
      || !plan.versions || Array.isArray(plan.versions) || typeof plan.versions !== "object"
      || Object.keys(plan.versions).length !== plan.selected.length
      || plan.selected.some((name) => typeof plan.versions[name] !== "string"
        || !/^\d+\.\d+\.\d+$/u.test(plan.versions[name]))) {
      throw new Error("Invalid in-progress installation plan");
    }
  }
  return state;
}

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
      return validateState(JSON.parse(readFileSync(path, "utf8")));
    },
    writeState: (path, state) => {
      validateState(state);
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`Unsafe state path: ${path}`);
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      try {
        renameSync(temp, path);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
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
