import { createHash } from "node:crypto";
import { NODE_TEST_REPORTER_SOURCE } from "../node-test-reporter.js";
export const NODE_TEST_ADAPTER_PROFILE = {
    profileId: "node-test",
    profileVersion: "1.0.0",
    official: true,
    reporterDigest: `sha256:${createHash("sha256").update(NODE_TEST_REPORTER_SOURCE).digest("hex")}`,
    capabilities: {
        detectsCollectionFailure: false,
        detectsCompileFailure: false,
        attributesPerAssertionFailure: true,
    },
};
//# sourceMappingURL=node-test-profile.js.map