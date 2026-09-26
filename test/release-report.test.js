import { describe, expect, test } from "bun:test";
import { validComponentReport } from "../scripts/release-report.js";

const projectRoot = "/fixture/repository";
const expectedNames = ["semctx", "assertledger", "latent-compass"];

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
    expect(validComponentReport(report(components("planned")), projectRoot, expectedNames, {
      expectedState: "planned",
    })).toBe(true);
    expect(validComponentReport(report(components()), projectRoot, expectedNames, {
      expectedState: "configured",
      requireInstalledAndConfigured: true,
    })).toBe(true);
    expect(validComponentReport(report(components().map(({ state: _state, ...component }) => component)), projectRoot, expectedNames, {
      requireInstalledAndConfigured: true,
    })).toBe(true);
  });

  test("rejects empty, subset, superset, wrong, reordered, and duplicate component lists", () => {
    const exact = components();
    const cases = [
      [],
      exact.slice(0, -1),
      [...exact, { ...exact[0], name: "other" }],
      [{ ...exact[0], name: "wrong" }, ...exact.slice(1)],
      [exact[1], exact[0], exact[2]],
      [exact[0], exact[1], { ...exact[2], name: "assertledger" }],
    ];
    for (const candidate of cases) {
      expect(validComponentReport(report(candidate), projectRoot, expectedNames, {
        expectedState: "configured",
        requireInstalledAndConfigured: true,
      })).toBe(false);
    }
  });

  test("rejects false readiness flags, wrong state, and wrong project root", () => {
    const exact = components();
    expect(validComponentReport(report([{ ...exact[0], installed: "no" }, ...exact.slice(1)]), projectRoot, expectedNames, {
      requireInstalledAndConfigured: true,
    })).toBe(false);
    expect(validComponentReport(report([{ ...exact[0], configured: "unknown" }, ...exact.slice(1)]), projectRoot, expectedNames, {
      requireInstalledAndConfigured: true,
    })).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, expectedNames, { expectedState: "planned" })).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: "/wrong" }), projectRoot, expectedNames)).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: undefined }), projectRoot, expectedNames)).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: null }), projectRoot, expectedNames)).toBe(false);
    expect(validComponentReport(report(exact, { projectRoot: "" }), projectRoot, expectedNames)).toBe(false);
    expect(validComponentReport(report(exact), undefined, expectedNames)).toBe(false);
    expect(validComponentReport(report(exact), null, expectedNames)).toBe(false);
    expect(validComponentReport(report(exact), "", expectedNames)).toBe(false);
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
    for (const candidate of malformed) {
      expect(validComponentReport(candidate, projectRoot, expectedNames)).toBe(false);
    }
    expect(validComponentReport(report(exact), projectRoot, [])).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, ["semctx", "semctx"])).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, expectedNames, { expectedState: "partial" })).toBe(false);
    expect(validComponentReport(report(exact), projectRoot, expectedNames, {
      requireInstalledAndConfigured: "yes",
    })).toBe(false);
    for (const options of [null, [], "planned", new Date(0), Object.create(null)]) {
      expect(validComponentReport(report(exact), projectRoot, expectedNames, options)).toBe(false);
    }
  });

  test("rejects sparse component and expectation arrays", () => {
    const exact = components();
    const sparseComponents = [exact[0], , exact[2]];
    const sparseNames = [expectedNames[0], , expectedNames[2]];
    expect(validComponentReport(report(sparseComponents), projectRoot, expectedNames)).toBe(false);
    expect(validComponentReport(report(sparseComponents), projectRoot, sparseNames)).toBe(false);
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
