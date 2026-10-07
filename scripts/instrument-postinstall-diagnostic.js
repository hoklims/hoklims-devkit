import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const file = join(process.argv[2], "node_modules/hoklims-devkit/src/runtime.js");
let source = readFileSync(file, "utf8");
const start = "      let child;";
if (!source.includes(start)) throw new Error("Exact runtime instrumentation anchor absent");
source = source.replace(start, `      if (process.env.HOKLIMS_DIAGNOSTIC_TRACE === "1") process.stderr.write("EXEC_STAGE " + JSON.stringify({argv,cwd}) + "\\n");
${start}`);
const end = "        return {\n          code: timedOut ? 5 : code,";
if (!source.includes(end)) throw new Error("Exact return instrumentation anchor absent");
source = source.replace(end, `        if (process.env.HOKLIMS_DIAGNOSTIC_TRACE === "1") {
          let report;
          try { const data=JSON.parse(stdout); report={schemaVersion:data.schemaVersion,kind:data.kind,repositoryRoot:data.repositoryRoot,hosts:data.hosts,verdict:data.verdict,analysisReady:data.analysisReady,setupReady:data.setupReady}; } catch {}
          process.stderr.write("EXEC_RESULT " + JSON.stringify({argv,code,report}) + "\\n");
        }
${end}`);
writeFileSync(file, source);
