import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPONENT_ORDER = ["semctx", "assertledger", "latent-compass"];
const HOST_ORDER = ["codex", "claude"];
const COMPONENT_NAMES = new Set(COMPONENT_ORDER);
const HOST_NAMES = new Set(HOST_ORDER);

function lstatIfPresent(path, options) {
  try {
    return lstatSync(path, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function unsafeManagedPath(path, detail) {
  return Object.assign(new Error(`Unsafe managed state path: ${path} ${detail}. Replace linked state paths with real local directories or files, then rerun.`), { code: "STATE_CONFLICT" });
}

function ownedFileConflict(path, detail) {
  return Object.assign(new Error(`Managed state file ownership changed at ${path}: ${detail}. Preserve the foreign path, inspect it, then rerun.`), { code: "STATE_CONFLICT" });
}

function assertSafeManagedParents(path) {
  const parents = [];
  let current = dirname(resolve(path));
  while (true) {
    parents.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of parents.reverse()) {
    const stat = lstatIfPresent(candidate);
    if (stat?.isSymbolicLink()) throw unsafeManagedPath(candidate, "is a symbolic link");
    if (stat && !stat.isDirectory()) throw unsafeManagedPath(candidate, "is not a directory");
  }
}

function inspectManagedFile(path) {
  assertSafeManagedParents(path);
  const stat = lstatIfPresent(path);
  if (stat?.isSymbolicLink()) throw unsafeManagedPath(path, "is a symbolic link");
  if (stat && !stat.isFile()) throw unsafeManagedPath(path, "is not a regular file");
  return stat;
}

function prepareManagedParent(path) {
  assertSafeManagedParents(path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  assertSafeManagedParents(path);
}

function openOwnedManagedFile(path) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    return { path, descriptor, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    try { closeSync(descriptor); } catch { /* Preserve the identity error. */ }
    throw error;
  }
}

function closeOwnedFile(owned) {
  if (owned.descriptor === null) return;
  const descriptor = owned.descriptor;
  owned.descriptor = null;
  closeSync(descriptor);
}

function assertOwnedFile(owned) {
  assertSafeManagedParents(owned.path);
  const stat = lstatIfPresent(owned.path, { bigint: true });
  if (!stat) throw ownedFileConflict(owned.path, "the owned path was removed");
  if (stat.isSymbolicLink() || !stat.isFile()
    || stat.dev !== owned.identity.dev || stat.ino !== owned.identity.ino) {
    throw ownedFileConflict(owned.path, "the pathname now identifies another file");
  }
  return stat;
}

function cleanupOwnedFile(owned, removeOwnedFile) {
  let closeError = null;
  try {
    closeOwnedFile(owned);
  } catch (error) {
    closeError = error;
  }
  assertOwnedFile(owned);
  removeOwnedFile(owned.path);
  if (closeError) throw closeError;
}

function readLockRecord(path) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw Object.assign(new Error(`Unsafe managed state path: ${path} contains an invalid lock record. Preserve and inspect the file before retrying.`), { code: "STATE_CONFLICT" });
  }
  if (!record || Array.isArray(record) || typeof record !== "object"
    || Object.keys(record).length !== 2 || !Object.hasOwn(record, "token") || !Object.hasOwn(record, "pid")
    || typeof record.token !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.token)
    || !Number.isInteger(record.pid) || record.pid <= 0) {
    throw Object.assign(new Error(`Unsafe managed state path: ${path} contains an invalid lock record. Preserve and inspect the file before retrying.`), { code: "STATE_CONFLICT" });
  }
  return record;
}

