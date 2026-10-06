import { createHash } from "node:crypto";
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
  if (root.isFile()) return { file: Buffer.from(readFileSync(path)).toString("base64"), mode: root.mode & 0o7777 };
  if (!root.isDirectory()) throw new Error(`Unexpected special file in smoke profile: ${path}`);
  return {
    mode: root.mode & 0o7777,
    entries: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]),
  };
}

export function assertSnapshotUnchanged(paths, before, label) {
  const after = paths.map(snapshot);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const changes = [];
    const summarize = value => value?.file !== undefined
      ? { kind: "file", bytes: Buffer.from(value.file, "base64").length,
          sha256: createHash("sha256").update(Buffer.from(value.file, "base64")).digest("hex"), mode: value.mode }
      : value?.link !== undefined ? { kind: "link", targetSha256: createHash("sha256").update(value.link).digest("hex") }
      : value === null || value === undefined ? { kind: "absent" } : { kind: "directory", mode: value.mode };
    function compare(path, oldValue, newValue) {
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
      if (!oldValue?.entries || !newValue?.entries || oldValue.mode !== newValue.mode) {
        changes.push({ path, before: summarize(oldValue), after: summarize(newValue) });
      }
      if (oldValue?.entries || newValue?.entries) {
        const a = new Map(oldValue?.entries ?? []), b = new Map(newValue?.entries ?? []);
        for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) compare(join(path, name), a.get(name), b.get(name));
      }
    }
    paths.forEach((path, index) => compare(path, before[index], after[index]));
    throw new Error(`${label} dry-run modified the host profile or devkit state\nPROFILE_SNAPSHOT_DIFF ${JSON.stringify(changes)}`);
  }
}

export function protectedProfilePaths(profile) {
  return [
    join(profile, ".codex"), join(profile, ".claude"),
    join(profile, ".config"),
    join(profile, "uv-tools"), join(profile, "uv-bin"),
    join(profile, "uv-python"), join(profile, "uv-python-bin"),
    join(profile, "AppData", "Local", "hoklims-devkit"),
    join(profile, ".local", "state", "hoklims-devkit"),
  ];
}
