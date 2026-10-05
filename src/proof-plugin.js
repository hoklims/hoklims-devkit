import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

export const PROOF_PINS = Object.freeze({ semctx: "0.4.1", assertledger: "1.4.0" });
const NAME = "hoklims-proof";
const PREFIX = `.agents/plugins/${NAME}`;
const OWNER = `${PREFIX}/ownership.json`;
const CATALOG = ".agents/plugins/marketplace.json";
const CONFIG = ".codex/config.toml";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const marketplaceEntry = () => ({ name: NAME, source: { source: "local", path: `./${PREFIX}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" });

function safePath(root, name) {
  if (!name || name.split("/").some(part => !part || part === "." || part === "..") || /[\\:]/u.test(name)) throw new Error("Unsafe plugin path");
  const path = resolve(root, name);
  let current = root;
  for (const part of name.split("/")) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Plugin path is a link: ${name}`);
  }
  return path;
}

function read(root, name) {
  const path = safePath(root, name);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error(`Plugin path is not a regular file: ${name}`);
  return readFileSync(path);
}

function collect(root, directory, destination, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Plugin package contains a link");
    if (entry.isDirectory()) collect(root, path, destination, files);
    else if (entry.isFile()) files[`${destination}/${relative(root, path).replaceAll("\\", "/")}`] = readFileSync(path);
    else throw new Error("Plugin package contains an unsupported entry");
  }
}

function ownedSnapshot(root, expectedNames, { cached = false, nativeVersion = null } = {}) {
  const directory = cached ? root : safePath(root, PREFIX);
  const ownerName = cached ? "ownership.json" : OWNER;
  const ownerBytes = read(root, ownerName);
  if (!ownerBytes || !existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error("Plugin snapshot has no ownership record");
  let owner;
  try { owner = JSON.parse(ownerBytes.toString("utf8")); }
  catch { throw new Error("Plugin snapshot has an invalid ownership record"); }
  const ownerKeys = ["schemaVersion", "owner", "plugin", "version", "runtimes", "files"];
  if (!owner || typeof owner !== "object" || Array.isArray(owner)
    || Object.keys(owner).length !== ownerKeys.length || ownerKeys.some(key => !Object.hasOwn(owner, key))
    || owner.schemaVersion !== 1 || owner.owner !== "hoklims-devkit" || owner.plugin !== NAME
    || typeof owner.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(owner.version)
    || !owner.files || Array.isArray(owner.files) || typeof owner.files !== "object") throw new Error("Unsupported plugin ownership record");
  if (nativeVersion !== null && nativeVersion !== "local" && owner.version !== nativeVersion) throw new Error("Native cached plugin version differs from its ownership record");

  const expected = [...expectedNames].sort();
  const owned = Object.keys(owner.files).sort();
  if (owned.length !== expected.length || owned.some((name, index) => name !== expected[index])) throw new Error("Plugin ownership inventory is incomplete or requires an explicit migration");
  for (const name of owned) {
    const expectedHash = owner.files[name];
    if (!name.startsWith(`${PREFIX}/`) || name === OWNER || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedHash)) throw new Error("Invalid plugin ownership binding");
    const relativeName = name.slice(PREFIX.length + 1);
    const bytes = read(root, cached ? relativeName : name);
    if (!bytes || digest(bytes) !== expectedHash) throw new Error(`Owned plugin file was changed: ${name}`);
  }

  const inventory = {};
  collect(directory, directory, cached ? "snapshot" : PREFIX, inventory);
  const actual = Object.keys(inventory).map(name => cached ? `${PREFIX}/${name.slice("snapshot/".length)}` : name).sort();
  const complete = [...expected, OWNER].sort();
  if (actual.length !== complete.length || actual.some((name, index) => name !== complete[index])) throw new Error("Plugin snapshot contains missing or unowned files");

  const parseOwnedJson = name => {
    const bytes = read(root, cached ? name.slice(PREFIX.length + 1) : name);
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`Owned plugin metadata is invalid: ${name}`); }
  };
  const portable = parseOwnedJson(`${PREFIX}/plugin.json`);
  const compatibility = parseOwnedJson(`${PREFIX}/.codex-plugin/plugin.json`);
  const runtimePackage = parseOwnedJson(`${PREFIX}/runtime/package.json`);
  if (portable.name !== NAME || portable.version !== owner.version
    || compatibility.name !== NAME || compatibility.version !== owner.version
    || runtimePackage.name !== "hoklims-devkit" || runtimePackage.version !== owner.version) throw new Error("Owned plugin metadata version differs from its ownership record");

  const runtimeSource = read(root, cached ? "runtime/src/proof-plugin.js" : `${PREFIX}/runtime/src/proof-plugin.js`).toString("utf8");
  const declarationMarker = ["export const", "PROOF_PINS"].join(" ");
  const declarations = runtimeSource.split(declarationMarker).length - 1;
  const pinPattern = new RegExp(["export const", "PROOF_PINS = Object\\.freeze\\(\\{\\s*semctx: \"(\\d+\\.\\d+\\.\\d+)\",\\s*assertledger: \"(\\d+\\.\\d+\\.\\d+)\"\\s*\\}\\);"].join(" "), "u");
  const match = runtimeSource.match(pinPattern);
  const runtimeKeys = owner.runtimes && typeof owner.runtimes === "object" && !Array.isArray(owner.runtimes) ? Object.keys(owner.runtimes).sort() : [];
  if (declarations !== 1 || !match || runtimeKeys.length !== 2 || runtimeKeys[0] !== "assertledger" || runtimeKeys[1] !== "semctx"
    || owner.runtimes.semctx !== match[1] || owner.runtimes.assertledger !== match[2]) throw new Error("Owned plugin runtime pins differ from its closed declaration");
  return owner;
}

