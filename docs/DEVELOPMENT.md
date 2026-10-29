# Development

## Requirements

- mise
- Pi at or above the version in `devDependencies`
- platform build support for `@lydell/node-pty`

Install the pinned toolchain and dependencies:

```bash
mise install --locked
mise exec --locked -- bun install
```

## Validation

```bash
mise exec --locked -- bun run validate
mise exec --locked -- bun run pack:inspect
```

`validate` runs the TypeScript check, every `*.test.ts` file under `extensions/` with Node's test runner, and `scripts/validate-package.mjs`. The package check confirms that declared extensions and skills exist, are sorted, have READMEs and tests, and that the npm payload contains no credentials, `.env` files, caches, databases, sessions, logs, or first-party tests.

Read the `pack:inspect` file list before committing a package change.

## Adding an extension

1. Create `extensions/<name>/index.ts` and `extensions/<name>/README.md`.
2. Import extension-owned code relatively, and `extensions/shared` only for behavior another extension already shares.
3. Put third-party runtime modules in root `dependencies`.
4. Add the entrypoint to `package.json#pi.extensions` in sorted order.
5. For each tool, choose its `exposure` and `annotations` (see [Tool exposure](EXTENSIONS.md#tool-exposure)) and keep its model-facing text short (see [Model-facing text](ARCHITECTURE.md#model-facing-text)).
6. Add focused tests and a section in `docs/EXTENSIONS.md`.
7. Run both validations.

Do not add nested package manifests or lockfiles under `extensions/`.

## Runtime configuration

Use `getAgentDir()` for user-level state and `CONFIG_DIR_NAME` for project-level Pi configuration. Never derive a writable location from `import.meta.url` or the install directory. Tests use temporary roots, fake environments, or local servers, never real credentials.

## Skills paired with extensions

`package.json#pi.skills` declares `skills/background-terminals` and `skills/subagents`, and Pi loads them from the installed package. Do not copy them into the agent directory. When a paired extension's tools or delivery behavior change, update its skill in the same change.

## Upgrading Pi

1. Raise the `@earendil-works/pi-*` development dependencies, then run `mise exec --locked -- bun install` and `npm install --package-lock-only --ignore-scripts` to refresh both lockfiles.
2. Read the Pi changelog for extension API changes, especially tool, event, and TUI changes.
3. Run both validations, then load the working tree in Pi (`pi -ne -e ./extensions/<name>/index.ts`) to check commands and overlays that tests do not render.

## Releases

GitHub hosts the source and npm distributes versioned releases. Any functional change bumps `package.json#version` (semantic versioning). Pushing to `main` runs `.github/workflows/ci.yml` and `.github/workflows/publish-npm.yml`; the publish workflow validates and publishes with npm trusted publishing and provenance whenever the version is not yet on npm.

After the publish run succeeds, confirm the release with `npm view shariq-pi-extensions version` and update installed copies with `pi update --extensions`.

An npm install follows published versions. An unpinned Git install follows `main`; pin a tag or commit to keep a machine on a known revision.
