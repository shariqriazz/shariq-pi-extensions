# Development and cutover

Last verified: 2026-08-21

## Requirements

- mise
- Pi matching the pinned development dependency version
- platform build support required by `@lydell/node-pty`

Install the exact Node toolchain and dependencies:

```bash
mise install --locked
mise exec --locked -- npm ci
```

## Validation

Validate the complete suite and inspect the package payload:

```bash
mise exec --locked -- npm run validate
mise exec --locked -- npm pack --dry-run
```

The root validation checks TypeScript, runtime tests, declared extension and skill entrypoints, and forbidden runtime files. Inspect the package file list before committing. It must not contain credentials, `.env`, Factory key configuration, first-party caches, databases, sessions, logs, or unbundled `node_modules`. The audited Cursor SDK tree is the sole intentional bundled dependency; its upstream implementation directories and tests remain third-party package content.

## Adding an extension

1. Add a self-contained directory under `extensions/` with an `index.ts` entrypoint.
2. Use relative imports for extension-owned code and `extensions/shared` only for genuinely shared behavior.
3. Put external runtime modules in root `dependencies`.
4. Add the exact entrypoint to root `package.json#pi.extensions`.
5. Add focused runtime tests and update `docs/EXTENSIONS.md`.
6. Run both validations and inspect the package payload.

Do not add nested package manifests or lockfiles to default-suite extensions. The workspace root owns their dependencies and tooling.

## Runtime configuration

Use `getAgentDir()` for user-level state and `CONFIG_DIR_NAME` for project-level Pi configuration. Use `node:path` and explicit platform branches where third-party credential locations differ. Never infer a writable location from `import.meta.url` or the installed package directory.

Keep secrets out of examples and fixtures. Tests should inject temporary roots, fake environment objects, or local test servers rather than reading real credentials.

## Skills paired with extensions

The root manifest declares `skills/background-terminals` and `skills/subagents`. Pi loads them directly from the managed Git package. Do not copy them into the agent directory from install scripts; that would create duplicates and leave stale files after removal.

When either skill changes, validate its structure and keep its behavior aligned with the corresponding extension tools.

## Pi Memory

Pi Memory is a normal root-package resource at `extensions/pi-memory`. It is declared separately in `package.json#pi.extensions`, so `pi config` can enable or disable it without affecting the other extensions. Its database stays under `<agent-dir>/pi-memory/` and must never be stored in the installed package directory.

## Current-machine cutover

Do not remove a working local extension set before the managed package is available.

1. Push and validate the public GitHub repository.
2. Run `pi install git:https://github.com/shariqriazz/shariq-pi-extensions`; do not reload yet.
3. Move old auto-discovered extension directories out of the active Pi extension directory so package and local copies cannot load together.
4. Move the old paired skill directories out of active discovery; the Git package supplies them.
5. Keep Pi Memory disabled through the package resource filter when memory should remain inactive; preserve its data under `<agent-dir>/pi-memory/`.
6. Preserve Factory keys and Droid cache under `<agent-dir>/factory/` with restrictive permissions.
7. Run `/reload` once.
8. Verify package provenance through `pi list`, then check representative commands, tools, providers, and both packaged skills.

Rollback is the reverse: remove the Git package from Pi settings, restore the local extension and skill directories, and reload. Never delete credentials or databases during rollback.

## Distribution

GitHub hosts the public source and npm distributes versioned releases. Push validated changes to `main` under the repository's normal Git policy.

```bash
git push origin main
gh repo view shariqriazz/shariq-pi-extensions --json visibility,url
```

Before publishing a new npm version:

1. Update `package.json#version` using semantic versioning.
2. Run `mise exec --locked -- npm ci` and `mise exec --locked -- npm run validate`.
3. Inspect `mise exec --locked -- npm run pack:inspect` for secrets, runtime state, and accidental files.
4. Run the `Publish npm package` workflow. npm trusted publishing authenticates it through GitHub OIDC and records provenance without a long-lived token.
5. Verify the registry version and install it with `pi install npm:shariq-pi-extensions`.

Use npm for stable versioned installs. Use an unpinned Git source for updates directly from `main`, and a tag or commit when a machine should remain fixed to a known revision.
