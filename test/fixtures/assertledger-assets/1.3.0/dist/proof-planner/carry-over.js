import { compareOrdinal, sortedUnique } from "./model.js";
import { isUnresolvedSignal, } from "./plan.js";
export function carryOverEvidence(previous, next) {
    const reusable = [];
    const mustProduce = [];
    const sameBaseline = previous.subject.baseline === next.subject.baseline;
    const sameRevision = previous.subject.revision === next.subject.revision;
    const runtimeTree = sameRuntimeTree(previous, next);
    // Evidence is not reused on the surfaces that an unresolved signal may concern, read in both
    // plans: across revisions, one observed beside it or one the next plan observes; within one
    // revision, only an observation the previous plan did not already have, since evidence produced
    // beside an observation answers it. The planner uses the same notion of "unresolved".
    const previousUnresolved = previous.signals.filter(isUnresolvedSignal);
    const answered = new Set(previousUnresolved.map(observationKey));
    const unresolved = [
        ...(sameRevision ? [] : previousUnresolved),
        ...next.signals.filter((signal) => isUnresolvedSignal(signal) && !(sameRevision && answered.has(observationKey(signal)))),
    ].map((signal) => ({ id: signal.id, surfaces: concernedInEither(previous, next, signal) }));
    const unresolvedOn = (surface) => {
        const blocking = unresolved.filter((entry) => surface === null || entry.surfaces === null || entry.surfaces.has(surface));
        return blocking.length > 0
            ? `a signal is unresolved (${sortedUnique(blocking.map((entry) => entry.id)).join(", ")})`
            : null;
    };
    // Evidence that answers observations answers only those it was produced for.
    const answersOther = (requirement, earlier, surface) => {
        const seen = observationsBehind(previous, earlier, surface);
        const behind = observationsBehind(next, requirement, surface);
        if (seen === null || behind === null)
            return "an observation behind it is not in the plan";
        return [...behind].some((key) => !seen.has(key))
            ? "it answers an observation the earlier evidence did not"
            : null;
    };
    for (const requirement of next.requiredEvidence) {
        const earlier = previous.requiredEvidence.find((candidate) => candidate.kind === requirement.kind &&
            candidate.semanticDigest === requirement.semanticDigest);
        const entry = (surfaces, reason) => ({
            kind: requirement.kind,
            binding: requirement.binding,
            surfaces: sortedUnique(surfaces),
            reason,
        });
        if (!earlier) {
            mustProduce.push(entry(requirement.surfaces, "not required with the same meaning before"));
            continue;
        }
        if (!sameBaseline) {
            mustProduce.push(entry(requirement.surfaces, "the merge-base changed"));
            continue;
        }
        if (requirement.binding === "runtime-tree") {
            const blocker = runtimeTree
                ? (unresolvedOn(null) ?? answersOther(requirement, earlier, null))
                : "runtime tree changed or unknown";
            if (blocker === null)
                reusable.push(entry(requirement.surfaces, "runtime tree unchanged"));
            else
                mustProduce.push(entry(requirement.surfaces, blocker));
            continue;
        }
        // Revision-wide evidence: exact-revision kinds, a property of the revision itself, and
        // surface-content kinds without a scope, which a new observation can still contradict.
        if (requirement.binding === "exact-revision" || requirement.surfaces.length === 0) {
            const blocker = !sameRevision
                ? "bound to the exact revision"
                : requirement.binding === "exact-revision"
                    ? null
                    : (unresolvedOn(null) ?? answersOther(requirement, earlier, null));
            if (blocker === null)
                reusable.push(entry(requirement.surfaces, "same revision"));
            else
                mustProduce.push(entry(requirement.surfaces, blocker));
            continue;
        }
        const kept = [];
        const changed = new Map();
        for (const surface of requirement.surfaces) {
            const reason = surfaceReuseBlocker(previous, next, requirement, earlier, surface, runtimeTree) ??
                unresolvedOn(surface) ??
                answersOther(requirement, earlier, surface);
            if (reason === null)
                kept.push(surface);
            else
                changed.set(reason, [...(changed.get(reason) ?? []), surface]);
        }
        if (kept.length > 0)
            reusable.push(entry(kept, "scoped surfaces and their tests unchanged"));
        for (const [reason, surfaces] of changed)
            mustProduce.push(entry(surfaces, reason));
    }
    const order = (left, right) => compareOrdinal(`${left.kind}|${left.reason}`, `${right.kind}|${right.reason}`);
    return {
        previousRevision: previous.subject.revision,
        nextRevision: next.subject.revision,
        reusable: reusable.sort(order),
        mustProduce: mustProduce.sort(order),
    };
}
/**
 * Surfaces an unresolved signal may concern, or null for all of them. A failing proof surface
 * concerns what it exercises; a failure that cannot be mapped, an execution context, or a proof
 * surface that does not list what it exercises, concerns everything.
 */
