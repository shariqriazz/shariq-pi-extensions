# AGENTS.md

## Project

This public repository packages the user's Pi extensions as one suite distributed through npm and Git. Every extension, including Pi Memory, lives under `extensions/` and is individually toggleable through `pi config`.

## Commands

- `mise install --locked` — install the pinned Node toolchain.
- `mise exec --locked -- npm ci` — install locked dependencies.
- `mise exec --locked -- npm run validate` — typecheck and test the complete suite and validate package boundaries.
- `mise exec --locked -- npm run pack:inspect` — inspect the package payload.

## Package boundaries

- Declare every extension entrypoint explicitly in root `package.json#pi.extensions`; do not rely on directory auto-discovery.
- Keep each extension under `extensions/<name>` in the single root package so `pi config` can enable or disable it individually. Do not create nested Pi packages for suite extensions.
- Every directory under `extensions/` must have a README. Every declared extension must have a repository-native test included by the root `npm test` command.
- Keep `skills/background-terminals`, `skills/orchestration`, and `skills/subagents` aligned with their extension APIs; Pi loads them from the package and install scripts must not copy them elsewhere.
- Put third-party runtime modules in root `dependencies`. Pi-owned packages and `typebox` remain optional peer dependencies and pinned development dependencies.
- Keep shared runtime helpers in `extensions/shared`; do not duplicate them across extensions.
- Runtime state must use Pi's `getAgentDir()` or project `CONFIG_DIR_NAME`. Never hardcode a user home, checkout path, operating-system-specific package path, or active extension directory.

## Secrets and generated state

Never commit API keys, OAuth credentials, `.env`, `auth.json`, Factory key files, SQLite databases, caches, sessions, logs, or `node_modules`. Factory state belongs under the active Pi agent directory in `factory/`; Pi Memory data belongs in `pi-memory/`; Smart Compaction settings belong in `smart-compaction.json`; Input Mode settings belong in `input-mode.json`.

## Validation

Before committing package or manifest changes, run the root validation and inspect the package payload. Preserve required license files beside the code they cover.

## Documentation

Update `README.md` for installation or package-surface changes, `docs/EXTENSIONS.md` for extension behavior, and `docs/DEVELOPMENT.md` for build or cutover workflow changes.
