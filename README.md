# Shariq's Pi extensions

Cross-platform extensions and operating skills for the Pi coding agent. Credentials and runtime state stay on each machine and are never bundled with the package.

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

The package contains:

- Antigravity OAuth provider with multi-account quota-aware rotation and `/antigravity` dashboard
- structured user questions
- managed background terminals
- copy-all transcript support
- Cursor OAuth/API-key provider with native SDK transport and monthly usage dashboard
- Factory OAuth and rotating API-key provider
- Firecrawl search and scraping
- Git status UI
- persistent task goals
- configurable steer, interrupt, or follow-up input behavior
- dedicated multi-agent orchestration
- Smart Compaction with high-fidelity checkpointing, delta-merging, and custom model routing
- Pi Memory
- per-response TPS, TTFT, elapsed-time, and output status
- Context Usage display
- small shell and command shortcuts
- Pi subagents
- lightweight URL fetching

The package also includes the `ember-warm-dark` TUI theme and declares the `background-terminals`, `orchestration`, and `subagents` skills so Pi loads their operating guidance automatically. Pi reads them from the installed package; duplicating files under `<agent-dir>/skills` is unnecessary and would leave stale copies after removal.

See [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) for commands, tools, configuration, and external dependencies.

## Enable or disable extensions

Open Pi's package configuration UI:

```bash
pi config
```

Toggle individual resources, including Pi Memory, save, and run `/reload`. Disabling Pi Memory stops capture and injection without deleting its database under `<agent-dir>/pi-memory/`. Remove the installed package to disable the whole suite:

```bash
pi remove npm:shariq-pi-extensions
```

For a Git installation, use `pi remove git:https://github.com/shariqriazz/shariq-pi-extensions`.

## Pi Memory

Pi Memory lives at [`extensions/pi-memory`](extensions/pi-memory) inside the same package as every other extension. Use `pi config` to enable or disable it independently; no second package installation is required. Its runtime database remains under `<agent-dir>/pi-memory/` whether the extension is enabled or disabled.

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
mise exec --locked -- npm ci
mise exec --locked -- npm run validate
mise exec --locked -- npm run pack:inspect
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for repository workflow and release checks, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for package boundaries.

## Credits and license

Parts of this suite began with work by [Ben Davis](https://github.com/davis7dotsh) and [Thomas Mustier](https://github.com/tmustier). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details.

Released under the [MIT License](LICENSE).