function concernedSurfaces(plan, signal) {
    if (signal.surfaces.length === 0)
        return null;
    const concerned = new Set(signal.surfaces);
    for (const id of signal.surfaces) {
        const known = plan.subject.surfaces.find((entry) => entry.id === id);
        if (!known || known.role === "execution-context")
            return null;
        if (known.role !== "test" && known.role !== "proof-infrastructure")
            continue;
        if (known.exercises === null)
            return null;
        for (const exercised of known.exercises)
            concerned.add(exercised);
    }
    return concerned;
}
/** What a signal may concern in either plan: everything as soon as one of them cannot map it. */
function concernedInEither(previous, next, signal) {
    const before = concernedSurfaces(previous, signal);
    const after = concernedSurfaces(next, signal);
    // Where the two sets differ, what exercises that surface changed, which blocks reuse on its own.
    return before === null || after === null ? null : new Set([...before, ...after]);
}
/** One observation: evidence produced for one report never answers another. */
function observationKey(signal) {
    return JSON.stringify([
        signal.id,
        signal.revision,
        signal.signal,
        signal.classification,
        signal.exercises,
        [...signal.basis].sort(),
        [...signal.surfaces].sort(),
    ]);
}
/**
 * Observations behind a requirement on a surface, or behind all of it for null. Null when a fact
 * names a signal the plan does not list, since what it observed cannot be compared.
 */
function observationsBehind(plan, requirement, surface) {
    const keys = new Set();
    for (const fact of plan.facts) {
        if (!fact.id.startsWith("observed:") || !requirement.because.includes(fact.id))
            continue;
        // A fact merges the surfaces of every signal behind it: scope each observation by its own.
        for (const ref of fact.refs) {
            const signal = plan.signals.find((entry) => entry.id === ref);
            if (!signal)
                return null;
            const scope = signal.surfaces;
            if (surface !== null && scope.length > 0 && !scope.includes(surface))
                continue;
            keys.add(observationKey(signal));
        }
    }
    return keys;
}
function sameRuntimeTree(previous, next) {
    const before = previous.subject.runtimeTreeDigest;
    const after = next.subject.runtimeTreeDigest;
    return before !== null && after !== null && before === after;
}
/**
 * Only documentation-only evidence about a surface both plans call documentation ignores the
 * runtime tree. A gate delta review justifies a budget with durations measured on the code the
 * gate runs, and a documentation claim scoped to a runtime surface describes its behavior.
 */
function dependsOnRuntimeTree(requirement, before, after) {
    return (before.role !== "documentation" ||
        after.role !== "documentation" ||
        !requirement.subjects.every((subject) => subject === "documentation"));
}
function surfaceReuseBlocker(previous, next, requirement, earlier, surface, runtimeTree) {
    if (!earlier.surfaces.includes(surface))
        return "surface newly in scope";
    const before = previous.subject.surfaces.find((entry) => entry.id === surface);
    const after = next.subject.surfaces.find((entry) => entry.id === surface);
    if (!before?.contentDigest || !after?.contentDigest)
        return "surface digest unknown";
    if (before.contentDigest !== after.contentDigest)
        return "surface content changed";
    if (dependsOnRuntimeTree(requirement, before, after) && !runtimeTree) {
        return "runtime tree changed or unknown";
    }
    const testsBefore = exercisers(previous.subject.surfaces, surface);
    const testsAfter = exercisers(next.subject.surfaces, surface);
    const key = (tests) => tests.map((test) => `${test.id}=${test.contentDigest ?? "unknown"}`).join("|");
    if ([...testsBefore, ...testsAfter].some((test) => test.contentDigest === null) ||
        key(testsBefore) !== key(testsAfter)) {
        return "a test or proof surface exercising the surface changed";
    }
    return null;
}
/**
 * Proof surfaces that exercise `surface`: a test without an `exercises` list exercises everything;
 * a proof-infrastructure surface counts where it names the surface.
 */
function exercisers(surfaces, surface) {
    return surfaces
        .filter((entry) => (entry.role === "test" &&
        (entry.exercises === null || entry.exercises.includes(surface))) ||
        (entry.role === "proof-infrastructure" &&
            entry.exercises !== null &&
            entry.exercises.includes(surface)))
        .sort((left, right) => compareOrdinal(left.id, right.id));
}
//# sourceMappingURL=carry-over.js.map