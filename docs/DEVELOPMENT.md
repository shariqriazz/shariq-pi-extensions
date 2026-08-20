# Development and cutover

Last verified: 2026-08-20

## Requirements

- mise
- Pi matching the pinned development dependency version
- platform build support required by `@lydell/node-pty`

Install the exact Node toolchain and workspace dependencies:

```bash
mise install --locked
mise exec --locked -- npm ci
```

## Validation

Run the default suite and optional memory package separately:

```bash
mise exec --locked -- npm run validate
mise exec --locked -- npm run validate --workspace packages/pi-memory
mise exec --locked -- npm pack --dry-run
```

The root validation checks TypeScript, runtime tests, declared extension and skill entrypoints, and forbidden runtime files. Inspect the package file list before committing. It must not contain credentials, `.env`, Factory key configuration, caches, databases, sessions, logs, or `node_modules`.

## Adding an extension

1. Add a self-contained directory under `extensions/` with an `index.ts` entrypoint.
2. Use relative imports for extension-owned code and `extensions/shared` only for genuinely shared behavior.
3. Put external runtime modules in root `dependencies`.
4. Add the exact entrypoint to root `package.json#pi.extensions`.
5. Add focused runtime tests and update `docs/EXTENSIONS.md`.
6. Run both validations and inspect the package payload.

Do not add nested package manifests or lockfiles to default-suite extensions. The workspace root owns their dependencies and tooling.

## Runtime configuration

Use `getAgentDir()` for user-level state and `CONFIG_DIR_NAME` for project-level Pi configuration. Use `node:path` and explicit platform branches where third-party credential locations differ. Never infer a writable location from `import.meta.url` or the managed Git checkout.

Keep secrets out of examples and fixtures. Tests should inject temporary roots, fake environment objects, or local test servers rather than reading real credentials.

## Skills paired with extensions

The root manifest declares `skills/background-terminals` and `skills/subagents`. Pi loads them directly from the managed Git package. Do not copy them into the agent directory from install scripts; that would create duplicates and leave stale files after removal.

When either skill changes, validate its structure and keep its behavior aligned with the corresponding extension tools.

## Optional memory

`packages/pi-memory` remains source-controlled in this repository but is absent from the root Pi manifest. It can be installed explicitly as a local subpackage from a trusted clone. Removing that local package disables memory without deleting its database.

## Current-machine cutover

Do not remove a working local extension set before the managed Git package is available.

1. Push and validate the private GitHub repository.
2. Run `pi install git:https://github.com/shariqriazz/shariq-pi-extensions`; do not reload yet.
3. Move old auto-discovered extension directories out of the active Pi extension directory so package and local copies cannot load together.
4. Move the old paired skill directories out of active discovery; the Git package supplies them.
5. Keep optional memory uninstalled and preserve its archived source and data.
6. Preserve Factory keys and Droid cache under `<agent-dir>/factory/` with restrictive permissions.
7. Run `/reload` once.
8. Verify package provenance through `pi list`, then check representative commands, tools, providers, and both packaged skills.

Rollback is the reverse: remove the Git package from Pi settings, restore the local extension and skill directories, and reload. Never delete credentials or databases during rollback.

## GitHub

GitHub is the only distribution source. Keep the repository private and push validated changes directly to `main` under the repository's normal Git policy.

```bash
git push origin main
gh repo view shariqriazz/shariq-pi-extensions --json visibility,url
```

Use an unpinned source for automatic extension updates. Use a tag or commit only when a machine should remain fixed to a known revision.
