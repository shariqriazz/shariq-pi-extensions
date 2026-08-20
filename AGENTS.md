# AGENTS.md

## Project

This private repository packages Shariq's Pi extensions for installation through Git. The root package is the default suite; `packages/pi-memory` is optional and excluded from the root Pi manifest.

## Commands

- `mise install --locked` — install the pinned Node toolchain.
- `mise exec --locked -- npm ci` — install locked workspace dependencies.
- `mise exec --locked -- npm run validate` — typecheck and test the default suite and validate package boundaries.
- `mise exec --locked -- npm run validate --workspace packages/pi-memory` — validate optional Pi Memory.
- `mise exec --locked -- npm run pack:inspect` — inspect the package payload.

## Package boundaries

- Declare default extension entrypoints explicitly in root `package.json#pi.extensions`; do not rely on directory auto-discovery.
- Keep Pi Memory out of the root manifest so installing the default suite cannot activate it.
- Keep `skills/background-terminals` and `skills/subagents` aligned with their extension APIs; Pi loads them from the package and install scripts must not copy them elsewhere.
- Put third-party runtime modules in root `dependencies`. Pi-owned packages and `typebox` remain optional peer dependencies and pinned development dependencies.
- Keep shared runtime helpers in `extensions/shared`; do not duplicate them across extensions.
- Runtime state must use Pi's `getAgentDir()` or project `CONFIG_DIR_NAME`. Never hardcode a user home, checkout path, operating-system-specific package path, or active extension directory.

## Secrets and generated state

Never commit API keys, OAuth credentials, `.env`, `auth.json`, Factory key files, SQLite databases, caches, sessions, logs, or `node_modules`. Factory state belongs under the active Pi agent directory in `factory/`; Pi Memory data belongs in `pi-memory/`.

## Validation

Before committing package or manifest changes, run both workspace validations and inspect the package payload. Preserve the ContextScope MIT license and third-party notices.

## Documentation

Update `README.md` for installation or package-surface changes, `docs/EXTENSIONS.md` for extension behavior, and `docs/DEVELOPMENT.md` for build or cutover workflow changes.
