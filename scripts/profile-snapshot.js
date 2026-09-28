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
  if (JSON.stringify(paths.map(snapshot)) !== JSON.stringify(before)) {
    throw new Error(`${label} dry-run modified the host profile or devkit state`);
  }
}

export function protectedProfilePaths(profile) {
  return [profile];
}
