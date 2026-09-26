import { assertSnapshotUnchanged } from "./profile-snapshot.js";

function componentVersions(report, label) {
  if (!report || Array.isArray(report) || typeof report !== "object"
    || !Array.isArray(report.components) || report.components.length === 0) {
    throw new Error(`${label} has no comparable component versions`);
  }
  const entries = report.components.map((component) => {
    if (!component || Array.isArray(component) || typeof component !== "object"
      || typeof component.name !== "string" || !component.name
      || typeof component.version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(component.version)) {
      throw new Error(`${label} has an invalid component version`);
    }
    return [component.name, component.version];
  });
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new Error(`${label} has duplicate components`);
  }
  return entries;
}

export function assertNoopUpgradeUnchanged(paths, before, installedReport, upgradePlan, label) {
  const installed = componentVersions(installedReport, "installed report");
  const planned = componentVersions(upgradePlan, "upgrade plan");
  if (JSON.stringify(installed.map(([name]) => name)) !== JSON.stringify(planned.map(([name]) => name))) {
    throw new Error("Upgrade plan component selection differs from the installed report");
  }
  const sameVersions = installed.every(([, version], index) => planned[index][1] === version);
  if (sameVersions) assertSnapshotUnchanged(paths, before, label);
  return sameVersions;
}
