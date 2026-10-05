import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
import { applyPlugin, installNativePlugin, pluginPlan, preflightNativePlugin, PROOF_PINS } from "../src/proof-plugin.js";

const fixtures = [];
function repo() { const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-plugin-"))); fixtures.push(root); return root; }
afterAll(() => { for (const root of fixtures) if (dirname(root) === realpathSync(tmpdir())) rmSync(root, { recursive: true, force: true }); });

const prefix = ".agents/plugins/hoklims-proof/";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function writeSnapshot(destination, plan, version = "0.1.0", only = null) {
  const owned = {};
  for (const change of plan.changes.filter(item => item.name.startsWith(prefix) && !item.name.endsWith("/ownership.json"))) {
    if (only && !only.includes(change.name)) continue;
    const relative = change.name.slice(prefix.length);
    let bytes = change.bytes;
    if (version !== "0.1.0" && ["plugin.json", ".codex-plugin/plugin.json", "runtime/package.json"].includes(relative)) {
      const parsed = JSON.parse(bytes.toString("utf8"));
      parsed.version = version;
      bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
    }
    const path = join(destination, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    owned[change.name] = hash(bytes);
  }
  writeFileSync(join(destination, "ownership.json"), `${JSON.stringify({
    schemaVersion: 1, owner: "hoklims-devkit", plugin: "hoklims-proof", version,
    runtimes: PROOF_PINS, files: owned
  }, null, 2)}\n`);
}

function nativeItem(root, overrides = {}) {
  return { pluginId: "hoklims-proof@hoklims-devkit", name: "hoklims-proof", marketplaceName: "hoklims-devkit", version: "0.1.0", installed: true, enabled: true,
    source: { source: "local", path: join(root, ".agents", "plugins", "hoklims-proof") }, marketplaceSource: { sourceType: "local", source: toNamespacedPath(root) }, ...overrides };
}

function nativeRuntime(home, item, marketplaceRoot) {
  const calls = [];
  return { calls, rt: { codexHome: () => home, realpath: realpathSync,
    exec: async argv => { calls.push(argv); return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace")
      ? { marketplaces: [{ name: "hoklims-devkit", root: marketplaceRoot }] } : { installed: [item], available: [] }) }; } } };
}

function installRuntime(home, root, cache, readback) {
  const calls = [];
  return { calls, rt: { codexHome: () => home, realpath: realpathSync,
    exec: async argv => {
      calls.push(argv);
      if (argv.includes("marketplace")) return { code: 0, stderr: "", stdout: JSON.stringify({ marketplaces: [{ name: "hoklims-devkit", root }] }) };
      if (argv.includes("add")) return { code: 0, stderr: "", stdout: JSON.stringify({ pluginId: "hoklims-proof@hoklims-devkit", name: "hoklims-proof", marketplaceName: "hoklims-devkit", version: "0.1.0", installedPath: cache, authPolicy: "ON_INSTALL" }) };
      return { code: 0, stderr: "", stdout: JSON.stringify({ installed: [readback], available: [] }) };
    } } };
}

test("a repository plugin preserves foreign providers and has an idempotent owned snapshot", () => {
  const root = repo();
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  mkdirSync(join(root, ".codex"));
  const foreign = { name: "other", source: { source: "local", path: "./plugins/other" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" };
  writeFileSync(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "team", plugins: [foreign] }));
  const config = '[mcp_servers.assertledger]\ncommand = "node"\nargs = ["local-cli", "mcp"]\n';
  writeFileSync(join(root, ".codex", "config.toml"), config);
  const preview = pluginPlan(root);
  expect(preview.report.runtimes).toEqual(PROOF_PINS);
  expect(existsSync(join(root, ".agents", "plugins", "hoklims-proof"))).toBe(false);
  const applied = applyPlugin(preview);
  expect(applied.installed).toBe("yes");
  expect(applied.configured).toBe("yes");
  expect(applied.loaded).toBe("unknown");
  const catalog = JSON.parse(readFileSync(join(root, ".agents", "plugins", "marketplace.json")));
  expect(catalog.plugins[0]).toEqual(foreign);
  expect(catalog.plugins.filter(item => item.name === "hoklims-proof")).toHaveLength(1);
  const parsed = Bun.TOML.parse(readFileSync(join(root, ".codex", "config.toml"), "utf8"));
  expect(parsed.mcp_servers.assertledger.command).toBe("node");
  expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(config);
  const manifest = JSON.parse(readFileSync(join(root, ".agents", "plugins", "hoklims-proof", ".codex-plugin", "plugin.json")));
  expect(manifest.mcpServers).toBeUndefined();
  expect(manifest.hooks).toBeUndefined();
  expect(pluginPlan(root).changes.every(item => item.action === "unchanged")).toBe(true);
});