export function pluginPlan(root, { upgradePlugin = false } = {}) {
  const files = {};
  const template = join(packageRoot, "plugins", NAME);
  collect(template, template, PREFIX, files);
  const portable = JSON.parse(files[`${PREFIX}/plugin.json`].toString("utf8"));
  const compatibility = JSON.parse(files[`${PREFIX}/.codex-plugin/plugin.json`].toString("utf8"));
  if (portable.name !== NAME || portable.version !== packageJson.version
    || portable.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    || Object.keys(portable).some(key => !["$schema", "name", "version", "description"].includes(key))) throw new Error("Portable plugin identity/profile is invalid");
  if (compatibility.name !== NAME || compatibility.version !== packageJson.version || compatibility.skills !== "./skills/"
    || Object.keys(compatibility).some(key => !["name", "version", "description", "skills"].includes(key))) throw new Error("Compatibility plugin identity/profile is invalid");
  const templates = ["plugin.json", ".codex-plugin/plugin.json", "skills/proof-workflow/SKILL.md", "skills/proof-workflow/references/evidence.md"].map(path => `${PREFIX}/${path}`);
  if (Object.keys(files).length !== templates.length || templates.some(name => !Object.hasOwn(files, name))) throw new Error("The common plugin cannot bundle additional providers, hooks or unknown resources");
  const source = join(packageRoot, "src");
  collect(source, source, `${PREFIX}/runtime/src`, files);
  files[`${PREFIX}/runtime/bin/hoklims-devkit.js`] = readFileSync(join(packageRoot, "bin", "hoklims-devkit.js"));
  files[`${PREFIX}/runtime/package.json`] = readFileSync(join(packageRoot, "package.json"));
  const ownerBytes = read(root, OWNER);
  let owner = null;
  if (ownerBytes) {
    owner = ownedSnapshot(root, Object.keys(files));
  }
  for (const [name, bytes] of Object.entries(files)) {
    const previous = read(root, name);
    if (previous && (!owner || !Object.hasOwn(owner.files, name))) throw new Error(`Foreign plugin file exists: ${name}`);
    if (previous && !previous.equals(bytes) && !upgradePlugin) throw new Error("Plugin version/content differs; review onboard --upgrade-plugin --dry-run before upgrading");
  }
  const pluginDirectory = safePath(root, PREFIX);
  if (existsSync(pluginDirectory)) {
    const present = {};
    collect(pluginDirectory, pluginDirectory, PREFIX, present);
    if (Object.keys(present).some(name => name !== OWNER && !Object.hasOwn(files, name))) throw new Error("Plugin directory contains an unowned file");
  }
  const catalogBefore = read(root, CATALOG);
  const catalog = catalogBefore ? JSON.parse(catalogBefore.toString("utf8")) : { name: "hoklims-devkit", interface: { displayName: "Hoklims proof workflow" }, plugins: [] };
  if (typeof catalog.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(catalog.name) || !Array.isArray(catalog.plugins)
    || catalog.plugins.some(entry => !entry || typeof entry !== "object" || typeof entry.name !== "string")) throw new Error("Unsupported repository marketplace");
  const matches = catalog.plugins.filter(entry => entry.name === NAME);
  const pluginEntry = marketplaceEntry();
  if (matches.length > 1 || (matches.length && JSON.stringify(matches[0]) !== JSON.stringify(pluginEntry))) throw new Error("A foreign marketplace entry already uses hoklims-proof");
  if (!matches.length) { catalog.plugins.push(pluginEntry); files[CATALOG] = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`); }
  const configBefore = read(root, CONFIG);
  const configText = configBefore?.toString("utf8") ?? "";
  const config = Bun.TOML.parse(configText);
  const selector = `${NAME}@${catalog.name}`;
  if (config.plugins?.[selector] !== undefined && config.plugins[selector]?.enabled !== true) throw new Error("The repository explicitly disabled or customized this plugin; resolve its configuration first");
  files[OWNER] = Buffer.from(`${JSON.stringify({ schemaVersion: 1, owner: "hoklims-devkit", plugin: NAME, version: packageJson.version,
    runtimes: PROOF_PINS, files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(`${PREFIX}/`)).map(([name, bytes]) => [name, digest(bytes)])) }, null, 2)}\n`);
  const changes = Object.entries(files).map(([name, bytes]) => { const before = read(root, name); return { name, before, bytes, action: before?.equals(bytes) ? "unchanged" : before ? "update" : "create" }; });
  return { root, selector, changes, report: { name: NAME, version: packageJson.version, runtimes: PROOF_PINS,
    installed: owner ? "yes" : "no", configured: matches.length === 1 ? "yes" : "no",
    loaded: "unknown", approved: "unknown", observed: "unknown", providerDeclarations: [],
    plannedChanges: changes.map(({ name, action, bytes }) => ({ path: name, action, sha256: digest(bytes) })) } };
}

export function applyPlugin(plan) {
  const written = [];
  const lockPath = safePath(plan.root, ".hoklims-proof-install.lock");
  const token = randomUUID();
  let locked = false;
  try {
    try { writeFileSync(lockPath, token, { flag: "wx" }); locked = true; }
    catch { throw new Error("Another plugin installation or foreign lock is present; inspect the repository lock before retrying"); }
    for (const change of plan.changes) {
      const current = read(plan.root, change.name);
      if ((current === null) !== (change.before === null) || (current && !current.equals(change.before))) throw new Error(`Plugin inputs changed: ${change.name}`);
    }
    for (const change of plan.changes.filter(item => item.action !== "unchanged")) {
      const path = safePath(plan.root, change.name);
      mkdirSync(dirname(path), { recursive: true });
      if (change.before === null) writeFileSync(path, change.bytes, { flag: "wx" });
      else {
        const temp = `${path}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, change.bytes, { flag: "wx" }); renameSync(temp, path); }
        finally { if (existsSync(temp)) unlinkSync(temp); }
      }
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      const current = read(plan.root, change.name);
      if (!current?.equals(change.bytes)) continue;
      const path = safePath(plan.root, change.name);
      if (change.before === null) unlinkSync(path);
      else writeFileSync(path, change.before);
    }
    throw error;
  } finally {
    if (locked && read(plan.root, ".hoklims-proof-install.lock")?.toString("utf8") === token) unlinkSync(lockPath);
  }
  return { ...plan.report, installed: "yes", configured: "yes" };
}

