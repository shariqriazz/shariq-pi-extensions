# Architecture

Last verified: 2026-08-20

## Package boundary

The repository has two Pi package boundaries:

- the repository root contains the default Git-installed suite;
- `packages/pi-memory` contains optional persistent memory and is never loaded by the root manifest.

Both packages declare exact entrypoints through `package.json#pi.extensions`. Pi therefore loads only intentional extension factories instead of scanning every TypeScript file.

## Source layout

```text
extensions/<name>/index.ts       default-suite entrypoints
extensions/<name>/src/           extension-owned implementation
extensions/shared/               runtime helpers shared across extensions
skills/                          operating guidance paired with async extensions
packages/pi-memory/              independent optional Pi package
docs/                            package-level maintenance documentation
scripts/                         repository validation helpers
```

Extension entrypoints register tools, commands, providers, events, or UI. Shared code stays in `extensions/shared` only when more than one extension owns the behavior. Provider-specific protocol and authentication code remains inside its provider directory. The background-terminal and subagent skills ship beside their extensions so a new machine receives the required lifecycle guidance with the tools.

## Dependency model

Pi-owned packages and `typebox` are optional peer dependencies at runtime. Pi supplies them when it loads the package. Exact versions are development dependencies so local typechecking and tests use a reproducible API surface.

Third-party runtime dependencies are normal package dependencies:

- `@lydell/node-pty` powers managed background terminals;
- `effect` powers subagent lifecycle and coordination.

The repository uses npm workspaces so the optional memory package shares one development lockfile without entering the default Pi manifest.

## Runtime state

Managed Git checkouts are treated as immutable. Extensions resolve writable state through Pi's APIs:

- Factory state: `<agent-dir>/factory/`
- Pi Memory state: `<agent-dir>/pi-memory/`
- Subagent configuration and catalog: paths derived from `getAgentDir()`
- project configuration: paths derived from Pi's `CONFIG_DIR_NAME`

Credentials remain in Pi auth storage, environment variables, service credential stores, or ignored machine-local files. Package source never contains an API key, OAuth token, database, cache, or session.

## Portability

Runtime paths use `node:path`, `getAgentDir()`, `CONFIG_DIR_NAME`, `os.homedir()`, and platform checks where service credential locations differ. Code must not assume `/Users`, `/home`, Homebrew, a particular shell, or a package installation path. Native PTY support is installed through npm for the active Node platform.

## Loading and updates

Pi installs this package under its managed Git directory. Updates can reset and clean that checkout, so user state must never be written beside extension source.

`pi config` controls individual resources in the default package. Pi Memory uses a separate package boundary because persistent memory should require an explicit installation rather than a default resource toggle.