test("foreign, modified and linked plugin files are refused before writes", () => {
  const root = repo();
  const path = join(root, ".agents", "plugins", "hoklims-proof", "plugin.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "foreign");
  expect(() => pluginPlan(root)).toThrow("Foreign plugin file");
  expect(readFileSync(path, "utf8")).toBe("foreign");
  const owned = repo();
  applyPlugin(pluginPlan(owned));
  const skill = join(owned, ".agents", "plugins", "hoklims-proof", "skills", "proof-workflow", "SKILL.md");
  writeFileSync(skill, "user edit");
  expect(() => pluginPlan(owned, { upgradePlugin: true })).toThrow("Owned plugin file was changed");
  const linked = repo();
  symlinkSync(owned, join(linked, ".agents"), process.platform === "win32" ? "junction" : "dir");
  expect(() => pluginPlan(linked)).toThrow("Plugin path is a link");
});

test("a disabled plugin and a foreign identity cannot be enabled implicitly", () => {
  const root = repo();
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), '[plugins."hoklims-proof@hoklims-devkit"]\nenabled = false\n');
  expect(() => pluginPlan(root)).toThrow("explicitly disabled");
  const other = repo();
  mkdirSync(join(other, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(other, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "test", plugins: [{ name: "hoklims-proof", source: "./foreign" }] }));
  expect(() => pluginPlan(other)).toThrow("foreign marketplace entry");
});

test("changed preflight inputs cannot be overwritten", () => {
  const root = repo();
  const preview = pluginPlan(root);
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  const path = join(root, ".agents", "plugins", "marketplace.json");
  writeFileSync(path, "user change");
  expect(() => applyPlugin(preview)).toThrow("Plugin inputs changed");
  expect(readFileSync(path, "utf8")).toBe("user change");
  expect(existsSync(join(root, ".agents", "plugins", "hoklims-proof"))).toBe(false);
});

test("an apply failure restores prior files and a competing installation is refused", () => {
  const root = repo();
  mkdirSync(join(root, ".codex"));
  const original = 'user_setting = "preserved"\n';
  writeFileSync(join(root, ".codex", "config.toml"), original);
  const preview = pluginPlan(root);
  preview.changes.push({ name: ".codex/config.toml/unwritable", before: null, bytes: Buffer.from("fault"), action: "create" });
  expect(() => applyPlugin(preview)).toThrow();
  expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(original);
  expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(false);
  expect(existsSync(join(root, ".agents", "plugins", "hoklims-proof", "plugin.json"))).toBe(false);
  writeFileSync(join(root, ".hoklims-proof-install.lock"), "competing owner");
  expect(() => applyPlugin(pluginPlan(root))).toThrow("Another plugin installation");
  expect(readFileSync(join(root, ".hoklims-proof-install.lock"), "utf8")).toBe("competing owner");
});

