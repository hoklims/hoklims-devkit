# Release sequence

The launcher must be released **after** its native integrations. At the first public release, verify that npm `semctx` has a safe `setup --dry-run` (0.3.4 or later) and that its `stable` Codex and Claude plugin manifests declare the same version. AssertLedger must have published its `setup` CLI (1.3.0 or later). Latent Compass must have published its persistent-host CLI wheel on PyPI (0.3.0 or later). These are release identities, not source-branch claims.

## One-time npm bootstrap

npm requires a package to exist before its first trusted publisher can be registered. The `v0.1.0` tag therefore runs the three-platform `verify` job, but skips the OIDC `publish` job. From a clean checkout of that exact annotated tag:

1. Check that the tag workflow's three `verify` jobs pass against the actual public native versions and both host CLIs. Record that workflow run ID and download its tested tarball with `gh run download <RUN_ID> --repo hoklims/hoklims-devkit --name tested-npm-tarball --dir tested-package`.
2. Authenticate the `hoklims` npm account with `npm login --auth-type=web` and its ordinary second factor. Publish **that exact tarball** once with `npm publish ./tested-package/hoklims-devkit-0.1.0.tgz --access public`. Never put an npm token in this repository.
3. Verify `npm view hoklims-devkit@0.1.0 version dist.integrity`, then dispatch `.github/workflows/bootstrap-verify.yml` from `main` with `verified_run_id=<RUN_ID>`. It checks that the run was the successful release-tag workflow on the exact tag SHA and that the public tarball integrity equals the tested tarball. It then installs the public package into a fresh consumer, runs the full Codex and Claude smoke, and creates the GitHub Release only after it passes. Retain its exact-SHA run URL as the first-publication evidence.
4. In npm package settings, register `hoklims/hoklims-devkit`, workflow `release.yml`, with direct `npm publish` permission as its trusted publisher. Restrict traditional token publishing only after that publisher works.

Tag the next version (`v0.1.1` or later) from the verified main commit. The tag workflow tests Windows, Linux, and macOS, publishes through GitHub OIDC, installs the public package again on a fresh Linux runner, then creates its GitHub Release. A publication is incomplete if the public install smoke fails, even when `npm publish` succeeded.

PyPI supports a pending trusted publisher for a new project. Latent Compass uses project `latent-compass`, owner `hoklims`, repository `latent-compass`, workflow `release.yml`, and environment `pypi`; its first PyPI upload can use OIDC without a bootstrap API token.

## Recovery

Published package versions and tags are immutable. If a public version is faulty, retain its evidence, publish a corrected patch, and move npm's `latest` dist-tag only after verifying the corrected package. Do not force-move Git tags or claim that an installed package proves a running agent session loaded it.
