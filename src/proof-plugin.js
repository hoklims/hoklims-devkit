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
    owner = JSON.parse(ownerBytes.toString("utf8"));
    if (owner.schemaVersion !== 1 || owner.owner !== "hoklims-devkit" || owner.plugin !== NAME
      || typeof owner.version !== "string" || !owner.files || Array.isArray(owner.files) || typeof owner.files !== "object") throw new Error("Unsupported plugin ownership record");
    for (const [name, expected] of Object.entries(owner.files)) {
      if (!name.startsWith(`${PREFIX}/`) || name === OWNER || typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("Invalid plugin ownership binding");
      const bytes = read(root, name);
      if (!bytes || digest(bytes) !== expected) throw new Error(`Owned plugin file was changed: ${name}`);
      if (!Object.hasOwn(files, name)) throw new Error(`Old plugin file needs an explicit migration: ${name}`);
    }
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
  const pluginEntry = { name: NAME, source: { source: "local", path: `./${PREFIX}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" };
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

export async function preflightNativePlugin(rt, root, plan, { upgradePlugin = false } = {}) {
  const marketplaceName = plan.selector.slice(NAME.length + 1);
  const inventory = await nativeJson(rt, ["codex", "plugin", "marketplace", "list", "--json"], root);
  const catalog = await nativeJson(rt, ["codex", "plugin", "list", "--marketplace", marketplaceName, "--available", "--json"], root);
  if (!Array.isArray(inventory.marketplaces) || !Array.isArray(catalog.installed) || !Array.isArray(catalog.available)) throw new Error("Codex plugin inventory is unsupported");
  const markets = inventory.marketplaces.filter(item => item.name === marketplaceName);
  if (markets.length > 1) throw new Error("Ambiguous native marketplace identity");
  let marketplaceRoot = root;
  if (markets.length) {
    try { marketplaceRoot = rt.realpath(markets[0].root); } catch { throw new Error("Existing marketplace root is unavailable"); }
    if (marketplaceRoot !== root && !snapshotMatches(marketplaceRoot, plan)) throw new Error("A foreign or incompatible native marketplace already uses this name; preserve it and choose its source explicitly");
  }
  const selectedInstalled = catalog.installed.filter(item => item.pluginId === plan.selector || item.name === NAME);
  const selectedAvailable = catalog.available.filter(item => item.pluginId === plan.selector || item.name === NAME);
  const items = [...selectedInstalled, ...selectedAvailable];
  if (items.length > 1) throw new Error("Ambiguous native plugin identity");
  if (items.some(item => item.pluginId !== plan.selector || item.name !== NAME || item.marketplaceName !== marketplaceName
    || typeof item.enabled !== "boolean" || typeof item.version !== "string" || !/^(?:\d+\.\d+\.\d+|local)$/u.test(item.version))
    || selectedInstalled.some(item => item.installed !== true) || selectedAvailable.some(item => item.installed !== false)) throw new Error("Native plugin inventory has missing or unsupported identity fields");
  const installed = selectedInstalled[0];
  if (installed?.enabled === false) throw new Error("The native plugin is explicitly disabled; resolve its configuration before onboarding");
  {
    const cachedVersion = installed?.version ?? packageJson.version;
    if (typeof cachedVersion !== "string" || !/^(?:\d+\.\d+\.\d+|local)$/u.test(cachedVersion)) throw new Error("Native plugin version is unsupported");
    if (installed && cachedVersion !== packageJson.version && !upgradePlugin) throw new Error("Existing native plugin version differs; review --upgrade-plugin explicitly");
    const candidates = [...new Set([cachedVersion, "local"])].map(version => safePath(rt.realpath(rt.codexHome()), `plugins/cache/${marketplaceName}/${NAME}/${version}`));
    const present = candidates.filter(path => existsSync(path));
    if (present.length > 1 || (installed && present.length !== 1)) throw new Error("Native plugin cache identity cannot be established");
    if (present.length && !snapshotMatches(present[0], plan, true)) {
      if (!upgradePlugin) throw new Error("Native cached plugin content differs; no implicit replacement is allowed");
      // Upgrade may replace only a complete, byte-bound prior Devkit snapshot.
      const owner = JSON.parse(readFileSync(join(present[0], "ownership.json"), "utf8"));
      if (owner.owner !== "hoklims-devkit" || owner.plugin !== NAME || owner.schemaVersion !== 1 || !owner.files) throw new Error("Native cached plugin has no valid ownership record");
      for (const [name, expected] of Object.entries(owner.files)) {
        if (!name.startsWith(`${PREFIX}/`) || !plan.changes.some(change => change.name === name) || !/^[a-f0-9]{64}$/u.test(expected)
          || digest(read(present[0], name.slice(PREFIX.length + 1)) ?? Buffer.alloc(0)) !== expected) throw new Error("Native cached plugin was modified; preserve the foreign edit");
      }
      const presentFiles = {}; collect(present[0], present[0], PREFIX, presentFiles);
      if (Object.keys(owner.files).length === 0 || Object.keys(presentFiles).some(name => name !== OWNER && !Object.hasOwn(owner.files, name))) throw new Error("Native cached plugin contains unowned files");
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
  const listed = await nativeJson(rt, ["codex", "plugin", "list", "--marketplace", plan.selector.slice(NAME.length + 1), "--json"], root);
  const matches = listed.installed?.filter(item => item.pluginId === plan.selector);
  if (matches?.length !== 1 || matches[0].installed !== true || matches[0].enabled !== true || matches[0].version !== packageJson.version) throw new Error("Native installed/enabled state could not be verified");
  return { ...plan.report, installed: "yes", configured: "yes", native: { pluginId: plan.selector, installedPath: cache, contentMatchesSnapshot: true } };
}
