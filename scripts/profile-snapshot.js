import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function snapshot(path) {
  let root;
  try {
    root = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (root.isSymbolicLink()) return { link: readlinkSync(path) };
  if (root.isFile()) return { file: Buffer.from(readFileSync(path)).toString("base64") };
  if (!root.isDirectory()) throw new Error(`Unexpected special file in smoke profile: ${path}`);
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return [entry.name, snapshot(child)];
    if (entry.isSymbolicLink()) return [entry.name, { link: readlinkSync(child) }];
    if (!entry.isFile()) throw new Error(`Unexpected special file in smoke profile: ${child}`);
    return [entry.name, Buffer.from(readFileSync(child)).toString("base64")];
  });
}

export function assertSnapshotUnchanged(paths, before, label) {
  if (JSON.stringify(paths.map(snapshot)) !== JSON.stringify(before)) {
    throw new Error(`${label} dry-run modified the host profile or devkit state`);
  }
}

export function protectedProfilePaths(profile) {
  return [
    join(profile, ".codex", "hooks.json"), join(profile, ".codex", "config.toml"),
    join(profile, ".codex", "plugins"), join(profile, ".codex", "marketplaces"),
    join(profile, ".claude", "settings.json"), join(profile, ".claude", "plugins"),
    join(profile, ".config"),
    join(profile, "uv-tools"), join(profile, "uv-bin"),
    join(profile, "uv-python"), join(profile, "uv-python-bin"),
    join(profile, "AppData", "Local", "hoklims-devkit"),
    join(profile, ".local", "state", "hoklims-devkit"),
  ];
}