function snapshotMatches(root, plan, cached = false) {
  const expected = plan.changes.filter(change => change.name.startsWith(`${PREFIX}/`));
  const directory = cached ? root : safePath(root, PREFIX);
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return false;
  const inventory = {};
  collect(directory, directory, cached ? "snapshot" : PREFIX, inventory);
  if (Object.keys(inventory).length !== expected.length) return false;
  return expected.every(change => {
    const name = cached ? change.name.slice(PREFIX.length + 1) : change.name;
    return inventory[cached ? `snapshot/${name}` : name]?.equals(change.bytes);
  });
}

async function nativeJson(rt, argv, root) {
  const result = await rt.exec(argv, root);
  if (result.code !== 0) throw new Error("Codex native plugin command failed; inspect its CLI and configuration before retrying");
  try { return JSON.parse(result.stdout); } catch { throw new Error("Codex returned an unsupported plugin report"); }
}

function nativeRealpath(rt, path) {
  // Native Codex serializes Win32 drive sources with the extended-path prefix.
  const local = process.platform === "win32" && /^\\\\\?\\[A-Za-z]:\\/u.test(path) ? path.slice(4) : path;
  const resolved = rt.realpath(local);
  return process.platform === "win32" && /^\\\\\?\\[A-Za-z]:\\/u.test(resolved) ? resolved.slice(4) : resolved;
}

