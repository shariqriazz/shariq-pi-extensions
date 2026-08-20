# Development and release

Last verified: 2026-08-20

## Requirements

- mise
- Pi matching the pinned development dependency version
- platform build support required by `@lydell/node-pty`

Install the exact cross-platform Node toolchain and repository dependencies:

```bash
mise install --locked
mise exec --locked -- npm ci
```

## Validation

Run the default suite and optional memory package separately:

```bash
mise exec --locked -- npm run validate
mise exec --locked -- npm run validate --workspace @shariqriaz/pi-memory
```

The root validation checks TypeScript, runtime tests, declared extension and skill entrypoints, and forbidden runtime files. Before publishing, inspect both package payloads:

```bash
mise exec --locked -- npm pack --dry-run
mise exec --locked -- npm pack --dry-run --workspace @shariqriaz/pi-memory
```

Review the complete file list. Neither tarball may contain credentials, `.env`, Factory API-key configuration, caches, databases, sessions, logs, or `node_modules`.

## Adding an extension

1. Add a self-contained directory under `extensions/` with an `index.ts` entrypoint.
2. Use relative imports for extension-owned code and `extensions/shared` only for genuinely shared behavior.
3. Put external runtime modules in root `dependencies`.
4. Add the exact entrypoint to root `package.json#pi.extensions`.
5. Add focused runtime tests and update `docs/EXTENSIONS.md`.
6. Run the full validation and inspect the npm tarball.

Do not add nested package manifests or lockfiles. The workspace root owns default-suite dependencies and tooling.

## Runtime configuration

Use `getAgentDir()` for user-level state and `CONFIG_DIR_NAME` for project-level Pi configuration. Use `node:path` and explicit platform branches where third-party credential locations differ. Never infer a writable location from `import.meta.url`, the Git checkout, or npm package path.

Keep secrets out of examples and fixtures. Tests should inject temporary roots, fake environment objects, or local test servers rather than reading the developer's real credentials.

## Skills paired with extensions

The root package manifest declares `skills/background-terminals` and `skills/subagents`. Pi loads those skills directly from the managed Git or npm package location when the package is enabled. Do not copy them into the agent directory from install scripts; doing so would create duplicates and leave stale files after package removal.

When either skill changes, validate its structure and keep its behavior aligned with the corresponding extension tools.

## Versioning

The root suite and optional memory package have independent versions. Update only the package whose published contents changed. Commit the version and lockfile together, then create a matching Git tag when a stable Git pin is needed.

Unpinned Git installations follow repository updates. Tagged Git installations remain fixed. npm installations follow npm package versions.

## First-machine cutover

Do not remove a working local extension set before the managed package is available.

1. Publish and verify the private GitHub and npm packages.
2. Run `pi install npm:@shariqriaz/pi-extensions`; do not reload yet.
3. Move the old auto-discovered extension directories out of the active Pi extension directory so package and local copies cannot load together.
4. Keep the optional memory package uninstalled. Preserve its source and data outside active discovery paths.
5. Move machine-local Factory key and Droid cache files into `<agent-dir>/factory/` with restrictive permissions.
6. Run `/reload` once.
7. Verify package provenance through `pi list`, then check representative commands, tools, providers, and both packaged skills.

Rollback is the reverse: remove the package from Pi settings, restore the local extension directories, and reload. Never delete credentials or databases as part of package rollback.

## Private GitHub publication

GitHub is the canonical source:

```bash
git push origin main
gh repo view shariqriazz/shariq-pi-extensions --json visibility,url
```

The repository must remain private. Do not add public package-gallery metadata.

## Private npm publication

Authenticate against npmjs and verify identity without exposing the token:

```bash
npm whoami
```

Publish restricted packages from a validated clean commit:

```bash
npm publish --access restricted
npm publish --access restricted --workspace @shariqriaz/pi-memory
```

The manual GitHub publish workflow requires a repository secret named `NPM_TOKEN`. npm and GitHub releases must come from the same source commit.
