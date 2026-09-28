import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./native-runtime-paths.mjs";

export function buildNativeConfig(input) {
  const platform = input.platform ?? (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
  const config = {
    platform,
    runRoot: input.runRoot,
    sourceCheckout: input.sourceCheckout,
    artifact: {
      path: input.artifactPath,
      sha256: input.artifactSha256,
      sourceSha: input.sourceSha,
      version: input.version,
    },
    expected: {
      semctx: "0.3.7",
      semctxPublicationSha: input.semctxPublicationSha,
      assertledger: "1.3.0",
      codex: "0.147.0",
      claude: "2.1.229",
    },
    runtime: { npmCliJs: input.npmCliJs, bunExecutable: "bun", gitExecutable: "git" },
    allowAssertLedgerUnsafeDemo: true,
    ...(input.startupProbeOnly === true ? { startupProbeOnly: true } : {}),
  };
  assert(["windows", "linux", "macos"].includes(config.platform), "Unsupported native platform");
  for (const value of [config.runRoot, config.sourceCheckout, config.artifact.path, config.runtime.npmCliJs]) {
    assert(path.isAbsolute(value), `Native config path must be absolute: ${value}`);
  }
  assert.match(config.artifact.sha256, /^[0-9a-f]{64}$/u);
  assert.match(config.artifact.sourceSha, /^[0-9a-f]{40}$/u);
  assert.match(config.expected.semctxPublicationSha, /^[0-9a-f]{40}$/u);
  assert.equal(config.artifact.version, "0.1.0");
  return config;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const [output, runRoot, sourceCheckout, artifactPath, semctxPublicationSha, npmCliJs] = process.argv.slice(2);
  assert(output && runRoot && sourceCheckout && artifactPath && semctxPublicationSha && npmCliJs,
    "Usage: node native-no-lc-config.mjs OUTPUT RUN_ROOT SOURCE ARTIFACT SEMCTX_SHA NPM_CLI");
  const config = buildNativeConfig({
    runRoot, sourceCheckout, artifactPath, semctxPublicationSha, npmCliJs,
    artifactSha256: process.env.DEVKIT_SHA256,
    sourceSha: process.env.DEVKIT_SOURCE_SHA,
    version: process.env.DEVKIT_VERSION,
  });
  writeFileSync(output, `${JSON.stringify(config)}\n`);
}
