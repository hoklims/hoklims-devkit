// Empirical round-trip of quoteShellToken through real shells. Run: bun quote-roundtrip.mjs <WORK>
const { quoteShellToken } = await import(`${process.argv[2]}/src/app.js`);
const cases = [
  "/plain/path", "/repo with space", "/repo  two  spaces", "/it's/here", "/a''b", "'", "''",
  "/x/$(touch /tmp/PWNED_HI)/y", "/x/`id`/y", "/x/$HOME/y", "/x/${PATH}/y", "/a\\b\\\\c\\", "\\'",
  " leading", "trailing ", "\ttab\t", "/new\nline", "/glob/*?[a]", "/semi;colon&amp|pipe>out<in",
  "/hash#x", "~/tilde", "-dash", "/bang!x", "/quote\"dq", "/unicodé/日本", "/curly\u2019quote", "",
  "/repo  with 'quote $() ` tick", "/tmp/a\\b repo  with 'quote $() ` tick",
];
const shells = [["sh", "/bin/sh (dash)"], ["bash", "bash --posix-ish"], ["dash", "dash"]];
let failures = 0;
const rows = [];
for (const value of cases) {
  const quoted = quoteShellToken(value);
  for (const [sh] of shells) {
    const script = `printf '%s\\n' ${quoted}`;
    const r = Bun.spawnSync({ cmd: [sh, "-c", script], stdout: "pipe", stderr: "pipe" });
    const out = Buffer.from(r.stdout);
    const ok = r.exitCode === 0 && out.equals(Buffer.from(value + "\n", "utf8"));
    // argv-count check inside a full printed command
    const r2 = Bun.spawnSync({ cmd: [sh, "-c", `set -- hoklims-devkit setup ${quoted} --host codex; printf '%s' "$#"`], stdout: "pipe" });
    const argcOk = r2.stdout.toString() === "5";
    if (!ok || !argcOk) failures += 1;
    rows.push(`${ok && argcOk ? "OK  " : "FAIL"} ${sh.padEnd(4)} value=${JSON.stringify(value)} quoted=${JSON.stringify(quoted)} exit=${r.exitCode} argc5=${argcOk}`);
  }
}
const { existsSync } = await import("node:fs");
rows.push(`side-effect file /tmp/PWNED_HI exists: ${existsSync("/tmp/PWNED_HI")}`);
// PowerShell branch output (process.platform forced to win32; quoteShellToken reads it per call)
Object.defineProperty(process, "platform", { value: "win32" });
rows.push("--- win32 (PowerShell) outputs, not executed:");
for (const value of ["C:\\repo with space", "C:\\it's", "C:\\x\\$(calc)\\`t", "C:\\curly\u2019quote", " lead", "C:\\plain"]) {
  rows.push(`${JSON.stringify(value)} -> ${quoteShellToken(value)}`);
}
console.log(rows.join("\n"));
console.log(`FAILURES=${failures}`);
process.exit(failures ? 1 : 0);
