# Pi subagents

Pi-only child agents with an Effect-managed lifecycle, persistent child sessions, configurable profiles, context forks, resumable runs, optional worktree isolation, and a live dashboard.

## Topology

Only the main Pi session starts subagents. Children can list and message existing peers through the main session's manager, but they never receive spawn, management, or batch tools, so agents cannot start agents.

## Parent tools

- `spawn_agent`: start one background child, optionally with a profile, persona, capability, context fork, model override, or isolated worktree. `resume_from` continues a finished child.
- `task`: start a batch of up to `maxConcurrent` children. Capacity is reserved for the whole batch, or none of it starts.
- `send_message`: steer a running child or start the next turn of an idle one.
- `wait_agent`: collect results that are already available; running children are listed as pending. It never blocks.
- `check_agent`: show one child's status and latest output.
- `list_agents`: list live and archived resumable children.
- `list_agent_profiles`: list profiles, personas, defaults, and the concurrency limit.
- `close_agent`: stop running children and keep their transcripts.
- `reply_question`: answer a child's blocking `ask_parent` question.
- `apply_agent_changes`: inspect, patch, cherry-pick, merge, or discard an isolated child's worktree.

All parent tools use `model-only` exposure, so codemode scripts cannot call them.

The tool guidance tells the model to delegate only when the user asks for delegation or parallel work.

Children receive `message_parent`, `ask_parent`, `list_peers`, and `message_peer`. Peer messages go through the main session's manager and can steer a running child or continue an idle one.

## Result delivery

A child's result is delivered to the parent as a custom message. If the parent is idle, the message starts a new parent turn. If the parent is busy, results wait in a private queue and are delivered together when the parent's run settles, with only the last one starting a turn. They never appear as user-authored or follow-up input. A result that `wait_agent` already returned is withdrawn from the queue, so it does not arrive a second time. Background Terminals uses the same queue.

## Profiles and capabilities

Built-in profiles:

- `general-purpose`: full access;
- `explore`: investigation with reads and command execution, no file edits;
- `plan`: investigation that ends in an implementation plan, no file edits.

Capability modes:

- `read-only`: allowlisted read and search tools plus parent communication;
- `read-write`: the read-only set plus `write` and `edit`, without shell execution;
- `execute`: the read-only set plus `bash` and background terminals, without direct edits;
- `all`: every tool the child loads.

Restrictive modes fail closed: an extension tool is unavailable until it is classified in `src/backends/pi.ts`, and a child-only `tool_call` check refuses unclassified tools at call time, including tools registered later. The session-only `task_list` tool is allowed in every mode.

## Runtimes and review options

Children run in-process by default: fast to start and light on memory. In-process children load the same packages and extensions as the parent but not Pi's built-in extensions (`codemode`, MCP, and tool search), because Pi does not export them to extensions. Each tool call inside an in-process child times out after three minutes.

A profile with `"runtime": "process"` runs each child as its own `pi --mode rpc` process instead. The child gets the full Pi setup, including the built-in extensions, and a crash or memory blowup stays in the child. The cost is a second or two of startup and a separate process per child. A child-only extension loaded with `-e` enforces the capability inside the process and carries `message_parent`, `ask_parent`, `list_peers`, and `message_peer` over Pi's RPC dialog protocol. Closing the parent closes the child's input, and the child shuts down.

`codemode` and `tool_search` are allowed in every capability mode; each tool a codemode script calls passes the same check, so a script cannot widen a child's capability.

Profiles can also shape what the child starts with. None of these settings reach the model:

- `"tools": ["read", "grep"]`: an exact allowlist on top of the capability;
- `"skills": false`: start without skills;
- `"contextFiles": false`: start without `AGENTS.md` and `CLAUDE.md` files, for an unbiased review;
- `"extensions": false`: start without discovered extensions.

User profiles and personas live in `<agent-dir>/subagents.json`. Trusted projects can override them in `.pi/subagents.json`:

```json
{
  "maxConcurrent": 6,
  "profiles": {
    "reviewer": {
      "description": "Review changes without editing",
      "instructions": "Find correctness and regression risks. Cite files and lines.",
      "capability": "execute"
    },
    "fresh-eyes": {
      "description": "Independent review that ignores repository instructions",
      "capability": "execute",
      "runtime": "process",
      "contextFiles": false
    }
  },
  "personas": {
    "concise": {
      "instructions": "Return only findings, evidence, and the recommended action."
    }
  }
}
```

Project configuration is ignored for untrusted projects. `maxConcurrent` is bounded to 1–50 and defaults to 50. `/subagents profiles` lists profiles, and `/subagents config` opens a validated editor for the global or trusted-project file.

## Fusion mode

