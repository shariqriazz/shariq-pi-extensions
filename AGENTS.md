# AGENTS.md

## Project

This public repository packages the user's Pi extensions as one suite distributed through npm and Git. Every extension lives under `extensions/` and is individually toggleable through `pi config`.

## Commands

- `mise install --locked` — install the pinned Node toolchain.
- `mise exec --locked -- npm ci` — install locked dependencies.
- `mise exec --locked -- npm run validate` — typecheck and test the complete suite and validate package boundaries.
- `mise exec --locked -- npm run pack:inspect` — inspect the package payload.

## Package boundaries

- Declare every extension entrypoint explicitly in root `package.json#pi.extensions`; do not rely on directory auto-discovery.
- Keep each extension under `extensions/<name>` in the single root package so `pi config` can enable or disable it individually. Do not create nested Pi packages for suite extensions.
- Every directory under `extensions/` must have a README. Every declared extension must have a repository-native test included by the root `npm test` command.
- Keep `skills/background-terminals` and `skills/subagents` aligned with their extension APIs; Pi loads them from the package and install scripts must not copy them elsewhere.
- Put third-party runtime modules in root `dependencies`. Pi-owned packages and `typebox` remain optional peer dependencies and pinned development dependencies.
- Keep shared runtime helpers in `extensions/shared`; do not duplicate them across extensions.
- Keep `extensions/goal` and `extensions/task-list` independent: Goals are explicitly created long-running objectives; Task List tracks ordinary multi-step execution and may coexist with a goal. Both use branch-local Pi session entries.
- Classify new session-only planning tools explicitly in Subagents capability filtering so restrictive child profiles can use them without receiving unrelated write or execution authority.
- Runtime state must use Pi's `getAgentDir()` or project `CONFIG_DIR_NAME`. Never hardcode a user home, checkout path, operating-system-specific package path, or active extension directory.

## Secrets and generated state

Never commit API keys, OAuth credentials, `.env`, `auth.json`, caches, sessions, logs, or `node_modules`. Smart Compaction settings belong in `smart-compaction.json`; Input Mode settings belong in `input-mode.json`.

## Validation and releases

- Before committing package or manifest changes, run the root validation (`npm run validate`) and inspect the package payload. Preserve required license files beside the code they cover.
- On functional changes, always bump the `version` in `package.json`. Pushing to `main` automatically triggers CI (`publish-npm.yml`) to validate and publish the new version to npm with OIDC provenance whenever the version is updated.

## Documentation

Update `README.md` for installation or package-surface changes, `docs/EXTENSIONS.md` for extension behavior, and `docs/DEVELOPMENT.md` for build or cutover workflow changes.
