# Named regression and evidence

The bundled runtime supports the Semctx 0.4.1 / AssertLedger 1.4.0 profile. Onboarding pins these versions and reuses native provider installers; this plugin declares no MCP server and starts no hook.

Capture a compatible regression using `workflow REPOSITORY --base BEFORE --intent regression --claim CLAIM --neutral NEUTRAL --neutral-reason REASON --regression-test PATH --base-test PATH --obligation ID --json`. Repeat the original `--base-test` paths as needed. The current committed HEAD is AFTER. Use the native AssertLedger preflight and execution policy; Node's built-in test profile has a narrow dependency scope. Unsupported frameworks keep the native-test lane. Never add an unsafe opt-in implicitly.

The plan exposes `providerRequest.consumerRequest.reference`, derived from the canonical request digest. When exporting the manifest through AssertLedger's existing `exportEvidence`/`assertledger export`, retain that reference and request only the declared obligations actually associated with `REGRESSION_DETECTION`. The producer's manifest and self-contained export stay unchanged.

Re-run the same workflow arguments with `--evidence EXPORT_FILE`. The adapter uses the project-local AssertLedger 1.4.0 `export-replay` command, verifies consumer reference, recorded Git worlds/trees and candidate content, and exposes partial coverage. It does not rerun candidate tests. Keep the original export and manifest; the report records their content identities.

An associated `TEST_OBSERVED` result remains advisory and `UNAUTHENTICATED`. Environment, freshness, observation truthfulness and world semantic relevance remain limitations. Every declared obligation stays unproven until the repository's independent gate admits suitable evidence. Missing or invalid exports cannot improve the plan.