function nativeMarketplaceRoot(rt, marketplaceRoot, marketplaceName) {
  const catalogBytes = read(marketplaceRoot, CATALOG);
  let catalog;
  try { catalog = JSON.parse(catalogBytes?.toString("utf8") ?? ""); }
  catch { throw new Error("Registered native marketplace has an invalid catalog"); }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || catalog.name !== marketplaceName || !Array.isArray(catalog.plugins)
    || catalog.plugins.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string")) throw new Error("Registered native marketplace catalog is unsupported");
  const matches = catalog.plugins.filter(entry => entry.name === NAME);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(marketplaceEntry())) throw new Error("Registered native marketplace has a foreign hoklims-proof source");
  const pluginRoot = safePath(marketplaceRoot, PREFIX);
  try { return { marketplaceRoot: rt.realpath(marketplaceRoot), pluginRoot: rt.realpath(pluginRoot) }; }
  catch { throw new Error("Registered native marketplace plugin source is unavailable"); }
}

export async function preflightNativePlugin(rt, root, plan, { upgradePlugin = false } = {}) {
  const marketplaceName = plan.selector.slice(NAME.length + 1);
  const inventory = await nativeJson(rt, ["codex", "plugin", "marketplace", "list", "--json"], root);
  const catalog = await nativeJson(rt, ["codex", "plugin", "list", "--marketplace", marketplaceName, "--available", "--json"], root);
  if (!Array.isArray(inventory.marketplaces) || !Array.isArray(catalog.installed) || !Array.isArray(catalog.available)) throw new Error("Codex plugin inventory is unsupported");
  const markets = inventory.marketplaces.filter(item => item.name === marketplaceName);
  if (markets.length > 1) throw new Error("Ambiguous native marketplace identity");
  let marketplaceRoot = root;
  let nativeSource = null;
  if (markets.length) {
    try { marketplaceRoot = rt.realpath(markets[0].root); } catch { throw new Error("Existing marketplace root is unavailable"); }
    if (marketplaceRoot !== root && !snapshotMatches(marketplaceRoot, plan)) throw new Error("A foreign or incompatible native marketplace already uses this name; preserve it and choose its source explicitly");
    nativeSource = nativeMarketplaceRoot(rt, marketplaceRoot, marketplaceName);
  }
  const selectedInstalled = catalog.installed.filter(item => item.pluginId === plan.selector || item.name === NAME);
  const selectedAvailable = catalog.available.filter(item => item.pluginId === plan.selector || item.name === NAME);
  const items = [...selectedInstalled, ...selectedAvailable];
  if (items.length > 1) throw new Error("Ambiguous native plugin identity");
  if (items.some(item => item.pluginId !== plan.selector || item.name !== NAME || item.marketplaceName !== marketplaceName
    || typeof item.enabled !== "boolean" || typeof item.version !== "string" || !/^(?:\d+\.\d+\.\d+|local)$/u.test(item.version))
    || selectedInstalled.some(item => item.installed !== true) || selectedAvailable.some(item => item.installed !== false)) throw new Error("Native plugin inventory has missing or unsupported identity fields");
  if (items.length && (!nativeSource || items.some(item => item.source?.source !== "local" || typeof item.source.path !== "string"
    || item.marketplaceSource?.sourceType !== "local" || typeof item.marketplaceSource.source !== "string"))) throw new Error("Native plugin inventory has missing or unsupported source identity");
  if (items.length) {
    try {
      if (items.some(item => nativeRealpath(rt, item.source.path) !== nativeSource.pluginRoot
        || nativeRealpath(rt, item.marketplaceSource.source) !== nativeSource.marketplaceRoot)) throw new Error("mismatch");
    } catch { throw new Error("Native plugin inventory source differs from its registered marketplace"); }
  }
  if (selectedAvailable.length) {
    let sourceManifest;
    try { sourceManifest = JSON.parse(read(nativeSource.pluginRoot, "plugin.json")?.toString("utf8") ?? ""); }
    catch { throw new Error("Native available plugin source manifest is invalid"); }
    if (!sourceManifest || typeof sourceManifest !== "object" || Array.isArray(sourceManifest) || sourceManifest.name !== NAME
      || typeof sourceManifest.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(sourceManifest.version)
      || selectedAvailable.some(item => item.version !== sourceManifest.version)) throw new Error("Native available plugin version differs from its physical source manifest");
  }
  const installed = selectedInstalled[0];
  if (items.some(item => item.enabled === false)) throw new Error("The native plugin is explicitly disabled; resolve its configuration before onboarding");
  {
    const cachedVersion = installed?.version ?? packageJson.version;
    if (typeof cachedVersion !== "string" || !/^(?:\d+\.\d+\.\d+|local)$/u.test(cachedVersion)) throw new Error("Native plugin version is unsupported");
    if (installed && cachedVersion !== packageJson.version && !upgradePlugin) throw new Error("Existing native plugin version differs; review --upgrade-plugin explicitly");
    const candidates = [...new Set([cachedVersion, packageJson.version, "local"])].map(version => ({ version,
      path: safePath(rt.realpath(rt.codexHome()), `plugins/cache/${marketplaceName}/${NAME}/${version}`) }));
    const present = candidates.filter(candidate => existsSync(candidate.path));
    if (present.length > 1 || (installed && present.length !== 1)) throw new Error("Native plugin cache identity cannot be established");
    if (installed && present.length === 1 && present[0].version !== cachedVersion && present[0].version !== "local") throw new Error("Native plugin cache identity cannot be established");
    if (present.length) {
      // Every accepted cache is a complete, byte-bound Devkit snapshot with the native version it declares.
      ownedSnapshot(present[0].path, plan.changes.filter(change => change.name.startsWith(`${PREFIX}/`) && change.name !== OWNER).map(change => change.name),
        { cached: true, nativeVersion: cachedVersion });
      if (!snapshotMatches(present[0].path, plan, true) && !upgradePlugin) throw new Error("Native cached plugin content differs; no implicit replacement is allowed");
    }
  }
  return { marketplaceRoot, registerMarketplace: markets.length === 0, selector: plan.selector, installed: Boolean(installed),
    plannedCommands: [...(markets.length ? [] : [["codex", "plugin", "marketplace", "add", root]]), ["codex", "plugin", "add", plan.selector, "--json"]] };
}

