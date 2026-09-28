const COMMON_ASSETS = Object.freeze({
  "integrations/skill/SKILL.md": "c917c49ef694a6aada24e43cd7f66f9b8eb5c3fd3d22f512c6aac76c46c53359",
  "schemas/repository-init-config.v1.json": "384022966f3909bb24ea9a4c9cc7922484f1eb53205e4b648d028a279ec9f382",
  "schemas/repository-init-config.v2.json": "03176fe2fabd53f1b688815f2d163907ed5771b1b4e45be124a15ccf4e9e2328",
  "schemas/repository-init-lock.v1.json": "3d63c741682156db875da1f444c5e403da4436ee8ff5dc432b19a5cbb34b625d",
  "schemas/repository-init-lock.v2.json": "d3d81aa21491cd545163a63b579ad87e2b21f7de19a89ca70c6f4de98eb22966",
  "schemas/repository-init-result.v1.json": "0fbc09e81775d2baa14592ca9f582b2b1cb0cbc0f98b75845561d28e4c713106",
  "schemas/repository-init-result.v2.json": "41c984107b3bec203bd049fa8fa0df87e1c3b6b0a421c88a4fdeef18f6b1dea5",
});

const CONTRACTS = Object.freeze({
  "1.2.0": Object.freeze({ ...COMMON_ASSETS,
    "dist/cli.js": "ddfec94356543314e76c6a5ff12b8d15b58bae303245f7322fa86a3db97789ae" }),
  "1.3.0": Object.freeze({ ...COMMON_ASSETS,
    "dist/cli.js": "9b9ca0ab11e1b0b276d73670fb5ae2bfc5976051dd2038bdc6af599368f703e1" }),
});

export function assertLedgerContract(version) {
  return CONTRACTS[version] ?? null;
}

export const ASSERTLEDGER_COMPATIBLE_VERSIONS = Object.freeze(Object.keys(CONTRACTS));
