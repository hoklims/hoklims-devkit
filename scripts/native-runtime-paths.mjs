import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function bundledNpmCliCandidates(nodeExecutable, platform = process.platform) {
  const bin = path.dirname(path.resolve(nodeExecutable));
  return platform === "win32"
    ? [path.join(bin, "node_modules", "npm", "bin", "npm-cli.js")]
    : [
      path.resolve(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    ];
}

export function resolveBundledNpmCli(nodeExecutable, platform = process.platform) {
  const candidate = bundledNpmCliCandidates(nodeExecutable, platform).find(existsSync);
  if (!candidate) throw new Error(`Bundled npm CLI not found beside Node: ${nodeExecutable}`);
  return realpathSync(candidate);
}

if (import.meta.main) process.stdout.write(resolveBundledNpmCli(process.execPath));
