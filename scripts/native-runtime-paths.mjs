import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || argv1 === "-") return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.stdout.write(resolveBundledNpmCli(process.execPath));
