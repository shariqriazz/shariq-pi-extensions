# Pi Power Pack

[![npm](https://img.shields.io/npm/v/pi-power-pack)](https://www.npmjs.com/package/pi-power-pack)
[![Downloads as shariq-pi-extensions](https://img.shields.io/npm/dt/shariq-pi-extensions?label=downloads%20as%20shariq-pi-extensions)](https://www.npmjs.com/package/shariq-pi-extensions)
[![GitHub stars](https://img.shields.io/github/stars/shariqriazz/pi-power-pack)](https://github.com/shariqriazz/pi-power-pack)
[![CI](https://github.com/shariqriazz/pi-power-pack/actions/workflows/ci.yml/badge.svg)](https://github.com/shariqriazz/pi-power-pack/actions/workflows/ci.yml)

Subagents, background terminals, smart compaction, goals, a task list, structured questions, image, video, and audio understanding, WebP images, and web search for the [Pi](https://github.com/earendil-works/pi) coding agent, in one package where every extension can be switched on or off.

Formerly [`shariq-pi-extensions`](https://www.npmjs.com/package/shariq-pi-extensions), published on npm since August 2026 with 75 releases under that name. Same code and same author; only the name changed. See [Moving from shariq-pi-extensions](#moving-from-shariq-pi-extensions).

## Install

```bash
pi install npm:pi-power-pack
```

Or install the latest source from GitHub:

```bash
pi install git:https://github.com/shariqriazz/pi-power-pack
```

Run `/reload` in an open Pi session after installing; new sessions load the package automatically.

## What's included

Every extension can be turned off on its own with `pi config`. The defaults below are what a fresh install does.

| Extension                                                         | What it does                                                                                                                                                      | Default                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [Subagents](extensions/subagents/README.md)                       | Background Pi agents with profiles, worktree isolation, peer messaging, and a takeover dashboard. Delegates only when you ask, unless optional Fusion mode is on. | On; Fusion mode off                |
| [Background terminals](extensions/background-terminals/README.md) | Servers, builds, and long scripts run in managed terminals while the agent keeps working; results come back on their own.                                         | On                                 |
| [Smart Compaction](extensions/smart-compaction/README.md)         | Structured checkpoints that keep files, worktree state, and running work when the context fills up.                                                               | On (`/smart-compaction` to change) |
| [Goals](extensions/goal/README.md)                                | Long-running objectives with an evidence checklist and an optional token budget.                                                                                  | On                                 |
| [Task list](extensions/task-list/README.md)                       | A live progress list for work with several deliverables.                                                                                                          | On                                 |
| [Structured questions](extensions/ask-user/README.md)             | `ask_user` lets the agent ask you a multiple-choice question instead of guessing.                                                                                 | On                                 |
| [Media understanding](extensions/media-understanding/README.md)   | Image zoom and questions, video and audio questions, and image descriptions from a helper model.                                                                  | Off (`media-understanding.json`)   |
| [WebP images](extensions/webp-images/README.md)                   | Stores images as WebP, about a quarter of the size of PNG or JPEG, and sends JPEG to models without WebP support.                                                 | Off (`webp-images.json`)           |
| [Firecrawl web](extensions/firecrawl-web/README.md)               | `web_search`, `web_scrape`, and `dev_search` through Firecrawl.                                                                                                   | On when a Firecrawl API key is set |
| [Web fetch](extensions/web-fetch/README.md)                       | `web_fetch` reads one known URL without spending search credits.                                                                                                  | On                                 |
| [Context usage](extensions/context-usage/README.md)               | A startup card showing where your context goes.                                                                                                                   | On                                 |
| [Performance status](extensions/performance-status/README.md)     | Tokens per second, time to first token, and output status for each response.                                                                                      | On                                 |
| [Input mode](extensions/input-mode/README.md)                     | Choose whether Enter steers, interrupts, or queues a follow-up while the agent works.                                                                             | On, using Pi's normal steer        |
| [Shell shortcuts](extensions/shell-shortcuts/README.md)           | `/exit` as an alias for `/quit`.                                                                                                                                  | On                                 |

The package also ships the `ember-warm-dark` theme and the `background-terminals`, `fusion`, and `subagents` skills. Pi loads the skills from the installed package; copying them into `<agent-dir>/skills` would leave stale duplicates after removal.

The suite is developed and tested against Pi 1.0 on Linux and macOS. See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for commands, tools, configuration, and external dependencies.

## Turn extensions on or off

Open Pi's package configuration:

```bash
pi config
```

Toggle individual extensions, save, and run `/reload`. Extensions marked "Off" in the table also need their settings file under `<agent-dir>` before they do anything; each extension's README shows the settings.

To remove the whole package:

```bash
pi remove npm:pi-power-pack
```

For a Git installation, use `pi remove git:https://github.com/shariqriazz/pi-power-pack`.

## Update

```bash
pi update --extensions --no-approve
```

An npm installation follows published versions. An unpinned Git installation follows the repository's default branch; a source pinned to a tag or commit stays fixed until you change its reference. After an update, Pi shows what changed from [docs/CHANGELOG.md](docs/CHANGELOG.md).

## Moving from shariq-pi-extensions

`shariq-pi-extensions` is deprecated and gets no new releases. To switch:

```bash
pi remove npm:shariq-pi-extensions
pi install npm:pi-power-pack
```

Settings files such as `smart-compaction.json` and `subagents.json` keep working because they belong to each extension, not to the package. Extensions you turned off with `pi config` need turning off again, because Pi stores those choices per package. Do not install both packages at once; they register the same tools.

## Machine-local configuration

The repository never contains credentials. Configure authentication separately on each machine through Pi login, environment variables, or the service's normal credential store.

Runtime files use Pi's active agent directory rather than a fixed home or checkout path, so the same package works on macOS and Linux and updates never overwrite state.

## Development

```bash
mise install --locked
mise exec --locked -- bun install
mise exec --locked -- bun run validate
mise exec --locked -- bun run pack:inspect
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the repository workflow and release checks, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package boundaries.

## Credits and license

Follow updates on X: [@shariqriazzz](https://x.com/shariqriazzz).

Parts of this suite began with work by [Ben Davis](https://github.com/davis7dotsh) and [Thomas Mustier](https://github.com/tmustier). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

Released under the [MIT License](LICENSE).