export class RunLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunLockedError";
    this.code = "RUN_LOCKED";
  }
}

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
      || new Set(component.hosts).size !== component.hosts.length
      || JSON.stringify(component.hosts) !== JSON.stringify(HOST_ORDER.filter((host) => component.hosts.includes(host)))) {
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
      || JSON.stringify(plan.selected) !== JSON.stringify(COMPONENT_ORDER.filter((name) => plan.selected.includes(name)))
      || Object.keys(state.components).some((name) => !plan.selected.includes(name))
      || !Array.isArray(plan.hosts) || plan.hosts.length === 0
      || plan.hosts.some((host) => !HOST_NAMES.has(host))
      || new Set(plan.hosts).size !== plan.hosts.length
      || JSON.stringify(plan.hosts) !== JSON.stringify(HOST_ORDER.filter((host) => plan.hosts.includes(host)))
      || !plan.versions || Array.isArray(plan.versions) || typeof plan.versions !== "object"
      || Object.keys(plan.versions).length !== plan.selected.length
      || plan.selected.some((name) => typeof plan.versions[name] !== "string"
        || !/^\d+\.\d+\.\d+$/u.test(plan.versions[name]))
      || (plan.command === "upgrade" && plan.selected.some((name) => {
        const existing = state.components[name];
        return existing && existing.version !== plan.versions[name]
          && existing.hosts.some((host) => !plan.hosts.includes(host));
      }))) {
      throw new Error("Invalid in-progress installation plan");
    }
  }
  return state;
}

export function createRuntime({
  beforeLockOpen = () => {},
  randomId = randomUUID,
  removeOwnedFile = unlinkSync,
  writeLockData = writeFileSync,
  writeStateData = writeFileSync,
} = {}) {
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
      const stat = inspectManagedFile(path);
      if (!stat) return null;
      return validateState(JSON.parse(readFileSync(path, "utf8")));
    },
    writeState: (path, state) => {
      validateState(state);
      prepareManagedParent(path);
      inspectManagedFile(path);
      const temp = `${path}.${randomId()}.tmp`;
      let owned = null;
      try {
        owned = openOwnedManagedFile(temp);
        try {
          writeStateData(owned.descriptor, `${JSON.stringify(state, null, 2)}\n`);
        } finally {
          closeOwnedFile(owned);
        }
        assertOwnedFile(owned);
        inspectManagedFile(path);
        // Node has no portable identity-bound rename/CAS. This final identity check narrows, but cannot
        // eliminate, a hostile pathname swap between validation and rename by a peer outside this lock.
        renameSync(temp, path);
        owned = null;
      } catch (error) {
        if (owned) {
          try {
            cleanupOwnedFile(owned, removeOwnedFile);
          } catch (cleanupError) {
            throw cleanupError;
          }
        }
        throw error;
      }
    },
    acquireLock: (statePath) => {
      prepareManagedParent(statePath);
      inspectManagedFile(statePath);
      const lockPath = `${statePath}.lock`;
      const existingLock = inspectManagedFile(lockPath);
      if (existingLock) {
        readLockRecord(lockPath);
        throw new RunLockedError(`Another setup may be running. Inspect ${lockPath} before removing a stale lock.`);
      }
      const token = randomId();
      let owned = null;
      try {
        beforeLockOpen(lockPath);
        owned = openOwnedManagedFile(lockPath);
        try {
          writeLockData(owned.descriptor, JSON.stringify({ token, pid: process.pid }));
        } finally {
          closeOwnedFile(owned);
        }
        assertOwnedFile(owned);
      } catch (error) {
        if (owned) {
          try {
            cleanupOwnedFile(owned, removeOwnedFile);
          } catch (cleanupError) {
            throw cleanupError;
          }
        }
        if (error?.code === "EEXIST") {
          const racedLock = inspectManagedFile(lockPath);
          if (racedLock) {
            readLockRecord(lockPath);
            throw new RunLockedError(`Another setup may be running. Inspect ${lockPath} before removing a stale lock.`);
          }
          throw unsafeManagedPath(lockPath, "changed during exclusive lock creation");
        }
        throw error;
      }
      return () => {
        assertOwnedFile(owned);
        const current = readLockRecord(lockPath);
        if (current.token !== token) throw ownedFileConflict(lockPath, "the lock token was changed");
        removeOwnedFile(lockPath);
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
