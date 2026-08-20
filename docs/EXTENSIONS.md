# Extension catalog

Last verified: 2026-08-20

## Providers

### Antigravity OAuth

Registers the `antigravity` provider and `/login antigravity` flow for supported Google Antigravity models. Use `/antigravity.doctor` to inspect non-secret provider status. Credentials remain in Pi auth storage.

### Factory provider

Registers one `factory` provider with Factory account OAuth, direct API keys, or rotating API keys. `/factory-status` reports catalog and authentication state without exposing keys.

Rotating keys belong in `<agent-dir>/factory/api-keys.json`. Droid metadata cache belongs in `<agent-dir>/factory/droid.json`. Refresh metadata explicitly after upgrading Droid:

```bash
FACTORY_DROID_REFRESH=1 pi --list-models factory
```

The curated catalog intentionally excludes `-fast` variants and the removals documented in `extensions/factory-provider/REFRESH_MODELS.md`.

## Agent workflow

### Structured questions

`ask_user` presents one blocking multiple-choice decision with an optional custom answer. It is intended for decisions that cannot be resolved safely from available context.

### Goals

The goal extension adds persistent, branch-safe objectives, progress evidence, budgets, pause/resume controls, and strict completion/blocker gates. Use `/goal` for the operator UI and the `create_goal`, `get_goal`, `update_goal_progress`, and `update_goal` tools for agent-controlled state.

### Subagents

The subagent extension runs flat Pi child agents with profiles, capability policies, continuation, result delivery, optional worktrees, and a dashboard. Configuration lives in `<agent-dir>/subagents.json`; trusted projects may override it through their Pi config directory. The configured concurrency ceiling is 50.

The extension supplies tools including `spawn_agent`, `task`, `check_agent`, `list_agents`, `wait_agent`, `send_message`, `close_agent`, `reply_question`, and `apply_agent_changes`.

### Background terminals

Managed PTYs support servers, watchers, long builds, downloads, and interactive processes. The extension tracks up to eight concurrent terminals, retains bounded output, stores full logs in restrictive temporary directories, and stops process groups during shutdown or reload.

Its tools are `start_terminal`, `read_terminal`, `write_terminal`, `list_terminals`, and `stop_terminal`.

## Web access

### Firecrawl web

`web_search` discovers current web, news, images, GitHub, research, and PDF sources. `web_scrape` renders difficult or JavaScript-heavy pages. Authentication resolves from environment variables, the active Pi agent `.env`, or Firecrawl CLI credentials.

### Web fetch

`web_fetch` retrieves a known HTTP or HTTPS URL without spending Firecrawl credits. It supports Markdown, text, and HTML output with bounded time and response size.

## Interface and quality of life

### Context Scope

Displays the estimated prompt and session contribution to the active context window. Use `Ctrl+O` or `/contextscope` to cycle summary, compact, and expanded views.

### Git info

Adds repository state to Pi's interface. `/lg` opens the local Git view and `/pr` exposes pull-request context when available.

### Copy all

`/copy-all` copies the current conversation in a readable form while omitting tool protocol noise that does not belong in the transcript.

### Shell shortcuts

Adds `/exit` as an alias for Pi's normal quit command. Keep this extension limited to small, low-risk conveniences.

## Optional persistent memory

Pi Memory is maintained under `packages/pi-memory` and published separately as `@shariqriazz/pi-memory`. It injects bounded relevant memories, queues asynchronous extraction, and stores durable state in SQLite under `<agent-dir>/pi-memory/`.

It is not part of the root package manifest. Installing or updating the default suite cannot activate memory.

## Per-extension details

Implementation-specific behavior and maintenance notes remain next to each extension in its own README. Package-wide installation, dependencies, state boundaries, and release rules belong in the root documentation.