Fusion mode is optional and off by default. When it is on, the main session acts as the lead and delegates without being asked: one persistent `sidekick` per workstream implements decided work, and light profiles take routine edits and checks. The lead keeps intent, planning, architecture, security, and final review. Turn it on with `/subagents fusion on`, or set `"fusion": true` in either configuration file; a trusted project's setting wins over the global one.

Fusion adds these profiles and tiers:

| Profile           | Tier   | Capability | Use                                                          |
| ----------------- | ------ | ---------- | ------------------------------------------------------------ |
| `sidekick`        | medium | all        | decided implementation and debugging from a concrete failure |
| `explore`         | medium | execute    | substantive read-only tracing                                |
| `reviewer`        | medium | execute    | one fresh review of a final diff                             |
| `worker`          | light  | all        | fully specified mechanical edits, docs, narrow tests         |
| `verifier`        | light  | execute    | builds, tests, and reproductions; reports failures only      |
| `general-purpose` | heavy  | all        | hard decided work after the sidekick is blocked              |

Each tier maps to a model and thinking level for children; the lead keeps the model you selected in Pi. An unset tier, or an unset field, inherits the parent session's, so with no `tiers` block every child runs on the parent's model:

```json
{
  "fusion": true,
  "tiers": {
    "light": { "model": "provider/fast-model", "thinking": "medium" },
    "medium": { "model": "provider/coding-model", "thinking": "xhigh" }
  }
}
```

Any profile can set `"tier"`, with or without Fusion mode. A profile's own `model` and `thinking` win over its tier, and a call's overrides win over both. Profiles you define with the same names are merged over the Fusion defaults, so you can change one field without restating the rest. `list_agent_profiles` and `/subagents profiles` show the mode, the tiers, and each profile's tier. A child started from a Fusion profile can still be resumed after the mode is turned off.

Only the lead sees the Fusion guideline and the `fusion` skill; children keep the default rules and cannot start agents.

## Context and continuation

New children start without parent context. `fork_turns` can be `all` or a positive number of recent user turns; the fork keeps user messages and final assistant text and drops thinking, tool calls, and tool results.

Every child has a persistent Pi session file. `resume_from` continues a finished or cancelled child with its transcript, tool state, and id, including after a parent reload or restart. An archived child resumes with its stored profile, persona, capability, and worktree unless the call overrides them, and takes its model and thinking level from that profile, its tier, or the call. A child still loaded in this session keeps its settings, so a resume call that passes different ones is rejected. A run interrupted by cancellation or reload is recorded as `cancelled`, not as a failure.

A child running in another Pi process cannot be resumed, and its worktree cannot be changed, until that process finishes or exits; a crashed owner is detected and its child becomes resumable.

Non-secret metadata is stored in the parent session and in `<agent-dir>/subagents/catalog.json`, so children started by another Pi process stay discoverable; catalog writes are locked across processes. Each child's transcript stays in its own Pi session file. Only live children appear in the Active work dock.

## Worktree isolation

Children share the workspace by default. `isolation: "worktree"` needs a clean source checkout. It creates a branch and a persistent git worktree from `HEAD` under `<agent-dir>/subagent-worktrees/`. A dirty source is rejected rather than giving the child stale code.

`apply_agent_changes` supports `inspect`, checked `patch` application, commit-preserving `cherry-pick`, `merge`, and `discard`. Cherry-pick and merge are tried in a temporary worktree first, so a conflict leaves the source checkout unchanged. `discard` asks for confirmation in interactive mode. A failed spawn removes the worktree it created.

## UI

Lifecycle tools render as compact cards with expandable detail. Running children appear in the shared **Active work** dock with elapsed time and their current tool.

- `/subagents` or `/subagents agents` opens the dashboard: a split list and inspector on wide terminals with status counts, model, profile, access, context use, current tool, queue, and latest output. Stopping a running child takes `x` twice.
- The takeover view shows the live transcript and accepts follow-up input.
- `/subagents peers` shows the peer-message log.
- `/btw <question>` starts a read-only side investigation owned by the user. It opens in the takeover view and records its answer without waking the parent model.

## Layout

- `src/manager.ts`: Effect service, lifecycle, snapshots, cancellation, and retention
- `src/backends/pi.ts`: in-process Pi child sessions, capability filtering, shared event translation, context seeding, resume, and the parent bridge
- `src/backends/pi-process.ts`: process-runtime children over Pi's RPC protocol
- `src/child-bridge.ts`: the extension loaded into process-runtime children for capability enforcement and the parent bridge
- `src/config.ts`: profiles, personas, validation, and limits
- `src/catalog.ts`: global resumable-agent catalog
- `src/context.ts`: context forks and profile prompt assembly
- `src/worktree.ts`: worktree creation, inspection, preflight, integration, and cleanup
- `src/runtime.ts`: managed runtime and backend registry
- `src/ui/`: dashboard, transcript, and takeover views