test("a foreign native marketplace and an unregistered foreign cache stop onboarding", async () => {
  const root = repo(), other = repo(), home = repo();
  const plan = pluginPlan(root);
  const rt = { codexHome: () => home, realpath: realpathSync,
    exec: async argv => ({ code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace") ? { marketplaces: [{ name: "hoklims-devkit", root: other }] } : { installed: [], available: [] }) }) };
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("foreign or incompatible native marketplace");
  rt.exec = async argv => ({ code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace") ? { marketplaces: [] } : { installed: [], available: [] }) });
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, "foreign"), "preserved");
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("no ownership record");
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow();
  expect(readFileSync(join(cache, "foreign"), "utf8")).toBe("preserved");
});

test("matching plugin bytes cannot conceal a registered marketplace catalog with a foreign target", async () => {
  const root = repo(), other = repo(), home = repo(), plan = pluginPlan(root);
  writeSnapshot(join(other, ".agents", "plugins", "hoklims-proof"), plan);
  const catalogPath = join(other, ".agents", "plugins", "marketplace.json");
  const foreignPath = join(other, "foreign-payload");
  mkdirSync(foreignPath, { recursive: true });
  writeFileSync(join(foreignPath, "payload"), "preserved foreign payload");
  writeFileSync(catalogPath, `${JSON.stringify({ name: "hoklims-devkit", plugins: [{ name: "hoklims-proof", source: { source: "local", path: "./foreign-payload" } }] }, null, 2)}\n`);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(cache, plan);
  const item = { pluginId: "hoklims-proof@hoklims-devkit", name: "hoklims-proof", marketplaceName: "hoklims-devkit", version: "0.1.0", installed: true, enabled: true,
    source: { source: "local", path: foreignPath }, marketplaceSource: { sourceType: "local", source: other } };
  const calls = [];
  const rt = { codexHome: () => home, realpath: realpathSync,
    exec: async argv => { calls.push(argv); return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace")
      ? { marketplaces: [{ name: "hoklims-devkit", root: other }] } : { installed: [item], available: [] }) }; } };
  const before = { catalog: readFileSync(catalogPath, "utf8"), payload: readFileSync(join(foreignPath, "payload"), "utf8"), owner: readFileSync(join(cache, "ownership.json"), "utf8") };
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow();
  expect(calls.some(argv => argv.includes("add"))).toBe(false);
  expect({ catalog: readFileSync(catalogPath, "utf8"), payload: readFileSync(join(foreignPath, "payload"), "utf8"), owner: readFileSync(join(cache, "ownership.json"), "utf8") }).toEqual(before);
});

test("a compatible registered repository is reusable only with its bound native source identity", async () => {
  const root = repo(), other = repo(), home = repo(), plan = pluginPlan(root);
  mkdirSync(join(other, ".agents", "plugins"), { recursive: true });
  const provider = { name: "other", source: { source: "local", path: "./other" } };
  writeFileSync(join(other, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hoklims-devkit", plugins: [provider] }));
  applyPlugin(pluginPlan(other));
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(cache, plan);
  const item = nativeItem(other);
  const valid = nativeRuntime(home, item, other);
  await expect(preflightNativePlugin(valid.rt, root, plan)).resolves.toMatchObject({ marketplaceRoot: other, installed: true });
  const catalog = JSON.parse(readFileSync(join(other, ".agents", "plugins", "marketplace.json"), "utf8"));
  expect(catalog.plugins[0]).toEqual(provider);
  const wrongSource = nativeItem(other, { source: { source: "local", path: join(other, ".agents", "plugins") } });
  const invalid = nativeRuntime(home, wrongSource, other);
  const before = readFileSync(join(cache, "ownership.json"), "utf8");
  await expect(preflightNativePlugin(invalid.rt, root, plan)).rejects.toThrow("source differs from its registered marketplace");
  expect(invalid.calls.some(argv => argv.includes("add"))).toBe(false);
  expect(readFileSync(join(cache, "ownership.json"), "utf8")).toBe(before);
  const wrongMarketplace = nativeItem(other, { marketplaceSource: { sourceType: "local", source: root } });
  await expect(preflightNativePlugin(nativeRuntime(home, wrongMarketplace, other).rt, root, plan)).rejects.toThrow("source differs from its registered marketplace");
  expect(readFileSync(join(cache, "ownership.json"), "utf8")).toBe(before);
});

test("an available native version must match its inspected physical source manifest", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const available = nativeItem(root, { version: "9.9.9", installed: false });
  const calls = [];
  const rt = { codexHome: () => home, realpath: realpathSync,
    exec: async argv => { calls.push(argv); return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace")
      ? { marketplaces: [{ name: "hoklims-devkit", root }] } : { installed: [], available: [available] }) }; } };
  const before = readFileSync(join(root, ".agents", "plugins", "hoklims-proof", "plugin.json"), "utf8");
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow();
  expect(calls.some(argv => argv.includes("add"))).toBe(false);
  expect(readFileSync(join(root, ".agents", "plugins", "hoklims-proof", "plugin.json"), "utf8")).toBe(before);
});

