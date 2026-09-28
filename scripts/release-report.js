export function validComponentReport(report, projectRoot, expectedNames, options = {}) {
  try {
    if (!report || typeof report !== "object" || Array.isArray(report)) return false;
    if (typeof projectRoot !== "string" || projectRoot.length === 0) return false;
    if (report.schemaVersion !== 1 || report.ok !== true || typeof report.projectRoot !== "string"
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

    const { expectedState, expectedFlags, expectedCommand, expectedHosts } = options;
    if (!["setup", "doctor", "upgrade"].includes(expectedCommand)
      || report.command !== expectedCommand) return false;
    if (!Array.isArray(expectedHosts) || expectedHosts.length === 0
      || new Set(expectedHosts).size !== expectedHosts.length
      || expectedHosts.some((host) => !["codex", "claude"].includes(host))
      || JSON.stringify(report.hosts) !== JSON.stringify(expectedHosts)) return false;
    if (!Array.isArray(report.conflicts) || report.conflicts.length !== 0) return false;
    if (expectedState !== null && expectedState !== "planned" && expectedState !== "configured") return false;
    if (!expectedFlags || typeof expectedFlags !== "object" || Array.isArray(expectedFlags)
      || Object.getPrototypeOf(expectedFlags) !== Object.prototype) return false;
    const flagNames = ["installed", "configured", "loaded", "approved", "observed"];
    if (Object.keys(expectedFlags).length !== flagNames.length
      || flagNames.some((name) => !["yes", "no", "unknown"].includes(expectedFlags[name]))) return false;

    for (let index = 0; index < report.components.length; index += 1) {
      if (!Object.hasOwn(report.components, index)) return false;
      const component = report.components[index];
      if (!component || typeof component !== "object" || Array.isArray(component)) return false;
      if (component.name !== expectedNames[index]) return false;
      if (typeof component.version !== "string"
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(component.version)) return false;
      if (expectedState === null ? Object.hasOwn(component, "state") : component.state !== expectedState) return false;
      if (flagNames.some((name) => component[name] !== expectedFlags[name])) return false;
    }
    return true;
  } catch {
    return false;
  }
}
