# Extension catalog

Each extension's README covers its full behavior. This page is the short version.

## Agent workflow

### [Structured questions](../extensions/ask-user/README.md)

`ask_user` shows one multiple-choice decision, with an optional written answer, when a missing user choice blocks safe progress. Outside the TUI it reports that no interactive answer is available.

### [Goals](../extensions/goal/README.md)

Persistent, branch-safe objectives with an evidence checklist, token budgets, pause and resume, automatic continuation, and strict completion and blocker gates. `/goal` opens the control center; the model uses `create_goal`, `get_goal`, `update_goal_progress`, and `update_goal`. Goals are created only on explicit request.

### [Task List](../extensions/task-list/README.md)

`task_list` keeps a branch-safe checklist for requests with several separate deliverables, long multi-phase work, or an explicit request for a plan. Single-objective work goes ahead without a list, and the extension never prompts the model to create one. When compaction removes the latest list from context, the unfinished items are added back. `/tasks` opens the dashboard and editor. Task List is independent of Goals and can run alongside one.

### [Subagents](../extensions/subagents/README.md)

Flat Pi child agents with profiles, capability policies, an optional per-profile process runtime that gives children Pi's built-in extensions (codemode, MCP, tool search), review options that drop skills or `AGENTS.md` files, context forks, resumable sessions, optional git worktree isolation, peer messaging, and a takeover dashboard. Children cannot start agents. The model delegates only when the user asks, unless optional Fusion mode is on: then the main session leads, a persistent `sidekick` implements decided work, and light `worker` and `verifier` profiles take routine edits and checks, each on a user-configured model tier. Results are delivered as custom messages that start a parent turn when the parent is idle. Configuration lives in `<agent-dir>/subagents.json`, with trusted-project overrides in `.pi/subagents.json`.

### [Smart Compaction](../extensions/smart-compaction/README.md)

Replaces Pi's compaction summary with a six-section checkpoint plus computed file, worktree, background-terminal, and running-subagent state. Summaries that are truncated, incomplete, or drop protected identifiers are rejected or repaired; if every retry fails, compaction is cancelled instead of falling back to a weaker summary. When the session model summarizes soon after its last request, the first attempt sends the live conversation again from the provider's prompt cache and asks for the checkpoint as the next turn. Exact repeats are collapsed with a count, and a transcript too large for one request is summarized in stretches, oldest first. An optional percent, hard, or hybrid threshold (default: 95% or 400,000 tokens, whichever is first), checked against the larger of reported usage and Pi's local estimate, adds an upper bound to Pi's own trigger, with an optional request byte ceiling that also bounds the messages kept after compaction and leaves the oldest images out of requests that compaction cannot bring under it. `/compaction-model` and `/smart-compaction` manage `<agent-dir>/smart-compaction.json`.

### [Background terminals](../extensions/background-terminals/README.md)

Managed PTYs for servers, watchers, long builds, and interactive programs: up to eight at once, bounded output in memory, private size-limited logs, and process-group shutdown on reload or exit. The model uses `start_terminal`, `read_terminal`, `write_terminal`, `list_terminals`, and `stop_terminal`; `/term` and `/ps` open the control center. When a model-started terminal exits, its result arrives as a custom message instead of requiring the model to poll.

## Web access

### [Firecrawl web](../extensions/firecrawl-web/README.md)

`web_search` finds web, news, image, GitHub, research, and PDF results. `web_scrape` extracts rendered or JavaScript-heavy pages. `dev_search` searches the Firecrawl Developer Index of technical docs, GitHub issues, pull requests, and READMEs. Credentials come from the environment, `<agent-dir>/.env`, or the Firecrawl CLI login.

### [Web fetch](../extensions/web-fetch/README.md)

`web_fetch` retrieves one known HTTP or HTTPS URL as Markdown, text, or HTML, with time and size limits and no Firecrawl credits. Local and private network addresses are blocked unless `PI_WEB_FETCH_ALLOW_PRIVATE=1` is set.

## Interface

### [Context Usage](../extensions/context-usage/README.md)

A startup card estimating how much of the context window the system prompt, `AGENTS.md` files, skill index, tools, and session take. `Ctrl+O` or `/context-usage` cycles summary, compact, and expanded views.

### [Performance status](../extensions/performance-status/README.md)

A status row for the current response with TPS, time to first token, elapsed time, output tokens, and the running tool. Live values are estimates; it clears eight seconds after the response ends.

### [Input mode](../extensions/input-mode/README.md)

`/input-mode` sets what Enter does while the agent runs: `steer` (default) queues the message before the next model step, `interrupt` aborts the run and resends the message, and `follow-up` waits until the run ends. The setting lives in `<agent-dir>/input-mode.json`.

### [Shell shortcuts](../extensions/shell-shortcuts/README.md)

Adds `/exit` as an alias for `/quit`.

## Tool exposure

Pi 1.0 lets each tool choose how the model reaches it. Tools that ask the user, manage lifecycles, or change session state (questions, goals, task list, starting, writing to, or stopping terminals, subagents) use `model-only` exposure: they stay declared to the model even with `codemode.mode: "only"`, and codemode scripts cannot call them. The read-only web tools and `read_terminal` and `list_terminals` keep the default `direct` exposure so scripts can call them in parallel and filter their output. Read-only tools also declare `readOnlyHint` annotations for permission extensions.