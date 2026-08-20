# Shariq's Pi extensions

Private, cross-platform Pi extensions and their operating skills maintained in one GitHub repository. Credentials and runtime state stay on each machine.

## Install

Install globally from the private repository:

```bash
pi install git:https://github.com/shariqriazz/shariq-pi-extensions
```

Git uses the machine's configured GitHub credentials. Run `/reload` in an existing Pi session after installation; new sessions load the package automatically.

## Included extensions

The default package contains:

- Antigravity OAuth provider
- structured user questions
- managed background terminals
- copy-all transcript support
- Factory OAuth and rotating API-key provider
- Firecrawl search and scraping
- Git status UI
- persistent task goals
- context-usage display
- small shell and command shortcuts
- Pi subagents
- lightweight URL fetching

The package also declares the `background-terminals` and `subagents` skills so Pi loads their operating guidance automatically. Pi reads them from its managed Git checkout; duplicating files under `<agent-dir>/skills` is unnecessary and would leave stale copies after removal.

See [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) for commands, tools, configuration, and external dependencies.

## Enable or disable extensions

Open Pi's package configuration UI:

```bash
pi config
```

Toggle individual resources, save, and run `/reload`. Remove the Git package to disable the whole suite:

```bash
pi remove git:https://github.com/shariqriazz/shariq-pi-extensions
```

## Optional Pi Memory

Pi Memory is included in this repository under [`packages/pi-memory`](packages/pi-memory), but it is deliberately absent from the root Pi manifest. Installing the default suite cannot activate memory.

To enable it from a trusted local clone, install the subpackage explicitly:

```bash
pi install <repo>/packages/pi-memory
```

Remove that same local package source and run `/reload` to disable memory. Its database remains under `<agent-dir>/pi-memory` unless it is archived separately.

## Update

```bash
pi update --extensions --no-approve
```

An unpinned Git installation follows the repository's default branch. A source pinned to a tag or commit remains fixed until its reference is changed explicitly.

## Machine-local configuration

The repository never contains credentials. Configure authentication separately on each machine through Pi login, environment variables, or the service's normal credential store.

Runtime files use Pi's active agent directory rather than a fixed home or checkout path. This keeps the same package usable on macOS and Linux and prevents updates from overwriting state.

## Development

```bash
mise install --locked
mise exec --locked -- npm ci
mise exec --locked -- npm run validate
mise exec --locked -- npm run validate --workspace packages/pi-memory
mise exec --locked -- npm run pack:inspect
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for repository workflow and cutover checks, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for package boundaries.

## Provenance

This repository contains adapted third-party code in a small number of extensions. Licenses and attribution are preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the relevant extension directories.
