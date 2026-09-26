export function validComponentReport(report, projectRoot, expectedNames, options = {}) {
  try {
    if (!report || typeof report !== "object" || Array.isArray(report)) return false;
    if (typeof projectRoot !== "string" || projectRoot.length === 0) return false;
    if (report.ok !== true || typeof report.projectRoot !== "string"
      || report.projectRoot.length === 0 || report.projectRoot !== projectRoot) return false;
    if (!Array.isArray(expectedNames) || expectedNames.length === 0) return false;
    for (let index = 0; index < expectedNames.length; index += 1) {
      if (!Object.hasOwn(expectedNames, index)) return false;
      if (typeof expectedNames[index] !== "string" || expectedNames[index].length === 0) return false;
    }
    if (new Set(expectedNames).size !== expectedNames.length) return false;
    if (!Array.isArray(report.components) || report.components.length !== expectedNames.length) return false;
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype) return false;

    const { expectedState, requireInstalledAndConfigured = false } = options;
    if (expectedState !== undefined && expectedState !== "planned" && expectedState !== "configured") return false;
    if (typeof requireInstalledAndConfigured !== "boolean") return false;

    for (let index = 0; index < report.components.length; index += 1) {
      if (!Object.hasOwn(report.components, index)) return false;
      const component = report.components[index];
      if (!component || typeof component !== "object" || Array.isArray(component)) return false;
      if (component.name !== expectedNames[index]) return false;
      if (expectedState !== undefined && component.state !== expectedState) return false;
      if (requireInstalledAndConfigured
        && (component.installed !== "yes" || component.configured !== "yes")) return false;
    }
    return true;
  } catch {
    return false;
  }
}
