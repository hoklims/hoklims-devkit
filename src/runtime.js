import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPONENT_ORDER = ["semctx", "assertledger", "latent-compass"];
const HOST_ORDER = ["codex", "claude"];
const COMPONENT_NAMES = new Set(COMPONENT_ORDER);
const HOST_NAMES = new Set(HOST_ORDER);
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

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

function unsafeProjectPath(path, detail) {
  return Object.assign(new Error(`Unsafe project package path: ${path} ${detail}. Replace it with a regular local file, then rerun.`), { code: "STATE_CONFLICT" });
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

function inspectManagedFile(path, options) {
  assertSafeManagedParents(path);
  const stat = lstatIfPresent(path, options);
  if (stat?.isSymbolicLink()) throw unsafeManagedPath(path, "is a symbolic link");
  if (stat && !stat.isFile()) throw unsafeManagedPath(path, "is not a regular file");
  return stat;
}

function inspectPlainProjectFile(path, options) {
  const stat = lstatIfPresent(path, options);
  if (stat?.isSymbolicLink()) throw unsafeProjectPath(path, "is a symbolic link");
  if (stat && !stat.isFile()) throw unsafeProjectPath(path, "is not a regular file");
  return stat;
}

function inspectProjectDirectory(path) {
  const entry = lstatIfPresent(path);
  if (!entry) return false;
  let target;
  try {
    target = statSync(path);
  } catch (error) {
    if (entry.isSymbolicLink() && error?.code === "ENOENT") {
      throw unsafeProjectPath(path, "is a dangling directory link");
    }
    throw error;
  }
  if (!target.isDirectory()) throw unsafeProjectPath(path, "is not a directory");
  return true;
}

function openVerifiedReadDescriptor(path) {
  const flags = platform() === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  return openSync(path, flags);
}

function assertInspectedIdentity(path, inspectFile, conflict, identity, detail) {
  const current = inspectFile(path, { bigint: true });
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) throw conflict(path, detail);
}

function readVerifiedFile(path, inspectFile, conflict, beforeOpen = () => {}, readFileData = readFileSync, openReadDescriptor = openVerifiedReadDescriptor) {
  const initial = inspectFile(path, { bigint: true });
  if (!initial) return null;
  const identity = { dev: initial.dev, ino: initial.ino };
  beforeOpen(path);
  let descriptor;
  try {
    try {
      descriptor = openReadDescriptor(path);
    } catch (error) {
      assertInspectedIdentity(path, inspectFile, conflict, identity, "the pathname changed before it could be opened for reading");
      throw error;
    }
    const assertReadIdentity = () => {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) {
        throw conflict(path, "the file changed while it was opened for reading");
      }
      const current = inspectFile(path, { bigint: true });
      if (!current || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw conflict(path, "the pathname changed while it was opened for reading");
      }
    };
    assertReadIdentity();
    const content = readFileData(descriptor, "utf8", path);
    assertReadIdentity();
    return content;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertManagedDestination(path, expectedIdentity) {
  const stat = inspectManagedFile(path, { bigint: true });
  if (!expectedIdentity) {
    if (stat) throw ownedFileConflict(path, "a destination appeared during the write");
    return;
  }
  if (!stat || stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino) {
    throw ownedFileConflict(path, "the destination was replaced during the write");
  }
}

function captureManagedDestination(path, beforeOpen, openReadDescriptor) {
  const initial = inspectManagedFile(path, { bigint: true });
  if (!initial) return { descriptor: null, identity: null };
  const identity = { dev: initial.dev, ino: initial.ino };
  let descriptor;
  try {
    beforeOpen(path);
    try {
      descriptor = openReadDescriptor(path);
    } catch (error) {
      assertInspectedIdentity(path, inspectManagedFile, ownedFileConflict, identity, "the destination changed before its identity could be captured");
      throw error;
    }
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) {
      throw ownedFileConflict(path, "the destination changed while its identity was captured");
    }
    assertManagedDestination(path, identity);
    return { descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the capture error. */ }
    }
    throw error;
  }
}

function closeManagedDestination(destination) {
  if (destination.descriptor === null) return;
  const descriptor = destination.descriptor;
  destination.descriptor = null;
  closeSync(descriptor);
}

function readDescriptorText(descriptor) {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(new Error("Managed state file is not a readable regular file"), { code: "STATE_CONFLICT" });
  }
  const buffer = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
    if (count === 0) throw Object.assign(new Error("Managed state file changed while it was read"), { code: "STATE_CONFLICT" });
    offset += count;
  }
  return buffer.toString("utf8");
}

function parseStateText(text) {
  const parsed = JSON.parse(text);
  if (parsed === null) throw new Error("Invalid devkit state structure");
  return validateState(parsed);
}

function prepareManagedParent(path, createManagedParent) {
  assertSafeManagedParents(path);
  try {
    createManagedParent(dirname(resolve(path)), { recursive: true });
  } catch (error) {
    assertSafeManagedParents(path);
    throw error;
  }
  assertSafeManagedParents(path);
}

