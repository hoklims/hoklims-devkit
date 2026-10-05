# Coverage map: apply each single mutation, run test files, list failing tests, restore.
import subprocess, re, sys, json
W="/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-G-native-reports"
A="src/app.js"; R="src/runtime.js"
M = [
 ("id_compass_status_op", A, 'parsed?.schema_version !== 1 || parsed.operation !== "status" || ', 'parsed?.schema_version !== 1 || '),
 ("id_compass_status_schema", A, 'parsed?.schema_version !== 1 || parsed.operation', 'parsed.operation'),
 ("id_compass_install_op", A, 'parsed.operation === "install" && ', ''),
 ("id_compass_install_schema", A, 'return parsed?.schema_version === 1 && parsed.operation', 'return parsed.operation'),
 ("id_semctx_status_kind", A, 'status.kind === "plugin_delivery_status"', 'true'),
 ("id_semctx_status_schema", A, 'status?.schemaVersion === 2 && status.kind', 'status.kind'),
 ("id_semctx_setupplan_kind", A, 'parsed.kind === "setup_plan" && ', ''),
 ("id_semctx_apply_setup_kind", A, 'setupReport.kind !== "setup" || ', ''),
 ("id_semctx_health_kind", A, 'health?.schemaVersion === 1\n    && health.kind === "index_health" && ["valid"', 'health?.schemaVersion === 1\n    && ["valid"'),
 ("id_assert_client", A, 'statuses.includes(parsed?.status) && parsed.client === client && ', 'statuses.includes(parsed?.status) && '),
 ("id_assert_conn_client", A, '&& parsed.connection?.client === client\n', '\n'),
 ("id_assert_mode", A, 'parsed.client === client && parsed.mode === mode', 'parsed.client === client'),
 ("ver_semctx_install", A, 'parsed.version === version && parsed.dryRun === dryRun', 'parsed.dryRun === dryRun'),
 ("ver_compass_install", A, 'parsed.version === version\n    && project === root', 'project === root'),
 ("ver_compass_status", A, '|| parsed.version !== version\n    || typeof parsed.project_root', '|| typeof parsed.project_root'),
 ("ver_semctx_doctor_struct", A, '&& doctor.version === version && Array.isArray(doctor.checks)\n    && doctor.checks.every', '&& Array.isArray(doctor.checks)\n    && doctor.checks.every'),
 ("ver_semctx_doctor_both", A, 'doctor.version === version', 'true'),
 ("ver_semctx_status_stable", A, '(status.hosts[host].installed.version === null || isStableVersion(status.hosts[host].installed.version))', 'true'),
 ("ver_compass_entry", A, 'match(/^latent-compass (\\d+\\.\\d+\\.\\d+)$/u)?.[1]', 'match(/(\\d+\\.\\d+\\.\\d+)/u)?.[1]'),
 ("root_optional", A, 'if (parsed?.repositoryRoot === undefined) return true;', 'return true;'),
 ("root_semctx_setupplan", A, '&& parsed.repositoryRoot === root && Array.isArray(parsed.plannedChanges)', '&& Array.isArray(parsed.plannedChanges)'),
 ("root_semctx_install_ws", A, 'rt.realpath(parsed.workspace.root) === root', 'true'),
 ("root_compass_install", A, '&& project === root\n', '\n'),
 ("root_compass_status", A, 'return rt.realpath(parsed.project_root) === root;', 'return true;'),
 ("root_assert_artifacts", A, 'return rt.realpath(normalized.slice(0, -suffix.length)) === root;', 'return true;'),
 ("root_semctx_workspace", A, 'if (candidate === undefined) continue;', 'continue;'),
 ("root_semctx_apply_setup", A, '|| setupReport.repositoryRoot !== root\n', '\n'),
 ("host_semctx_install_outcome", A, 'hosts.every((host) => parsed.hosts[host].detected === true && statuses.includes(parsed.hosts[host].status))', 'true'),
 ("host_semctx_install_status", A, '&& statuses.includes(parsed.hosts[host].status))', ')'),
 ("host_semctx_install_requested", A, 'HOSTS.every((host) => parsed.hosts?.[host]?.requested === hosts.includes(host))', 'true'),
 ("host_semctx_ok", A, '&& parsed?.ok === true && parsed.version', '&& parsed.version'),
 ("host_compass_hosts", A, '&& parsed.hosts[0] === host && Array.isArray(parsed.files)', '&& Array.isArray(parsed.files)'),
 ("host_compass_status_host", A, '|| parsed.hosts[0]?.host !== host\n', '\n'),
 ("host_compass_conflicts", A, 'Array.isArray(parsed.conflicts) && parsed.conflicts.length === 0', 'true'),
 ("host_semctx_status_requested", A, 'status.hosts?.[host]?.requested === true\n', 'status.hosts?.[host]\n'),
 ("host_compass_apply_configured", A, '|| parsed.states?.[host]?.installed !== true || parsed.states?.[host]?.configured !== true) {', ') {'),
 ("host_assert_rollback", A, '&& parsed.rollback?.status === "NOT_REQUIRED";', ';'),
 ("art_nonobject", A, 'parsed.artifacts.every((artifact) => artifact !== null && !Array.isArray(artifact) && typeof artifact === "object")', 'true'),
 ("art_count", A, 'parsed.artifacts.length === expected.length', 'true'),
 ("art_state", A, '&& artifactStates.includes(artifact.state))', ')'),
 ("art_unique", A, '&& fileBelongsToRoot(rt, artifact.path, relativePath, root)).length === 1)', '&& fileBelongsToRoot(rt, artifact.path, relativePath, root)).length >= 1)'),
 ("art_owner", A, 'parsed.artifacts.every((artifact) => ["init", "connection"].includes(artifact?.owner)\n      && typeof', 'parsed.artifacts.every((artifact) => true\n      && typeof'),
 ("art_compass_action", A, '&& ["create", "update", "unchanged"].includes(file.action))', ')'),
 ("art_compass_count", A, 'parsed.files.length === expected.length', 'true'),
 ("art_compass_unique", A, '}).length === 1)\n    && parsed.files.every', '}).length >= 1)\n    && parsed.files.every'),
 ("ws_struct_collapse", A, 'if (!doctorStructured || !healthStructured) return "unknown";', ''),
 ("ws_root_collapse", A, 'if (typeof candidate !== "string" || rt.realpath(candidate) !== root) return "unknown";', 'if (typeof candidate !== "string" || rt.realpath(candidate) !== root) return "no";'),
 ("ws_preflight_unknown_ignored", A, 'if (workspaceStatus === "unknown") {', 'if (false) {'),
 ("ws_preflight_unknown_as_yes", A, 'skipSetup = workspaceStatus === "yes";', 'skipSetup = workspaceStatus !== "no";'),
 ("ws_preflight_no_as_yes", A, 'skipSetup = workspaceStatus === "yes";', 'skipSetup = workspaceStatus !== "unknown";'),
 ("ws_doctor_index_status", A, '&& (name !== "index" || check.status === "healthy")', ''),
 ("ws_health_coverage", A, '&& health.coverage?.status === "complete";', ';'),
 ("assert_diag_identity", A, 'configured: !admitted ? "unknown" : configured ? "yes" : "no"', 'configured: configured ? "yes" : "no"'),
 ("assert_diag_exitmap", A, 'return item.exitCode === exitCodes[item.report?.status]\n      && ', 'return '),
 ("assert_diag_evidence_flag", A, 'evidenceInvalid: !admitted', 'evidenceInvalid: false'),
 ("assert_diag_ready", A, 'checks, ready: configured, evidenceInvalid', 'checks, ready: admitted, evidenceInvalid'),
 ("content_unverified", A, '} else if (installed.version !== null && installed.contentMatchesSnapshot !== true) {', '} else if (false) {'),
 ("content_drift_upgrade_only", A, 'if (installed.version !== null && installed.contentMatchesSnapshot === false) {', 'if (installed.version !== null && installed.contentMatchesSnapshot === false && command !== "upgrade") {'),
 ("content_apply", A, '|| delivery.hosts[host].installed.contentMatchesSnapshot !== true)) {', ')) {'),
 ("content_diag", A, '&& item?.installed?.contentMatchesSnapshot === true;', ';'),
 ("content_skip_host", A, '&& statusJson.hosts[host].installed.contentMatchesSnapshot === true\n', '\n'),
 ("mkt_preflight", A, 'if (installed.version !== null && statusJson.hosts[host].marketplace?.matchesSemctx !== true) {', 'if (false) {'),
 ("native_exitcode_semctx_setup", A, 'if (setup.code !== 0 || !validSemctxSetupPlan(setupJson, root)) {', 'if (!validSemctxSetupPlan(setupJson, root)) {'),
 ("native_exitcode_compass_preview", A, 'if (result.code !== 0 || !validCompassInstallReport(rt, parsed, root, host, version, true)) {\n      problem', 'if (!validCompassInstallReport(rt, parsed, root, host, version, true)) {\n      problem'),
 ("native_exitcode_assert_preview", A, 'if (result.code !== 0 || !validAssertSetupReport(rt, parsed, root, client, "dry-run", ["WOULD_CREATE", "UNCHANGED"], ["WOULD_CREATE", "UNCHANGED"])) {\n      problem', 'if (!validAssertSetupReport(rt, parsed, root, client, "dry-run", ["WOULD_CREATE", "UNCHANGED"], ["WOULD_CREATE", "UNCHANGED"])) {\n      problem'),
 ("native_result_swallow", A, 'problem(report, "NATIVE_REPORT_INVALID", `${name}: ${shortError(result)}`, 5);\n    return null;', 'return {};'),
 ("stream_rethrow", R, 'return { code: 5, stdout: "", stderr: `Native process output read failed: ${String(error?.message ?? error)}` };', 'throw error;'),
 ("stream_swallow_empty", R, 'new Response(child.stdout).text(),', 'new Response(child.stdout).text().catch(() => ""),'),
 ("stream_success_code", R, 'return { code: 5, stdout: "", stderr: `Native process output read failed', 'return { code: 0, stdout: "", stderr: `Native process output read failed'),
 ("ws_no_to_yes", A, 'return doctorReady && indexReady ? "yes" : "no";', 'return "yes";'),
 ("ws_no_to_unknown", A, 'return doctorReady && indexReady ? "yes" : "no";', 'return doctorReady && indexReady ? "yes" : "unknown";'),
 ("ws_index_ignored", A, 'return doctorReady && indexReady ? "yes" : "no";', 'return doctorReady ? "yes" : "no";'),
 ("ws_doctor_ignored", A, 'return doctorReady && indexReady ? "yes" : "no";', 'return indexReady ? "yes" : "no";'),
 ("id_assert_client_both", A, 'statuses.includes(parsed?.status) && parsed.client === client && ', 'statuses.includes(parsed?.status) && '),
 ("art_block_removed", A, """    && Array.isArray(parsed.artifacts) && parsed.artifacts.length === expected.length
    && parsed.artifacts.every((artifact) => artifact !== null && !Array.isArray(artifact) && typeof artifact === "object")
    && expected.every(([owner, relativePath]) => parsed.artifacts.filter((artifact) => artifact?.owner === owner
      && fileBelongsToRoot(rt, artifact.path, relativePath, root)).length === 1)
    && parsed.artifacts.every((artifact) => ["init", "connection"].includes(artifact?.owner)
      && typeof artifact.path === "string" && artifact.path.length > 0
      && artifactStates.includes(artifact.state))
""", ""),
 ("compass_status_identity_optional", A, 'if (parsed?.schema_version !== 1 || parsed.operation !== "status" || parsed.version !== version\n    || typeof parsed.project_root !== "string" || !Array.isArray', 'if ((parsed?.schema_version !== undefined && (parsed?.schema_version !== 1 || parsed.operation !== "status" || parsed.version !== version\n    || typeof parsed.project_root !== "string")) || !Array.isArray'),
 ("semctx_apply_version", A, 'hosts.some((host) => delivery.hosts[host].installed.version !== version\n      || ', 'hosts.some((host) => '),
 ("assert_apply_verify_unchanged", A, '"dry-run", ["UNCHANGED"], ["UNCHANGED"])) {\n      throw new Error(`AssertLedger post-install', '"dry-run", ["UNCHANGED", "WOULD_CREATE"], ["UNCHANGED", "WOULD_CREATE"])) {\n      throw new Error(`AssertLedger post-install'),
 ("semctx_apply_install_exit", A, 'if (install.code !== 0 || !validSemctxInstallReport(rt, parsed, root, hosts, version, hostMode, false)) {', 'if (!validSemctxInstallReport(rt, parsed, root, hosts, version, hostMode, false)) {'),
 ("compass_apply_status_exit", A, 'if (status.code !== 0 || !recognizableCompassStatus(rt, observed, root, host, version)', 'if (!recognizableCompassStatus(rt, observed, root, host, version)'),
]
only = sys.argv[1:]
out = {}
for mid, f, old, new in M:
    if only and mid not in only: continue
    p = f"{W}/{f}"; src = open(p).read()
    n = src.count(old)
    if n != 1:
        print(f"{mid}: PATTERN COUNT {n}"); continue
    open(p, "w").write(src.replace(old, new))
    r = subprocess.run("rtk proxy bun test 2>&1", shell=True, cwd=W, capture_output=True, text=True)
    open(p, "w").write(src)
    fails = sorted(set(re.findall(r"^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$", r.stdout, re.M)))
    summ = re.findall(r"^ *(\d+) (pass|fail)", r.stdout, re.M)
    print(f"{mid}: exit={r.returncode} {summ} FAILS={len(fails)}")
    for x in fails[:6]: print("    -", x)
    out[mid] = fails
st = subprocess.run("git status --porcelain", shell=True, cwd=W, capture_output=True, text=True).stdout
print("status:", repr(st))
