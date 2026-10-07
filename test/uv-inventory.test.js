import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";
import { snapshot } from "../scripts/profile-snapshot.js";

for (const mode of ["absent", "empty", "initialized", "linked-lock", "linked-store", "relative", "unknown"]) {
  test(`real filesystem uv inventory refuses unsafe/uninitialized stores: ${mode}`, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "devkit-uv-inventory-")));
    const store = join(home, "uv-tools"), outside = join(home, "outside");
    try {
      if (!["absent", "relative", "unknown"].includes(mode)) mkdirSync(store);
      if (mode === "initialized") writeFileSync(join(store, ".lock"), "sentinel lock bytes");
      if (mode === "linked-lock") { writeFileSync(outside, "preserved"); symlinkSync(outside, join(store, ".lock")); }
      if (mode === "linked-store") { rmSync(store, { recursive: true }); mkdirSync(outside); symlinkSync(outside, store, "junction"); }
      const before = snapshot(home), calls = [], rt = createRuntime();
      rt.exec = async argv => {
        calls.push(argv);
        if (argv.includes("dir")) return { code: mode === "unknown" ? 5 : 0, stdout: mode === "relative" ? "relative-store\n" : store + "\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "No tools installed\n" };
      };
      expect(typeof rt.uvToolInventory).toBe("function");
      const result = await rt.uvToolInventory(home);
      expect(result.code).toBe(["absent", "initialized"].includes(mode) ? 0 : 3);
      expect(calls.some(argv => argv.includes("list"))).toBe(mode === "initialized");
      expect(snapshot(home)).toEqual(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test("safe uv inventory keeps malformed native output visible", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "devkit-uv-malformed-")));
  try {
    writeFileSync(join(home, ".lock"), "");
    const rt = createRuntime();
    rt.exec = async argv => argv.includes("dir") ? { code: 0, stdout: home, stderr: "" } : { code: 0, stdout: "malformed inventory", stderr: "" };
    expect((await rt.uvToolInventory(home)).stdout).toBe("malformed inventory");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const mode of ["absent", "empty", "initialized"]) test(`native uv inventory preserves profile bytes: ${mode}`, async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "devkit-uv-native-")));
  const home = join(fixture, "home"); mkdirSync(home);
  try {
    const store = join(home, "uv-tools");
    if (mode !== "absent") mkdirSync(store);
    if (mode === "initialized") writeFileSync(join(store, ".lock"), "");
    const rt = createRuntime(), calls = [];
    rt.exec = async argv => {
      calls.push(argv);
      // Match the production smoke: disposable cache is outside protected HOME.
      const result = Bun.spawnSync(argv, { env: { ...process.env, HOME: home, USERPROFILE: home, UV_TOOL_DIR: store, UV_CACHE_DIR: join(fixture, "cache"), UV_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    };
    const before = snapshot(home);
    expect((await rt.uvToolInventory(home)).code).toBe(mode === "empty" ? 3 : 0);
    expect(calls).toEqual(mode === "initialized" ? [["uv", "tool", "dir"], ["uv", "tool", "list"]] : [["uv", "tool", "dir"]]);
    expect(snapshot(home)).toEqual(before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