test("an available prior version remains valid while its owned source is awaiting an explicit upgrade", async () => {
  const root = repo(), home = repo();
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "hoklims-devkit", plugins: [{ name: "hoklims-proof",
    source: { source: "local", path: "./.agents/plugins/hoklims-proof" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }));
  const initial = pluginPlan(root);
  writeSnapshot(join(root, ".agents", "plugins", "hoklims-proof"), initial, "0.0.9");
  const plan = pluginPlan(root, { upgradePlugin: true });
  const available = nativeItem(root, { version: "0.0.9", installed: false });
  const rt = { codexHome: () => home, realpath: realpathSync,
    exec: async argv => ({ code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace")
      ? { marketplaces: [{ name: "hoklims-devkit", root }] } : { installed: [], available: [available] }) }) };
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).resolves.toMatchObject({ installed: false, registerMarketplace: false });
});

test("an explicitly disabled available plugin cannot be enabled by onboarding", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const available = nativeItem(root, { installed: false, enabled: false });
  const calls = [];
  const rt = { codexHome: () => home, realpath: realpathSync,
    exec: async argv => { calls.push(argv); return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace")
      ? { marketplaces: [{ name: "hoklims-devkit", root }] } : { installed: [], available: [available] }) }; } };
  const before = readFileSync(join(root, ".agents", "plugins", "hoklims-proof", "ownership.json"));
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("explicitly disabled");
  expect(calls.some(argv => argv.includes("add"))).toBe(false);
  expect(readFileSync(join(root, ".agents", "plugins", "hoklims-proof", "ownership.json"))).toEqual(before);
});

