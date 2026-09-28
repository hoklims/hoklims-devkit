import { readFileSync } from "node:fs";
import { EvidenceProviderManifestSchema, } from "./contracts/index.js";
/**
 * Read the source revision recorded by `scripts/write-build-info.ts`. A missing file, unreadable
 * JSON, or an invalid record stays UNKNOWN rather than borrowing the current checkout's revision.
 */
export function readSourceRevision(location) {
    try {
        const document = JSON.parse(readFileSync(location, "utf8"));
        const parsed = EvidenceProviderManifestSchema.shape.provider.shape.sourceRevision.safeParse(document.sourceRevision);
        return parsed.success ? parsed.data : { status: "UNKNOWN" };
    }
    catch {
        return { status: "UNKNOWN" };
    }
}
export const ASSERTLEDGER_SOURCE_REVISION = readSourceRevision(new URL("./build-info.json", import.meta.url));
//# sourceMappingURL=build-info.js.map