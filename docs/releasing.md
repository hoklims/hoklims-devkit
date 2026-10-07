# Release sequence

The launcher must be released **after** its native integrations. At the first public release, verify that npm `semctx` has a safe `setup --dry-run` (0.3.4 or later) and that its `stable` Codex and Claude plugin manifests declare the same version. AssertLedger must have published its `setup` CLI (1.3.0 or later). Latent Compass must have published its persistent-host CLI wheel on PyPI (0.3.0 or later). These are release identities, not source-branch claims.

The common Codex `onboard` profile additionally requires public Semctx 0.4.2
and AssertLedger 1.4.0. Verify these exact npm identities before the first
launcher publication. The offline packaged-profile smoke checks bundled content
and read-only request capture; it does not establish provider publication or
successful native onboarding. Keep that release prerequisite open until checked.

## One-time npm bootstrap

The annotated `v0.1.0` tag remains immutable after release run `37457779632`
failed before producing a tested tarball. No npm `hoklims-devkit@0.1.0` package
was published. The annotated `v0.1.1` tag also remains immutable: release run
`37465894823` built its tarball but failed native verification. Neither failed
version was published to npm. The annotated `v0.1.2` tag remains immutable after its native repeat checks failed; it was not published. First publication is now `0.1.3`. The package embeds an identified
common plugin and runtime whose metadata is coupled to the launcher version;
both plugin manifests therefore declare `0.1.3` as well.

The checkout action can replace its local annotated tag ref with the commit
ref during its SHA fallback. Each release preflight fetches the explicit tag
ref again from `origin` before checking annotation, peeled commit, main ancestry
and package version. This repairs only the runner-local ref; it does not
rewrite the remote tag or waive any identity guard.

npm requires a package to exist before its first trusted publisher can be registered. The `v0.1.3` tag therefore builds one tarball, tests those exact bytes on Windows, Linux and macOS, and skips the OIDC `publish` job. From a clean checkout of that exact annotated tag:

1. Check that the tag workflow's `build` and all three `verify` jobs pass against the actual public native versions and both host CLIs. Record that workflow run ID and download the single tested tarball with `gh run download <RUN_ID> --repo hoklims/hoklims-devkit --name tested-npm-tarball --dir tested-package`.
2. Authenticate the `hoklims` npm account with `npm login --auth-type=web` and its ordinary second factor. Publish **that exact tarball** once with `npm publish ./tested-package/hoklims-devkit-0.1.3.tgz --access public`. Never put an npm token in this repository.
3. Verify `npm view hoklims-devkit@0.1.3 version dist.integrity`, then dispatch `.github/workflows/bootstrap-verify.yml` from `main` with `verified_run_id=<RUN_ID>`. It checks that the run was the successful release-tag workflow on the exact tag SHA and that the public tarball integrity equals the tested tarball. It then installs the public package into a fresh consumer, runs the full Codex and Claude smoke, and creates the GitHub Release only after it passes. Retain its exact-SHA run URL as the first-publication evidence.
4. In npm package settings, register `hoklims/hoklims-devkit`, workflow `release.yml`, with direct `npm publish` permission as its trusted publisher. Restrict traditional token publishing only after that publisher works.

Tag the next version (`v0.1.4` or later) from the verified main commit. The tag workflow tests Windows, Linux, and macOS, publishes through GitHub OIDC, installs the public package again on a fresh Linux runner, then creates its GitHub Release. A publication is incomplete if the public install smoke fails, even when `npm publish` succeeded.

PyPI supports a pending trusted publisher for a new project. Latent Compass uses project `latent-compass`, owner `hoklims`, repository `latent-compass`, workflow `release.yml`, and environment `pypi`; its first PyPI upload can use OIDC without a bootstrap API token.

Transient Latent Compass previews use `uv tool run --isolated
--no-python-downloads`: they use an existing compatible Python and disposable
cache without initializing the persistent tool store. Production inventory
first asks the read-only `uv tool dir` for its absolute store path. An absent
store yields an empty inventory without calling `uv tool list`. An existing
store without a safely observed regular `.lock`, or with linked/non-directory
parents, is refused before listing; initialize it explicitly or inspect
`UV_TOOL_DIR` before retrying. Initialized stores retain native output validation.
Injected custom/test runtimes without this capability are trusted caller-owned
seams; `createRuntime()` always provides the guarded production path. These
filesystem observations do not establish atomic protection against concurrent
peer substitution or a universally confined external executable.

## Recovery

Published package versions and tags are immutable. If a public version is faulty, retain its evidence, publish a corrected patch, and move npm's `latest` dist-tag only after verifying the corrected package. Do not force-move Git tags or claim that an installed package proves a running agent session loaded it.

## Configuration and semantic qualification

`doctor.ok` verifies installation/configuration: native version and host files, CLI compatibility when reported, workspace/config/runtime checks, a valid fresh index binding and native positive-control readiness. A structurally valid PARTIAL caused only by NEGATIVE_COMPLETENESS_MISSING may preserve this configuration and avoid unnecessary reindexing. Dirty/stale sources, unsupported/failed/disabled analysis, malformed native reports or transport failures remain unready.

The separate `semanticQualification` preserves native coverage, reasons, candidates and eligibility/evaluation evidence. PARTIAL or negative-ineligible analysis remains blocked for negative conclusions; configuration readiness does not admit proof or authorize absence claims. COMPLETE alone does not certify a scope: matching nonempty native capability/evaluation evidence and negative eligibility are required. Session loading and approval remain unobserved unless established independently.

The release smoke declares its TypeScript-only fixture through native V2 config, derives scenario homes from the canonical Git root, commits generated repository source (never databases/caches), then refreshes its native index once before the repeat snapshot. Idempotence is tested only after this positive configuration readiness is established. Every protected profile path and repeat/doctor/upgrade snapshot remains checked. This fixture does not qualify a user repository.
