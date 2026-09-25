import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function snapshot(path) {
  if (!existsSync(path)) return null;
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return [entry.name, snapshot(child)];
    if (!entry.isFile()) throw new Error(`Unexpected link or special file in smoke profile: ${child}`);
    return [entry.name, Buffer.from(readFileSync(child)).toString("base64")];
  });
}

export function assertSnapshotUnchanged(paths, before, label) {
  if (JSON.stringify(paths.map(snapshot)) !== JSON.stringify(before)) {
    throw new Error(`${label} dry-run modified the host profile or devkit state`);
  }
}