export async function installNativePlugin(rt, root, plan, native) {
  if (native.registerMarketplace) {
    const registered = await rt.exec(["codex", "plugin", "marketplace", "add", native.marketplaceRoot], root);
    if (registered.code !== 0) throw new Error("Codex could not register the planned local marketplace");
  }
  const installed = await nativeJson(rt, ["codex", "plugin", "add", plan.selector, "--json"], root);
  if (installed.pluginId !== plan.selector || installed.name !== NAME || installed.version !== packageJson.version || typeof installed.installedPath !== "string") throw new Error("Native plugin installation returned a foreign identity");
  const cache = rt.realpath(installed.installedPath);
  const home = rt.realpath(rt.codexHome());
  const expectedCaches = [packageJson.version, "local"].map(version => safePath(home, `plugins/cache/${plan.selector.slice(NAME.length + 1)}/${NAME}/${version}`));
  if (!expectedCaches.some(path => existsSync(path) && rt.realpath(path) === cache) || !snapshotMatches(cache, plan, true)) throw new Error("Native installed plugin bytes or cache identity differ from the planned snapshot");
  const verified = await preflightNativePlugin(rt, root, plan);
  let expectedMarketplaceRoot;
  try { expectedMarketplaceRoot = rt.realpath(native.marketplaceRoot); }
  catch { throw new Error("Native installed marketplace root could not be verified"); }
  if (!verified.installed || verified.registerMarketplace || verified.selector !== plan.selector
    || verified.marketplaceRoot !== expectedMarketplaceRoot) throw new Error("Native installed/enabled state could not be verified");
  return { ...plan.report, installed: "yes", configured: "yes", native: { pluginId: plan.selector, installedPath: cache, contentMatchesSnapshot: true } };
}
