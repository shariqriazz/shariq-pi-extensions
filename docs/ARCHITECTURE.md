# Architecture

## Package boundary

The repository is one Pi package. Every extension is declared on its own in `package.json#pi.extensions`, so Pi loads only intended entrypoints and `pi config` can enable or disable each one.

## Source layout

```text
extensions/<name>/index.ts       extension entrypoint
extensions/<name>/src/           extension-owned implementation, when large enough to split
extensions/shared/               helpers used by more than one extension
skills/                          operating guidance shipped with the async extensions
themes/                          TUI themes
docs/                            package-level documentation
scripts/                         test runner and package validation
```

Entrypoints register tools, commands, events, renderers, and UI. Code moves to `extensions/shared` only when several extensions use the same contract. Two shared pieces tie the async extensions together:

- the **Active work** dock merges live rows from Task List, Background Terminals, and Subagents into one bounded widget;
- settlement delivery gives each Pi session one private queue for terminal and subagent results, delivered before the parent's run settles so the run continues with them, or at the idle edge when nothing is running.

The background-terminal and subagent skills ship beside their extensions, so a new machine gets the lifecycle guidance together with the tools.

## Model-facing text

Tool descriptions, parameter descriptions, prompt snippets, and prompt guidelines are sent with every model request, and guidelines become system-prompt rules. They cost tokens on every turn and are read literally. Each rule has one home: a tool's description says what it does and its contract, one guideline at most says when to use it, and longer operating guidance belongs in a skill. Extensions do not inject reminders that push the model toward a tool.

## Dependency model

Pi packages (`@earendil-works/pi-*`) and `typebox` are optional peer dependencies; Pi provides them at runtime. Pinned development dependencies give typechecking and tests a reproducible API surface. Third-party runtime modules are normal dependencies:

- `@lydell/node-pty` runs background terminals;
- `effect` runs the subagent lifecycle.

`bun.lock` is the lockfile CI installs from. `package-lock.json` is kept in sync for npm-based installs: Pi installs Git packages with `npm install`.

## Runtime state

Installed package directories are treated as read-only. Writable state goes through Pi's APIs:

- Smart Compaction settings: `<agent-dir>/smart-compaction.json`
- Input mode setting: `<agent-dir>/input-mode.json`
- Subagent configuration, catalog, run snapshots, and worktrees: under `getAgentDir()`
- Goal and Task List state: branch-local Pi session entries
- Project configuration: under Pi's `CONFIG_DIR_NAME`
- Terminal logs and oversized web responses: the system temporary directory

Credentials stay in Pi auth storage, environment variables, service credential stores, or ignored machine-local files.

## Portability

Paths are built with `node:path`, `getAgentDir()`, `CONFIG_DIR_NAME`, and `os.homedir()`, with platform branches only where a third-party credential location differs. No code assumes `/Users`, `/home`, Homebrew, a shell, or the package's install path. The PTY layer uses Bun's terminal API under Bun and `@lydell/node-pty` under Node.

## Loading and updates

Pi manages npm and Git installs and may replace their contents on update, so user state is never written beside extension source. Disabling an extension in `pi config` stops its factory from loading after `/reload`.
