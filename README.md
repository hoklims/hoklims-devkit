# Hoklims Devkit

Hoklims Devkit prepares a Git repository for [Semctx](https://github.com/hoklims/semctx), with optional [AssertLedger](https://github.com/hoklims/assertledger) and [Latent Compass](https://github.com/hoklims/latent-compass) integration. It uses each project's installer and keeps their data and authority boundaries separate.

**Release status:** this repository is under development. `hoklims-devkit` is not yet published to npm. The commands below are the intended public interface; use `bun bin/hoklims-devkit.js` from this checkout during development.

[Guide français](README.fr.md)

## Requirements

- Bun 1.4 or later and Git.
- Codex CLI, Claude Code CLI, or both on `PATH`. `--host auto` selects every detected host.
- Optional AssertLedger: Node 22.15 or later, npm, and the repository's declared npm, pnpm, or Bun package manager with a `node_modules` installation. Yarn users can run AssertLedger's native setup directly. Its built-in ready adapter is `node:test`; other frameworks may require an operator-supplied adapter.
- Optional Latent Compass: uv. Its tool environment uses Python 3.13; `uv tool install` can obtain that interpreter.

The launcher never installs Bun, Node, or uv for you. It reports a missing prerequisite before changing the repository or host configuration.

## First use

After the public release, run this **from a Git repository**:

```sh
bunx hoklims-devkit@latest setup .
```

This selects Semctx and detected Codex/Claude hosts. To inspect the plan without writing, add `--dry-run --json`. To enable the optional tools, use `--with assertledger`, `--with latent-compass`, or both as a comma-separated list. To target one host, use `--host codex` or `--host claude`.

```sh
bunx hoklims-devkit@latest setup . --host codex --with assertledger,latent-compass --dry-run --json
bunx hoklims-devkit@latest doctor . --json
bunx hoklims-devkit@latest upgrade . --dry-run --json
```

`setup` resolves the latest compatible stable release on first installation, runs **all selected preflights before applying any step**, and records the resolved plan and each successfully configured component in a user-local state file. A second `setup` keeps recorded versions. `upgrade` resolves the newest stable releases explicitly. Package and plugin version skew, malformed files, conflicting package managers, foreign hooks, and unsupported runtimes stop the plan before writes. A failure during application is reported as partial; repair it and rerun the same command to keep the original resolved versions.

`doctor --json` reports installation, configuration, session loading, approval, and observation separately. A successful package install does not establish that a running agent session loaded or approved it. Open a new Codex task or reload Claude plugins when instructed. Review a Latent Compass hook in the host before approving it.

## Daily use

- Use Semctx to inspect change impact and authored obligations, for example `semctx verify diff --base origin/main`.
- Use AssertLedger for a named regression claim. Its repository setup does **not** invent faults, worlds, candidates, or proof. Its read-only MCP connection does not permit candidate execution; the unsandboxed path still requires `--allow-unsafe-execution` from the operator.
- Use Latent Compass to record uncertainty around a consequential decision. Its local shadow observations are advisory and have no execution authority.

The three tools do not need to run on every task.

## Removing an integration

There is no umbrella uninstall command in this release. Use the native removal command for the selected project and host. AssertLedger's `disconnect . --client codex|claude-code --write` removes only byte-identical files it owns. Latent Compass's `host remove --project-root . --host codex|claude` removes that project's registration and keeps other projects. Semctx is a shared user-level plugin: remove it with `codex plugin remove semctx-control@semctx-stable` or `claude plugin uninstall semctx@semctx-stable --scope user` only when no other repository needs it. Authored `.semctx` files and evidence are retained.

## Development and release

Run `bun test` and `bun run check`. The release gate packs the npm tarball and tests it outside the checkout on Windows, Linux, and macOS. npm requires a one-time authenticated first publication before trusted publishing can be configured; later releases use GitHub OIDC. See the [release sequence](docs/releasing.md). The public README command becomes usable only after the registry install smoke passes.
