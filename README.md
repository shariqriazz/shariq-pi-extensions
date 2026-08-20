# Shariq's Pi extensions

Private, cross-platform Pi extensions and their operating skills maintained as one installable package. The suite keeps source code, tests, and release metadata in one repository while leaving credentials and runtime state on each machine.

## Install

### Private GitHub repository

Use SSH so Git can authenticate through the machine's configured GitHub key:

```bash
pi install git:git@github.com:shariqriazz/shariq-pi-extensions
```

### Private npm package

Authenticate npm first, then install the restricted package:

```bash
npm login
pi install npm:@shariqriaz/pi-extensions
```

Run `/reload` in an existing Pi session after installation. New sessions load the package automatically.

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

The package also declares the `background-terminals` and `subagents` skills so Pi loads the operating guidance automatically with those tools. Pi reads them from its managed package checkout; duplicating files under `<agent-dir>/skills` is unnecessary and would leave stale copies after removal. See [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) for commands, tools, configuration, and external dependencies.

## Enable or disable extensions

Open Pi's package configuration UI:

```bash
pi config
```

Toggle individual resources, save, and run `/reload`. Removing the package disables the whole suite:

```bash
pi remove git:git@github.com:shariqriazz/shariq-pi-extensions
# or
pi remove npm:@shariqriaz/pi-extensions
```

### Optional Pi Memory

Pi Memory is deliberately excluded from the default suite. Install it separately only when persistent memory is wanted:

```bash
pi install npm:@shariqriaz/pi-memory
```

Disable it without deleting its database:

```bash
pi remove npm:@shariqriaz/pi-memory
```

Its source remains in this repository under [`packages/pi-memory`](packages/pi-memory), but installing the main suite never loads it.

## Update

```bash
pi update --extensions --no-approve
```

Unpinned Git and npm installs follow their configured update source. A Git source pinned to a tag or commit stays pinned until the source reference is changed explicitly.

## Machine-local configuration

The package never contains credentials. Configure authentication separately on each machine through Pi login, environment variables, or the service's normal credential store.

Runtime files use Pi's active agent directory rather than a fixed home or checkout path. This keeps the same package usable on macOS and Linux and avoids writing into Git or npm installation directories.

## Development

```bash
mise install --locked
mise exec --locked -- npm ci
mise exec --locked -- npm run validate
mise exec --locked -- npm run validate --workspace @shariqriaz/pi-memory
mise exec --locked -- npm run pack:inspect
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for repository workflow and publication checks, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for package boundaries.

## Provenance

This repository contains adapted third-party code in a small number of extensions. Licenses and attribution are preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the relevant extension directories.
