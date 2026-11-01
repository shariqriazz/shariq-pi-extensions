# Shariq's Pi extensions

Cross-platform extensions and skills for the [Pi](https://github.com/earendil-works/pi) coding agent. Credentials and runtime state stay on each machine and are never bundled with the package.

## Install

Install from npm:

```bash
pi install npm:shariq-pi-extensions
```

Or install the latest source from GitHub:

```bash
pi install git:https://github.com/shariqriazz/shariq-pi-extensions
```

Run `/reload` in an existing Pi session after installation; new sessions load the package automatically.

## Included extensions

- structured user questions (`ask_user`)
- persistent goals with evidence checklists and budgets
- a task list for multi-deliverable work, with a live progress dock
- Pi subagents with profiles, worktree isolation, a takeover dashboard, and an optional Fusion mode (lead plus persistent sidekick across light, medium, and heavy model tiers)
- Smart Compaction: structured checkpoints with file and worktree state
- managed background terminals
- optional image descriptions: a vision model replaces images with text as they enter the conversation
- optional WebP images: images are stored as lossy WebP, about a quarter of the size of PNG or JPEG
- Firecrawl web search, scraping, and developer search
- lightweight URL fetching
- Context Usage startup card
- per-response TPS, time-to-first-token, and output status
- configurable steer, interrupt, or follow-up Enter behavior
- `/exit` as an alias for `/quit`

The package also ships the `ember-warm-dark` theme and the `background-terminals`, `fusion`, and `subagents` skills. Pi loads the skills from the installed package; copying them into `<agent-dir>/skills` would leave stale duplicates after removal.

The suite is developed and tested against Pi 1.0. See [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) for commands, tools, configuration, and external dependencies.

## Enable or disable extensions

Open Pi's package configuration UI:

```bash
pi config
```

Toggle individual resources, save, and run `/reload`. Remove the installed package to disable the whole suite:

```bash
pi remove npm:shariq-pi-extensions
```

For a Git installation, use `pi remove git:https://github.com/shariqriazz/shariq-pi-extensions`.

## Update

```bash
pi update --extensions --no-approve
```

An npm installation follows published versions. An unpinned Git installation follows the repository's default branch; a source pinned to a tag or commit remains fixed until its reference is changed explicitly.

## Machine-local configuration

The repository never contains credentials. Configure authentication separately on each machine through Pi login, environment variables, or the service's normal credential store.

Runtime files use Pi's active agent directory rather than a fixed home or checkout path. This keeps the same package usable on macOS and Linux and prevents updates from overwriting state.

## Development

```bash
mise install --locked
mise exec --locked -- bun install
mise exec --locked -- bun run validate
mise exec --locked -- bun run pack:inspect
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for repository workflow and release checks, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for package boundaries.

## Credits and license

Parts of this suite began with work by [Ben Davis](https://github.com/davis7dotsh) and [Thomas Mustier](https://github.com/tmustier). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details.

Released under the [MIT License](LICENSE).
