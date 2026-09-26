import { describe, expect, test } from "bun:test";
import { validComponentReport } from "../scripts/release-report.js";

const projectRoot = "/fixture/repository";
const expectedNames = ["semctx", "assertledger", "latent-compass"];
const configuredFlags = { installed: "yes", configured: "yes", loaded: "unknown", approved: "unknown", observed: "unknown" };
const plannedFlags = { installed: "unknown", configured: "unknown", loaded: "unknown", approved: "unknown", observed: "unknown" };
const configuredOptions = { expectedState: "configured", expectedFlags: configuredFlags };

function report(components, overrides = {}) {
  return { ok: true, projectRoot, components, ...overrides };
}

function components(state = "configured") {
  return expectedNames.map((name) => ({
    name,
    state,
    installed: "yes",
    configured: "yes",
    loaded: "unknown",
    approved: "unknown",
    observed: "unknown",
  }));
}

describe("validComponentReport", () => {
  test("accepts exact planned, configured, and doctor reports", () => {
    const planned = components("planned").map((component) => ({
      ...component, installed: "unknown", configured: "unknown",
    }));
    expect(validComponentReport(report(planned), projectRoot, expectedNames, {
      expectedState: "planned",
      expectedFlags: plannedFlags,
    })).toBe(true);
    expect(validComponentReport(report(components()), projectRoot, expectedNames, configuredOptions)).toBe(true);
    expect(validComponentReport(report(components().map(({ state: _state, ...component }) => component)), projectRoot, expectedNames, {
      expectedState: null,
      expectedFlags: configuredFlags,
    })).toBe(true);
  });

  test("rejects planned reports without five flags and doctor reports with a plan state", () => {
    expect(validComponentReport(report([{ name: "semctx", state: "planned" }]), projectRoot, ["semctx"], {
      expectedState: "planned",
      expectedFlags: plannedFlags,
    })).toBe(false);
    expect(validComponentReport(report([{ ...components()[0], state: "planned" }]), projectRoot, ["semctx"], {
      expectedState: null,
      expectedFlags: configuredFlags,
    })).toBe(false);
  });

  test("rejects empty, subset, superset, wrong, reordered, and duplicate component lists", () => {
    const exact = components();
    expect(validComponentReport(report(exact), projectRoot, expectedNames, configuredOptions)).toBe(true);
    const cases = [
      [],
      exact.slice(0, -1),
      [...exact, { ...exact[0], name: "other" }],
      [{ ...exact[0], name: "wrong" }, ...exact.slice(1)],
      [exact[1], exact[0], exact[2]],
      [exact[0], exact[1], { ...exact[2], name: "assertledger" }],
    ];
    for (const candidate of cases) {
      expect(validComponentReport(report(candidate), projectRoot, expectedNames, configuredOptions)).toBe(false);
    }
  });

  test("rejects false readiness flags, wrong state, and wrong project root", () => {
    const exact = components();
    expect(validComponentReport(report(exact), projectRoot, expectedNames, configuredOptions)).toBe(true);
    expect(validComponentReport(report([{ ...exact[0], installed: "no" }, ...exact.slice(1)]), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report([{ ...exact[0], configured: "unknown" }, ...exact.slice(1)]), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, expectedNames, { expectedState: "planned", expectedFlags: configuredFlags })).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: "/wrong" }), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: undefined }), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: null }), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: "" }), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact), undefined, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact), null, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact), "", expectedNames, configuredOptions)).toBe(false);
  });

  test("rejects malformed reports, expectations, and options", () => {
    const exact = components();
    const malformed = [
      null,
      [],
      {},
      report(exact, { ok: false }),
      report(null),
      report([null, ...exact.slice(1)]),
    ];
    expect(validComponentReport(report(exact), projectRoot, expectedNames, configuredOptions)).toBe(true);
    for (const candidate of malformed) {
      expect(validComponentReport(candidate, projectRoot, expectedNames, configuredOptions)).toBe(false);
    }
    expect(validComponentReport(report(exact), projectRoot, [], configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, ["semctx", "semctx"], configuredOptions)).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, expectedNames, { expectedState: "partial", expectedFlags: configuredFlags })).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, expectedNames, {
      expectedState: "configured",
      expectedFlags: "yes",
    })).toBe(false);
    for (const options of [null, [], "planned", new Date(0), Object.create(null)]) {
      expect(validComponentReport(report(exact), projectRoot, expectedNames, options)).toBe(false);
    }
  });

  test("rejects sparse component and expectation arrays", () => {
    const exact = components();
    const sparseComponents = [exact[0], , exact[2]];
    const sparseNames = [expectedNames[0], , expectedNames[2]];
    expect(validComponentReport(report(exact), projectRoot, expectedNames, configuredOptions)).toBe(true);
    expect(validComponentReport(report(sparseComponents), projectRoot, expectedNames, configuredOptions)).toBe(false);
    expect(validComponentReport(report(sparseComponents), projectRoot, sparseNames, configuredOptions)).toBe(false);
  });

  test("rejects throwing option accessors without propagating the exception", () => {
    const throwingOptions = {};
    Object.defineProperty(throwingOptions, "expectedState", {
      get() { throw new Error("boom"); },
    });
    let result;
    expect(() => { result = validComponentReport(report(components()), projectRoot, expectedNames, throwingOptions); }).not.toThrow();
    expect(result).toBe(false);
  });
});
