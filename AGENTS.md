# AGENTS.md

## Project

This private monorepo packages Shariq's Pi extensions for installation through Git or npm. The root package is the default suite; `packages/pi-memory` is optional and must remain independently installable.

## Commands

- `mise install --locked` — install the pinned Node toolchain.
- `mise exec --locked -- npm ci` — install the locked workspace dependencies.
- `mise exec --locked -- npm run validate` — typecheck and test the default suite and validate package boundaries.
- `mise exec --locked -- npm run validate --workspace @shariqriaz/pi-memory` — validate optional Pi Memory.
- `mise exec --locked -- npm run pack:inspect` — inspect the default npm tarball before publishing.

## Package boundaries

- Declare default extension entrypoints explicitly in root `package.json#pi.extensions`; do not rely on directory auto-discovery.
- Keep Pi Memory out of the root manifest. It is disabled by default because it ships as `@shariqriaz/pi-memory`.
- Keep `skills/background-terminals` and `skills/subagents` aligned with their extension APIs; Pi loads them from the package and they must not be copied by install scripts.
- Put third-party runtime modules in root `dependencies`. Pi-owned packages and `typebox` remain optional peer dependencies and pinned development dependencies.
- Keep shared runtime helpers in `extensions/shared`; do not duplicate them across extensions.
- Runtime state must use Pi's `getAgentDir()` or project `CONFIG_DIR_NAME`. Never hardcode a user home, checkout path, macOS-only path, or `~/.pi/agent/extensions` location.

## Secrets and generated state

Never commit or package API keys, OAuth credentials, `.env` files, `auth.json`, Factory key files, SQLite databases, caches, sessions, logs, or `node_modules`. Factory runtime state belongs under the active Pi agent directory in `factory/`; Pi Memory data belongs in `pi-memory/`.

## Validation and publication

Before committing package or manifest changes, run both workspace validations and inspect `npm pack --dry-run` output. Preserve the ContextScope MIT license and the third-party notices. GitHub is the canonical source; npm packages are published from the same commit.

## Documentation

Update `README.md` for installation or package-surface changes, `docs/EXTENSIONS.md` for extension behavior, and `docs/DEVELOPMENT.md` for build or release workflow changes.
