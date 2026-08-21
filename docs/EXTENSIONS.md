# Extension catalog

Last verified: 2026-08-20

## Providers

### [Antigravity Provider](../extensions/antigravity-provider/README.md)

Registers the `antigravity` provider and `/login antigravity` flow for supported Google Antigravity models. Repeating login adds or updates accounts in the secure `<agent-dir>/antigravity/accounts.json` pool. Requests use quota-aware least-recently-used balancing, rotate before streaming on account-specific auth/rate/quota/capacity failures, honor known reset times, and refresh stored OAuth tokens. `/antigravity` shows account state and live model quotas and can enable or disable accounts; `/antigravity.doctor` reports sanitized provider and rotation diagnostics.

### [Cursor provider](../extensions/cursor-provider/README.md)

Registers one `cursor` provider for Cursor-hosted Composer and Cursor Grok models through the native Cursor SDK. `/login cursor` supports browser-minted or existing user API keys, images and native Pi tool delegation are enabled, and `/cursor` shows Cursor's authoritative current-month total, Auto/Composer and named/API percentages, reset date, plan, and on-demand limits. It does not expose ACP, third-party models, or Factory-style 5-hour/weekly pools. The authenticated catalog cache belongs in `<agent-dir>/cursor/models.json`.

### [Factory provider](../extensions/factory-provider/README.md)

Registers one `factory` provider with Factory account OAuth, direct API keys, or rotating API keys. `/factory` opens one full-width dashboard for provider/authentication state, model metadata, rotation status, and authoritative Factory usage across every credential. Standard and Droid Core windows stay separate, percentages are labeled as used, and keys are never aggregated. Rotation applies a monthly → weekly → 5-hour eligibility waterfall, then selects the least recently used eligible key and retains same-request failover for recognized pre-output errors. Background refreshes are throttled to 15 minutes; `r` force-refreshes from the dashboard.

Rotating keys belong in `<agent-dir>/factory/api-keys.json`. Droid metadata cache belongs in `<agent-dir>/factory/droid.json`. Refresh metadata explicitly after upgrading Droid:

```bash
FACTORY_DROID_REFRESH=1 pi --list-models factory
```

The curated catalog intentionally excludes `-fast` variants and the removals documented in `extensions/factory-provider/REFRESH_MODELS.md`.

## Agent workflow

### [Structured questions](../extensions/ask-user/README.md)

`ask_user` presents one blocking multiple-choice decision with an optional custom answer. It is intended for decisions that cannot be resolved safely from available context.

### [Goals](../extensions/goal/README.md)

The goal extension adds persistent, branch-safe objectives, progress evidence, budgets, pause/resume controls, and strict completion/blocker gates. Use `/goal` for the operator UI and the `create_goal`, `get_goal`, `update_goal_progress`, and `update_goal` tools for agent-controlled state.

### [Subagents](../extensions/subagents/README.md)

The subagent extension runs flat Pi child agents with profiles, capability policies, continuation, result delivery, optional worktrees, and a dashboard. Configuration lives in `<agent-dir>/subagents.json`; trusted projects may override it through their Pi config directory. The configured concurrency ceiling is 50.

The extension supplies tools including `spawn_agent`, `task`, `check_agent`, `list_agents`, `wait_agent`, `send_message`, `close_agent`, `reply_question`, and `apply_agent_changes`. Child settlement automatically sends a follow-up that starts the next parent turn; status tools are for explicit inspection, not waiting.

### [Orchestration](../extensions/orchestration/README.md)

The Orchestration extension coordinates explicitly requested large tasks through a dedicated orchestrator plus configurable explorer, frontend, backend, general-worker, and reviewer models. `/orchestration` opens the dashboard and `/orchestration settings` configures global role models. It reuses the canonical Subagents runtime, maintains a 10-worker pool per project, isolates Git writers in task worktrees, resumes the original worker for substantial review fixes, and applies final reviewed changes without committing or pushing.

The model-facing `create_orchestration` tool starts planning only after an explicit orchestration request. `get_orchestration` reports status without advancing work. Interrupted runs recover paused under `<agent-dir>/orchestration/`.

### [Background terminals](../extensions/background-terminals/README.md)

Managed PTYs support servers, watchers, long builds, downloads, and interactive processes. The extension tracks up to eight concurrent terminals, retains bounded output, stores full logs in restrictive temporary directories, and stops process groups during shutdown or reload.

Its tools are `start_terminal`, `read_terminal`, `write_terminal`, `list_terminals`, and `stop_terminal`. A model-started terminal automatically sends a completion or failure follow-up and starts the next parent turn. Reading a terminal no longer suppresses that delivery; agents should inspect only for explicit progress requests or immediate interaction.

## Web access

### [Firecrawl web](../extensions/firecrawl-web/README.md)

`web_search` discovers current web, news, images, GitHub, research, and PDF sources. `web_scrape` renders difficult or JavaScript-heavy pages. Authentication resolves from environment variables, the active Pi agent `.env`, or Firecrawl CLI credentials.

### [Web fetch](../extensions/web-fetch/README.md)

`web_fetch` retrieves a known HTTP or HTTPS URL without spending Firecrawl credits. It supports Markdown, text, and HTML output with bounded time and response size.

## Interface and quality of life

### [Context Usage](../extensions/context-usage/README.md)

Displays the estimated prompt and session contribution to the active context window. The default summary is a compact context-budget card; use `Ctrl+O` or `/context-usage` to cycle to compact and expanded audit views.

### [Performance status](../extensions/performance-status/README.md)

Adds a responsive footer-area status row for each assistant message. Live TPS/output are marked as estimates; final TPS uses conventional decode throughput from first streamed token to message completion. TTFT and total elapsed time separately expose provider latency, prefill, and hidden reasoning; output tokens and active tools remain separate.

### [Git info](../extensions/git-info/README.md)

Adds repository state to Pi's interface. `/lg` opens the local Git view and `/pr` exposes pull-request context when available.

### [Copy all](../extensions/copy-all/README.md)

`/copy-all` copies the current conversation in a readable form while omitting tool protocol noise that does not belong in the transcript.

### [Shell shortcuts](../extensions/shell-shortcuts/README.md)

Adds `/exit` as an alias for Pi's normal quit command. Keep this extension limited to small, low-risk conveniences.

## [Persistent memory](../extensions/pi-memory/README.md)

Pi Memory lives at `extensions/pi-memory` as an individually toggleable resource in the main package. It injects bounded relevant memories, queues asynchronous extraction, and stores durable state in SQLite under `<agent-dir>/pi-memory/`. Enable or disable it through `pi config`; disabling it does not delete its data.

## Per-extension details

Implementation-specific behavior and maintenance notes remain next to each extension in its own README. Package-wide installation, dependencies, state boundaries, and release rules belong in the root documentation.