test("matching native bytes cannot conceal an extra unowned cache file", async () => {
  const root = repo(), home = repo();
  const plan = pluginPlan(root);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  for (const change of plan.changes.filter(item => item.name.startsWith(".agents/plugins/hoklims-proof/"))) {
    const path = join(cache, change.name.slice(".agents/plugins/hoklims-proof/".length));
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, change.bytes);
  }
  mkdirSync(join(cache, "hooks")); writeFileSync(join(cache, "hooks", "hooks.json"), "{}");
  const calls = [];
  const rt = { codexHome: () => home, realpath: realpathSync,
    exec: async argv => { calls.push(argv); return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace") ? { marketplaces: [] } : { installed: [], available: [] }) }; } };
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("missing or unowned files");
  expect(calls.some(argv => argv.includes("add"))).toBe(false);
  expect(readFileSync(join(cache, "hooks", "hooks.json"), "utf8")).toBe("{}");
});

test("a truncated prior repository ownership inventory cannot be filled as installed", () => {
  const root = repo(), plan = pluginPlan(root);
  const plugin = join(root, ".agents", "plugins", "hoklims-proof");
  writeSnapshot(plugin, plan, "0.0.9", [`.agents/plugins/hoklims-proof/plugin.json`]);
  expect(() => pluginPlan(root, { upgradePlugin: true })).toThrow();
});

test("a complete supported prior repository snapshot can be upgraded explicitly", () => {
  const root = repo(), plan = pluginPlan(root);
  writeSnapshot(join(root, ".agents", "plugins", "hoklims-proof"), plan, "0.0.9");
  const upgrade = pluginPlan(root, { upgradePlugin: true });
  expect(upgrade.report.installed).toBe("yes");
  expect(upgrade.changes.some(item => item.action === "update")).toBe(true);
});

test("a same-version owned source refresh remains explicitly upgradeable", () => {
  const root = repo(), plan = pluginPlan(root);
  const plugin = join(root, ".agents", "plugins", "hoklims-proof");
  writeSnapshot(plugin, plan);
  const name = `.agents/plugins/hoklims-proof/skills/proof-workflow/references/evidence.md`;
  const path = join(plugin, name.slice(prefix.length));
  writeFileSync(path, "owned source refresh\n");
  const ownerPath = join(plugin, "ownership.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.files[name] = hash(readFileSync(path));
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  expect(pluginPlan(root, { upgradePlugin: true }).changes.find(item => item.name === name)?.action).toBe("update");
});

test("owned manifests and runtime pins must match the prior ownership record", () => {
  const root = repo(), plan = pluginPlan(root);
  const plugin = join(root, ".agents", "plugins", "hoklims-proof");
  writeSnapshot(plugin, plan, "0.0.9");
  const manifestName = `.agents/plugins/hoklims-proof/plugin.json`;
  const manifestPath = join(plugin, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "0.0.8";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const ownerPath = join(plugin, "ownership.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.files[manifestName] = hash(readFileSync(manifestPath));
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  expect(() => pluginPlan(root, { upgradePlugin: true })).toThrow("metadata version");
  manifest.version = "0.0.9";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  owner.files[manifestName] = hash(readFileSync(manifestPath));
  owner.runtimes.semctx = "9.9.9";
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  expect(() => pluginPlan(root, { upgradePlugin: true })).toThrow("runtime pins");
});

test("a truncated prior native cache cannot authorize replacement", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.0.9");
  writeSnapshot(cache, plan, "0.0.9", [`.agents/plugins/hoklims-proof/plugin.json`]);
  const installed = nativeItem(root, { version: "0.0.9" });
  const { rt } = nativeRuntime(home, installed, root);
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow();
});

test("a complete supported prior native cache can be replaced explicitly", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.0.9");
  writeSnapshot(cache, plan, "0.0.9");
  const installed = nativeItem(root, { version: "0.0.9" });
  const { rt } = nativeRuntime(home, installed, root);
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).resolves.toMatchObject({ installed: true });
});

test("the supported local cache alias can hold the installed prior owned snapshot", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "local");
  writeSnapshot(cache, plan, "0.0.9");
  const { rt } = nativeRuntime(home, nativeItem(root, { version: "0.0.9" }), root);
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).resolves.toMatchObject({ installed: true });
});

test("an explicit upgrade refuses a foreign current-version destination beside the intact old cache", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const oldCache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.0.9");
  const currentCache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(oldCache, plan, "0.0.9");
  mkdirSync(currentCache, { recursive: true });
  writeFileSync(join(currentCache, "foreign"), "preserved destination");
  const { rt } = nativeRuntime(home, nativeItem(root, { version: "0.0.9" }), root);
  const before = readFileSync(join(currentCache, "foreign"), "utf8");
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow("cache identity");
  expect(readFileSync(join(currentCache, "foreign"), "utf8")).toBe(before);
});

test("an old installed cache cannot be represented only by an old snapshot in the current-version directory", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const wrongLocation = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(wrongLocation, plan, "0.0.9");
  const { rt } = nativeRuntime(home, nativeItem(root, { version: "0.0.9" }), root);
  const before = readFileSync(join(wrongLocation, "ownership.json"), "utf8");
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow("cache identity");
  expect(readFileSync(join(wrongLocation, "ownership.json"), "utf8")).toBe(before);
});

test("a native declared version must match the prior ownership version", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.0.8");
  writeSnapshot(cache, plan, "0.0.9");
  const installed = nativeItem(root, { version: "0.0.8" });
  const { rt } = nativeRuntime(home, installed, root);
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow("version differs from its ownership record");
});

