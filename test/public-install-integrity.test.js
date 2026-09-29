import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePublicInstall } from "../scripts/public-install-integrity.mjs";

const VERSION = "0.1.1";
const REGISTRY = "https://registry.npmjs.org";
const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const INTEGRITY = sri("built archive");

function fixture({ integrity = INTEGRITY, resolved = `${REGISTRY}/hoklims-devkit/-/hoklims-devkit-${VERSION}.tgz` } = {}) {
  const consumer = mkdtempSync(join(tmpdir(), "devkit-public-integrity-"));
  const installed = join(consumer, "node_modules", "hoklims-devkit");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "hoklims-devkit", version: VERSION }));
  writeFileSync(join(consumer, "package-lock.json"), JSON.stringify({
    name: "consumer", lockfileVersion: 3, packages: {
      "": { name: "consumer" },
      "node_modules/hoklims-devkit": { version: VERSION, resolved, integrity },
    },
  }));
  return consumer;
}

test("public installation accepts the exact built integrity from the intended registry", () => {
  expect(validatePublicInstall(fixture(), VERSION, INTEGRITY, REGISTRY)).toBe(true);
});

test("same-version alternate bytes and registry sources stop before public CLI or release", () => {
  for (const consumer of [
    fixture({ integrity: sri("other archive") }),
    fixture({ resolved: `https://registry.example.invalid/hoklims-devkit/-/hoklims-devkit-${VERSION}.tgz` }),
  ]) {
    let cliCalls = 0;
    let releaseCalls = 0;
    expect(() => {
      validatePublicInstall(consumer, VERSION, INTEGRITY, REGISTRY);
      cliCalls += 1;
      releaseCalls += 1;
    }).toThrow();
    expect(cliCalls).toBe(0);
    expect(releaseCalls).toBe(0);
  }
});

test("malformed and noncanonical SHA-512 integrity values are refused", () => {
  for (const integrity of ["sha512-YnVpbHQgYXJjaGl2ZQ==", "sha512-not+canonical===", "sha256-deadbeef"]) {
    expect(() => validatePublicInstall(fixture(), VERSION, integrity, REGISTRY)).toThrow(/canonical SHA-512 SRI/u);
  }
});
