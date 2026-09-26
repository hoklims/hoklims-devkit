# State safety boundary

Run `setup` and `upgrade` with a quiescent Codex or Claude profile: stop other Devkit runs and tools that create, move, replace, or remove files in that profile until the command finishes. Use ordinary local directories rather than symbolic links or directory aliases. When the launcher reports a conflict, preserve the reported path, inspect it, repair the profile, and retry the exact command shown in the report.

The launcher rejects linked or non-regular state paths and verifies that temporary state and lock files still identify the files it created before it commits or removes them. It preserves foreign replacements and reports them as conflicts. It also distinguishes malformed state, lock contention, and filesystem failures.

These checks do not contain a hostile peer that moves an already-open parent directory after the final validation. Node provides no portable identity-bound rename across that window. The quiescent-profile requirement is therefore part of the operating contract, rather than a claim of containment against a concurrently hostile process.

Contributors changing state persistence, locking, report classification, or recovery commands must keep the real-filesystem negative witnesses in `test/runtime.test.js`, the report-boundary witnesses in `test/app.test.js`, and the installed-package smoke green on Windows, Linux, and macOS.
