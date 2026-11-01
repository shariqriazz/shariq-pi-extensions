# AGENTS.md

## Project

This public repository packages the user's Pi extensions as one suite, published as `pi-power-pack` (formerly `shariq-pi-extensions`) through npm and Git. Every extension lives under `extensions/` and is individually toggleable through `pi config`.

## Commands

- `mise install --locked` — install the pinned Bun and Node toolchains.
- `mise exec --locked -- bun install` — install locked dependencies.
- `mise exec --locked -- bun fmt` — format the repository (`bunfig.toml`, print width 120).
- `mise exec --locked -- bun run validate` — typecheck, check formatting, run runtime tests under Node, and validate package boundaries.
- `mise exec --locked -- bun run pack:inspect` — inspect the package payload.

## Package boundaries

- Declare every extension entrypoint explicitly in root `package.json#pi.extensions`; do not rely on directory auto-discovery.
- Keep each extension under `extensions/<name>` in the single root package so `pi config` can enable or disable it individually. Do not create nested Pi packages for suite extensions.
- Every directory under `extensions/` must have a README. Every declared extension needs a `*.test.ts` file; `scripts/run-tests.mjs` discovers them for `bun run validate`.
- Keep `skills/background-terminals`, `skills/fusion`, and `skills/subagents` aligned with their extension APIs; Pi loads them from the package and install scripts must not copy them elsewhere.
- Put third-party runtime modules in root `dependencies`. Pi-owned packages and `typebox` remain optional peer dependencies and pinned development dependencies.
- When dependencies change, refresh both `bun.lock` (CI) and `package-lock.json` (Pi's npm-based Git installs) with `npm install --package-lock-only --ignore-scripts`.
- Keep shared runtime helpers in `extensions/shared`; do not duplicate them across extensions, and delete shared modules nothing imports.
- Keep `extensions/goal` and `extensions/task-list` independent: Goals are explicitly created long-running objectives; Task List tracks multi-deliverable work and may coexist with a goal. Both use branch-local Pi session entries.
- Classify new session-only planning tools explicitly in Subagents capability filtering (`extensions/subagents/src/backends/pi.ts`) so restrictive child profiles can use them without receiving unrelated write or execution authority.
- Runtime state must use Pi's `getAgentDir()` or project `CONFIG_DIR_NAME`. Never hardcode a user home, checkout path, operating-system-specific package path, or active extension directory.

## Model-facing text

Tool descriptions, parameter descriptions, `promptSnippet`, and `promptGuidelines` are sent on every request; see `docs/ARCHITECTURE.md#model-facing-text`. Keep them short, give each rule one home, and never add runtime reminders that push the model toward a tool. Set `exposure` and `annotations` on every new tool as described in `docs/EXTENSIONS.md#tool-exposure`. Tests that pin guidance wording live next to each extension; update them with the text.

## Secrets and generated state

Never commit API keys, OAuth credentials, `.env`, `auth.json`, caches, sessions, logs, or `node_modules`. Smart Compaction settings belong in `smart-compaction.json`; Input Mode settings belong in `input-mode.json`; Media Understanding settings belong in `media-understanding.json`; WebP Images settings belong in `webp-images.json`.

## Validation and releases

- Before committing package or manifest changes, run the root validation (`bun run validate`) and inspect the package payload. Preserve required license files beside the code they cover.
- On functional changes, always bump the `version` in `package.json`. Pushing to `main` automatically triggers CI (`publish-npm.yml`) to validate and publish the new version to npm with OIDC provenance whenever the version is updated.
- For Pi upgrades, follow `docs/DEVELOPMENT.md#upgrading-pi`; Pi's source checkout and changelog are the reference for extension API changes.

## Documentation

Update `README.md` for installation or package-surface changes, `docs/EXTENSIONS.md` for extension behavior, and `docs/DEVELOPMENT.md` for build or release workflow changes. Extension READMEs describe current behavior only; history belongs in Git.