function openOwnedManagedFile(path, createOwnedFile, flags = "wx") {
  let descriptor;
  try {
    descriptor = createOwnedFile(path, flags, 0o600);
  } catch (error) {
    assertSafeManagedParents(path);
    throw error;
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const owned = { path, descriptor, identity: { dev: stat.dev, ino: stat.ino } };
    assertOwnedFile(owned);
    return owned;
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
  if (owned.descriptor === null) throw ownedFileConflict(owned.path, "the owned descriptor was closed before validation");
  const opened = fstatSync(owned.descriptor, { bigint: true });
  if (!opened.isFile() || opened.dev !== owned.identity.dev || opened.ino !== owned.identity.ino) {
    throw ownedFileConflict(owned.path, "the opened file identity changed");
  }
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
  let operationError = null;
  try {
    assertOwnedFile(owned);
    removeOwnedFile(owned.path);
  } catch (error) {
    operationError = error;
  }
  try {
    closeOwnedFile(owned);
  } catch (error) {
    if (!operationError) operationError = error;
  }
  if (operationError) throw operationError;
}

function readLockRecord(path, beforeOpen, readFileData, openReadDescriptor) {
  let record;
  try {
    record = JSON.parse(readVerifiedFile(path, inspectManagedFile, ownedFileConflict, beforeOpen, readFileData, openReadDescriptor));
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
      || typeof component.version !== "string" || !STABLE_VERSION.test(component.version)
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
      || !Array.isArray(plan.hosts) || plan.hosts.length === 0
      || plan.hosts.some((host) => !HOST_NAMES.has(host))
      || new Set(plan.hosts).size !== plan.hosts.length
      || JSON.stringify(plan.hosts) !== JSON.stringify(HOST_ORDER.filter((host) => plan.hosts.includes(host)))
      || !plan.versions || Array.isArray(plan.versions) || typeof plan.versions !== "object"
      || Object.keys(plan.versions).length !== plan.selected.length
      || plan.selected.some((name) => typeof plan.versions[name] !== "string"
        || !STABLE_VERSION.test(plan.versions[name]))
      || (plan.command === "setup" && plan.selected.some((name) => {
        const existing = state.components[name];
        return existing && existing.version !== plan.versions[name];
      }))
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
  beforeManagedReadOpen = () => {},
  commitOwnedFile = renameSync,
  createManagedParent = mkdirSync,
  createOwnedFile = openSync,
  openReadDescriptor = openVerifiedReadDescriptor,
  randomId = randomUUID,
  readFileData = readFileSync,
  removeOwnedFile = unlinkSync,
  spawnProcess,
  writeLockData = writeFileSync,
  writeStateData = writeFileSync,
} = {}) {
  const openStateTransaction = (path) => {
    prepareManagedParent(path, createManagedParent);
    const destination = captureManagedDestination(path, beforeManagedReadOpen, openReadDescriptor);
    let expectedText = null;
    let state = null;
    let closed = false;
    const assertExpectedDestination = () => {
      if (destination.descriptor === null) {
        assertManagedDestination(path, null);
        return;
      }
      const held = { path, descriptor: destination.descriptor, identity: destination.identity };
      assertOwnedFile(held);
      const currentText = readDescriptorText(destination.descriptor);
      assertOwnedFile(held);
      if (currentText !== expectedText) {
        throw ownedFileConflict(path, "the validated state bytes changed before the next checkpoint");
      }
    };
    try {
      if (destination.descriptor !== null) {
        const held = { path, descriptor: destination.descriptor, identity: destination.identity };
        assertOwnedFile(held);
        expectedText = readDescriptorText(destination.descriptor);
        assertOwnedFile(held);
        state = parseStateText(expectedText);
      }
    } catch (error) {
      closeManagedDestination(destination);
      throw error;
    }
    return {
      state,
      write: (nextState) => {
        if (closed) throw ownedFileConflict(path, "the state transaction is already closed");
        validateState(nextState);
        prepareManagedParent(path, createManagedParent);
        assertExpectedDestination();
        const data = `${JSON.stringify(nextState, null, 2)}\n`;
        const temp = `${path}.${randomId()}.tmp`;
        let owned = null;
        try {
          owned = openOwnedManagedFile(temp, createOwnedFile, "wx+");
          writeStateData(owned.descriptor, data);
          assertOwnedFile(owned);
          assertExpectedDestination();
          const previousDescriptor = destination.descriptor;
          // Windows cannot replace an open destination. Close only after the final identity and byte
          // check; the already-open owned temporary file becomes the next guard without reopening the path.
          if (platform() === "win32" && previousDescriptor !== null) {
            closeSync(previousDescriptor);
            destination.descriptor = null;
          }
          commitOwnedFile(temp, path);
          owned.path = path;
          destination.descriptor = owned.descriptor;
          destination.identity = owned.identity;
          expectedText = data;
          owned = null;
          if (platform() !== "win32" && previousDescriptor !== null) closeSync(previousDescriptor);
        } catch (error) {
          if (owned) {
            try {
              cleanupOwnedFile(owned, removeOwnedFile);
            } catch (cleanupError) {
              throw cleanupError;
            }
          }
          if (error?.code === "EEXIST") {
            const collision = inspectManagedFile(temp);
            if (collision) throw ownedFileConflict(temp, "a foreign temporary file already exists");
            throw unsafeManagedPath(temp, "changed during exclusive temporary-file creation");
          }
          throw error;
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        let operationError = null;
        try {
          assertExpectedDestination();
        } catch (error) {
          operationError = error;
        }
        try {
          closeManagedDestination(destination);
        } catch (error) {
          if (!operationError) operationError = error;
        }
        if (operationError) throw operationError;
      },
    };
  };
  return {
    which: (name) => Bun.which(name),
    exec: async (argv, cwd, timeoutMs = 120_000) => {
      let child;
      try {
        const spawn = spawnProcess ?? Bun.spawn;
        child = spawn({ cmd: argv, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (error) {
        return { code: 5, stdout: "", stderr: String(error) };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      try {
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { code: timedOut ? 5 : code, stdout, stderr: timedOut ? `Timed out after ${timeoutMs} ms` : stderr };
        } catch (error) {
          try { child.kill(); } catch { /* Preserve the stream failure. */ }
          return { code: 5, stdout: "", stderr: `Native process output read failed: ${String(error?.message ?? error)}` };
        }
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
    pathPresent: (path) => Boolean(lstatIfPresent(path)),
    plainFilePresent: (path) => Boolean(inspectPlainProjectFile(path)),
    directoryPresent: inspectProjectDirectory,
    isReadableFile: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    readPlainText: (path) => readVerifiedFile(path, inspectPlainProjectFile, unsafeProjectPath, undefined, readFileData, openReadDescriptor),
    realpath: realpathSync,
    statePath: (root) => {
      const base = platform() === "win32"
        ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
        : process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
      const key = createHash("sha256").update(root).digest("hex");
      return join(base, "hoklims-devkit", `${key}.json`);
    },
    readState: (path) => {
      const text = readVerifiedFile(path, inspectManagedFile, ownedFileConflict, beforeManagedReadOpen, readFileData, openReadDescriptor);
      if (text === null) return null;
      return parseStateText(text);
    },
    openStateTransaction,
    writeState: (path, state) => {
      validateState(state);
      prepareManagedParent(path, createManagedParent);
      const destination = captureManagedDestination(path, beforeManagedReadOpen, openReadDescriptor);
      const temp = `${path}.${randomId()}.tmp`;
      let owned = null;
      try {
        owned = openOwnedManagedFile(temp, createOwnedFile);
        writeStateData(owned.descriptor, `${JSON.stringify(state, null, 2)}\n`);
        assertOwnedFile(owned);
        assertManagedDestination(path, destination.identity);
        // Node has no portable identity-bound rename/CAS. This identity check cannot eliminate a hostile
        // pathname swap between the final validation and rename by a peer outside this lock.
        commitOwnedFile(temp, path);
        const committed = owned;
        owned = null;
        closeOwnedFile(committed);
      } catch (error) {
        if (owned) {
          try {
            cleanupOwnedFile(owned, removeOwnedFile);
          } catch (cleanupError) {
            throw cleanupError;
          }
        }
        if (error?.code === "EEXIST") {
          const collision = inspectManagedFile(temp);
          if (collision) throw ownedFileConflict(temp, "a foreign temporary file already exists");
          throw unsafeManagedPath(temp, "changed during exclusive temporary-file creation");
        }
        throw error;
      } finally {
        closeManagedDestination(destination);
      }
    },
    acquireLock: (statePath) => {
      prepareManagedParent(statePath, createManagedParent);
      inspectManagedFile(statePath);
      const lockPath = `${statePath}.lock`;
      const existingLock = inspectManagedFile(lockPath);
      if (existingLock) {
        readLockRecord(lockPath, beforeManagedReadOpen, readFileData, openReadDescriptor);
        throw new RunLockedError(`Another setup may be running. Inspect ${lockPath} before removing a stale lock.`);
      }
      const token = randomId();
      let owned = null;
      try {
        beforeLockOpen(lockPath);
        owned = openOwnedManagedFile(lockPath, createOwnedFile);
        writeLockData(owned.descriptor, JSON.stringify({ token, pid: process.pid }));
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
            readLockRecord(lockPath, beforeManagedReadOpen, readFileData, openReadDescriptor);
            throw new RunLockedError(`Another setup may be running. Inspect ${lockPath} before removing a stale lock.`);
          }
          throw unsafeManagedPath(lockPath, "changed during exclusive lock creation");
        }
        throw error;
      }
      return () => {
        try {
          assertOwnedFile(owned);
          const current = readLockRecord(lockPath, beforeManagedReadOpen, readFileData, openReadDescriptor);
          if (current.token !== token) throw ownedFileConflict(lockPath, "the lock token was changed");
          cleanupOwnedFile(owned, removeOwnedFile);
        } catch (error) {
          try { closeOwnedFile(owned); } catch { /* Preserve the release error. */ }
          throw error;
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
