#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "hoklims-devkit";
const LOCK_ENTRY = `node_modules/${PACKAGE_NAME}`;

export function validatePublicInstall(consumer, version, expectedIntegrity, registry) {
  assert(path.isAbsolute(consumer), "public consumer path must be absolute");
  assert(/^\d+\.\d+\.\d+$/u.test(version), "public package version is invalid");
  const integrityMatch = expectedIntegrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/u);
  const integrityBytes = integrityMatch ? Buffer.from(integrityMatch[1], "base64") : null;
  assert(integrityBytes?.length === 64 && integrityBytes.toString("base64") === integrityMatch[1],
    "built package integrity is not a canonical SHA-512 SRI");
  assert.equal(registry, "https://registry.npmjs.org", "public package registry is not the intended npm registry");
  const manifest = JSON.parse(readFileSync(path.join(consumer, "node_modules", PACKAGE_NAME, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(consumer, "package-lock.json"), "utf8"));
  const installed = lock?.packages?.[LOCK_ENTRY];
  const expectedResolved = `${registry}/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`;
  assert.equal(manifest?.name, PACKAGE_NAME, "installed public package name differs");
  assert.equal(manifest?.version, version, "installed public package version differs");
  assert.equal(installed?.version, version, "public lock entry version differs");
  assert.equal(installed?.resolved, expectedResolved, "public lock entry resolved source differs");
  assert.equal(installed?.integrity, expectedIntegrity, "public lock entry integrity differs from the built tarball");
  return true;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); } catch { return false; }
}

if (isMain()) {
  assert.equal(process.argv.length, 6,
    "Usage: node public-install-integrity.mjs ABSOLUTE_CONSUMER VERSION SHA512_INTEGRITY https://registry.npmjs.org");
  validatePublicInstall(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
}