test("current snapshot bytes in an older native cache directory cannot bypass ownership version binding", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.0.9");
  writeSnapshot(cache, plan);
  const installed = nativeItem(root, { version: "0.0.9" });
  const { rt } = nativeRuntime(home, installed, root);
  const before = readFileSync(join(cache, "ownership.json"), "utf8");
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow("version differs from its ownership record");
  expect(readFileSync(join(cache, "ownership.json"), "utf8")).toBe(before);
});

async function expectMissingNativeIdentityRejected(field) {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(cache, plan);
  const complete = nativeItem(root);
  const valid = nativeRuntime(home, complete, root);
  await expect(preflightNativePlugin(valid.rt, root, plan)).resolves.toMatchObject({ installed: true });
  const malformed = { ...complete }; delete malformed[field];
  const invalid = nativeRuntime(home, malformed, root);
  const before = readFileSync(join(root, ".agents", "plugins", "hoklims-proof", "ownership.json"), "utf8");
  await expect(preflightNativePlugin(invalid.rt, root, plan)).rejects.toThrow("missing or unsupported identity fields");
  expect(invalid.calls.some(argv => argv.includes("add"))).toBe(false);
  expect(readFileSync(join(root, ".agents", "plugins", "hoklims-proof", "ownership.json"), "utf8")).toBe(before);
}

test("missing native enabled identity cannot become configured", async () => {
  await expectMissingNativeIdentityRejected("enabled");
});

test("missing native version identity cannot become configured", async () => {
  await expectMissingNativeIdentityRejected("version");
});

test("missing native installed identity cannot become configured", async () => {
  await expectMissingNativeIdentityRejected("installed");
});

async function expectMalformedPostInstallReadbackRejected(mutate) {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(cache, plan);
  const native = { marketplaceRoot: root, registerMarketplace: false, selector: plan.selector, installed: false };
  const validRuntime = installRuntime(home, root, cache, nativeItem(root));
  await expect(installNativePlugin(validRuntime.rt, root, plan, native)).resolves.toMatchObject({ installed: "yes", configured: "yes" });
  const malformed = mutate(nativeItem(root));
  const invalidRuntime = installRuntime(home, root, cache, malformed);
  const before = readFileSync(join(cache, "ownership.json"), "utf8");
  await expect(installNativePlugin(invalidRuntime.rt, root, plan, native)).rejects.toThrow();
  expect(readFileSync(join(cache, "ownership.json"), "utf8")).toBe(before);
}

test("post-install readback missing the plugin name cannot become configured", async () => {
  await expectMalformedPostInstallReadbackRejected(item => { delete item.name; return item; });
});

test("post-install readback missing the marketplace name cannot become configured", async () => {
  await expectMalformedPostInstallReadbackRejected(item => { delete item.marketplaceName; return item; });
});

test("post-install readback missing the plugin source cannot become configured", async () => {
  await expectMalformedPostInstallReadbackRejected(item => { delete item.source; return item; });
});

test("post-install readback with a foreign source cannot become configured", async () => {
  await expectMalformedPostInstallReadbackRejected(item => ({ ...item, source: { source: "local", path: dirname(item.source.path) } }));
});

test("post-install readback with the same name and a foreign plugin ID cannot become configured", async () => {
  await expectMalformedPostInstallReadbackRejected(item => ({ ...item, pluginId: "foreign@hoklims-devkit" }));
});

test("post-install readback cannot switch the retained marketplace root", async () => {
  const root = repo(), other = repo(), home = repo(), plan = pluginPlan(root);
  applyPlugin(plan);
  const cache = join(home, "plugins", "cache", "hoklims-devkit", "hoklims-proof", "0.1.0");
  writeSnapshot(cache, plan);
  const runtime = installRuntime(home, root, cache, nativeItem(root));
  const native = { marketplaceRoot: other, registerMarketplace: false, selector: plan.selector, installed: false };
  await expect(installNativePlugin(runtime.rt, root, plan, native)).rejects.toThrow("installed/enabled state");
});
