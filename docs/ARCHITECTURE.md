# Architecture

Last verified: 2026-08-21

## Package boundary

The repository has one Pi package boundary at its root. Every extension, including Pi Memory, is an independently declared resource in `package.json#pi.extensions`. Pi therefore loads only intentional extension factories, and `pi config` can toggle each one without separate installation.

## Source layout

```text
extensions/<name>/index.ts       suite extension entrypoints
extensions/<name>/src/           extension-owned implementation
extensions/shared/               runtime helpers shared across extensions
skills/                          operating guidance paired with async extensions
docs/                            package-level maintenance documentation
scripts/                         repository validation helpers
```

Extension entrypoints register tools, commands, providers, events, or UI. Shared code stays in `extensions/shared` only when more than one extension owns the behavior. Provider-specific protocol and authentication code remains inside its provider directory. The background-terminal, orchestration, and subagent skills ship beside their extensions so a new machine receives the required lifecycle guidance with the tools.

## Dependency model

Pi-owned packages and `typebox` are optional peer dependencies at runtime. Pi supplies them when it loads the package. Exact versions are development dependencies so local typechecking and tests use a reproducible API surface.

Third-party runtime dependencies are normal package dependencies:

- `@cursor/sdk` powers native Cursor model runs, catalog discovery, images, tools, and usage reporting. It is bundled with the audited Undici override because npm consumers do not inherit dependency-level overrides; platform helpers remain optional per-OS dependencies;
- `@lydell/node-pty` powers managed background terminals;
- `effect` powers subagent lifecycle and coordination;
- `ws` powers Factory's Responses WebSocket transport.

The repository uses one root manifest and lockfile for the full extension suite.

## Runtime state

Installed package directories are treated as immutable. Extensions resolve writable state through Pi's APIs:

- Cursor's authenticated Composer/Grok catalog cache: `<agent-dir>/cursor/models.json`
- Factory key selection, Droid metadata, and throttled per-credential limit cache: `<agent-dir>/factory/`
- Smart Compaction configuration and details ledgers: `<agent-dir>/smart-compaction.json`
- Input mode configuration: `<agent-dir>/input-mode.json`
- Pi Memory state: `<agent-dir>/pi-memory/`
- Subagent configuration and catalog: paths derived from `getAgentDir()`
- Orchestration settings and run ledgers: `<agent-dir>/orchestration/`
- project configuration: paths derived from Pi's `CONFIG_DIR_NAME`

Credentials remain in Pi auth storage, environment variables, service credential stores, or ignored machine-local files. Package source never contains an API key, OAuth token, database, cache, or session.

## Portability

Runtime paths use `node:path`, `getAgentDir()`, `CONFIG_DIR_NAME`, `os.homedir()`, and platform checks where service credential locations differ. Code must not assume `/Users`, `/home`, Homebrew, a particular shell, or a package installation path. Native PTY support is installed through npm for the active Node platform.

## Loading and updates

Pi manages npm and Git package installations and may replace their contents during updates, so user state must never be written beside extension source.

`pi config` controls every individual package resource, including Pi Memory. Disabling Pi Memory leaves its runtime database intact and prevents its extension factory from loading after reload.
