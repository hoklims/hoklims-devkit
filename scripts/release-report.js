export function validComponentReport(report, projectRoot, expectedNames, options = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return false;
  if (report.ok !== true || typeof report.projectRoot !== "string"
    || report.projectRoot.length === 0 || report.projectRoot !== projectRoot) return false;
  if (!Array.isArray(expectedNames) || expectedNames.length === 0) return false;
  if (expectedNames.some((name) => typeof name !== "string" || name.length === 0)) return false;
  if (new Set(expectedNames).size !== expectedNames.length) return false;
  if (!Array.isArray(report.components) || report.components.length !== expectedNames.length) return false;
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype) return false;

  const { expectedState, requireInstalledAndConfigured = false } = options;
  if (expectedState !== undefined && expectedState !== "planned" && expectedState !== "configured") return false;
  if (typeof requireInstalledAndConfigured !== "boolean") return false;

  return report.components.every((component, index) => {
    if (!component || typeof component !== "object" || Array.isArray(component)) return false;
    if (component.name !== expectedNames[index]) return false;
    if (expectedState !== undefined && component.state !== expectedState) return false;
    if (requireInstalledAndConfigured
      && (component.installed !== "yes" || component.configured !== "yes")) return false;
    return true;
  });
}
