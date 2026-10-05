import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPlugin, pluginPlan, preflightNativePlugin, PROOF_PINS } from "../src/proof-plugin.js";

const fixtures = [];
function repo() { const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-plugin-"))); fixtures.push(root); return root; }
afterAll(() => { for (const root of fixtures) if (dirname(root) === realpathSync(tmpdir())) rmSync(root, { recursive: true, force: true }); });

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
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("Native cached plugin content differs");
  await expect(preflightNativePlugin(rt, root, plan, { upgradePlugin: true })).rejects.toThrow();
  expect(readFileSync(join(cache, "foreign"), "utf8")).toBe("preserved");
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
  await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("Native cached plugin content differs");
  expect(calls.some(argv => argv.includes("add"))).toBe(false);
  expect(readFileSync(join(cache, "hooks", "hooks.json"), "utf8")).toBe("{}");
});

test("missing native installation identity fields cannot become configured", async () => {
  const root = repo(), home = repo(), plan = pluginPlan(root);
  const complete = { pluginId: "hoklims-proof@hoklims-devkit", name: "hoklims-proof", marketplaceName: "hoklims-devkit", version: "0.1.0", installed: true, enabled: true };
  for (const field of ["enabled", "version", "installed"]) {
    const item = { ...complete }; delete item[field];
    const calls = [];
    const rt = { codexHome: () => home, realpath: realpathSync,
      exec: async argv => { calls.push(argv); return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("marketplace") ? { marketplaces: [] } : { installed: [item], available: [] }) }; } };
    await expect(preflightNativePlugin(rt, root, plan)).rejects.toThrow("missing or unsupported identity fields");
    expect(calls.some(argv => argv.includes("add"))).toBe(false);
    expect(existsSync(join(root, ".agents", "plugins", "hoklims-proof"))).toBe(false);
  }
});
