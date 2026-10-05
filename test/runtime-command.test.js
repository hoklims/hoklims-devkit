import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { resolveToolCommand } from "../src/runtime.js";

test("Windows npm and Codex shims use their native JavaScript entrypoints without shell quoting", () => {
  const prefix = join("native tools", "with spaces");
  const which = name => join(prefix, name === "node" ? "node.exe" : `${name}.cmd`);
  const args = ["npm", "exec", "--package=assertledger@1.4.0", "--", "assertledger", "setup", "repo & scope", "--json"];
  expect(resolveToolCommand(args, "win32", which, () => true)).toEqual([which("node"), join(dirname(which("npm")), "node_modules", "npm", "bin", "npm-cli.js"), ...args.slice(1)]);
  expect(resolveToolCommand(["codex", "plugin", "list", "--json"], "win32", which, () => true).slice(0, 2)).toEqual([which("node"), join(dirname(which("codex")), "node_modules", "@openai", "codex", "bin", "codex.js")]);
  expect(resolveToolCommand(args, "linux", which, () => true)).toBe(args);
  expect(() => resolveToolCommand(args, "win32", which, () => false)).toThrow("JavaScript entrypoint");
});
