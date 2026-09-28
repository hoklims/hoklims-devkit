import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { validComponentReport } from "./release-report.js";

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function snapshotTree(root) {
  if (!existsSync(root)) return [];
  const result = [];
  function walk(current, relative) {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = relative ? path.join(relative, name) : name;
      const info = lstatSync(full);
      const recordPath = rel.split(path.sep).join("/");
      if (info.isSymbolicLink()) {
        result.push({ path: recordPath, kind: "symlink", target: readlinkSync(full) });
      } else if (info.isDirectory()) {
        result.push({ path: recordPath, kind: "directory", mode: info.mode & 0o7777 });
        walk(full, rel);
      } else if (info.isFile()) {
        result.push({ path: recordPath, kind: "file", mode: info.mode & 0o7777, bytes: info.size, sha256: sha256File(full) });
      } else {
        result.push({ path: recordPath, kind: "other", mode: info.mode & 0o7777 });
      }
    }
  }
  walk(root, "");
  return result;
}

export function diffSnapshots(before, after) {
  const beforeMap = new Map();
  const afterMap = new Map();
  for (const [scope, records] of Object.entries(before)) {
    for (const record of records) beforeMap.set(`${scope}/${record.path}`, JSON.stringify(record));
  }
  for (const [scope, records] of Object.entries(after)) {
    for (const record of records) afterMap.set(`${scope}/${record.path}`, JSON.stringify(record));
  }
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys.filter((key) => beforeMap.get(key) !== afterMap.get(key))
    .map((key) => ({ path: key, before: beforeMap.get(key) ?? null, after: afterMap.get(key) ?? null }));
}

export function validateNativeReport(report, options) {
  const { projectRoot, command, hosts, names, versions, dryRun } = options;
  const doctor = command === "doctor";
  const planned = command === "setup" && dryRun;
  const expectedFlags = planned
    ? { installed: "unknown", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown" }
    : { installed: "yes", configured: "yes", loaded: "unknown", approved: "unknown", observed: "unknown" };
  assert(validComponentReport(report, projectRoot, names, {
    expectedState: doctor ? null : planned ? "planned" : "configured",
    expectedFlags,
    expectedCommand: command,
    expectedHosts: hosts,
  }), `${command}: invalid complete component report`);
  for (let index = 0; index < names.length; index += 1) {
    assert.equal(report.components[index].version, versions[names[index]], `${command}: ${names[index]} version`);
  }
  return report;
}
