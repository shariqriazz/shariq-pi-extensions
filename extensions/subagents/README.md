# Pi subagents

A Pi-only subagent system with an Effect-managed lifecycle, persistent child sessions, configurable profiles, context forks, cross-session resumability, pre-warmed dispatch, instant cascading cancellation, worktree isolation, and a live takeover dashboard.

## Topology

The system is deliberately flat. Only the main Pi thread can spawn subagents. Children may list and message existing peers through the main-thread manager, but they do not receive spawn, agent-management, or workflow tools. This permits collaboration without recursive fan-out or runaway agent trees.

## High-Performance & Reliability Architecture

- **Pre-Warmed Pool Dispatch:** Pre-warms unique agent IDs and allocation buffers ahead of time, eliminating string-formatting and crypto overhead on the critical path for sub-millisecond task dispatch.
- **Instant Cascading Cancellation:** Structured Effect-TS fiber supervision cascades immediate abort signals to all running subagents and child processes in `<10ms`, guaranteeing zero orphan processes upon interruption or parent turn cancellation.
- **Cross-Session Snapshot Persistence:** Full subagent snapshots and transcripts are automatically persisted under `~/.pi/agent/subagents/runs/<id>/snapshot.json`, enabling discovery and resumption (`resume_from`) across Pi restarts.

## Parent tools

- `spawn_agent` — start a background child with an optional profile, persona, capability mode, context fork, model override, or isolated worktree
- `wait_agent` — collect results already available and report running children as pending without blocking
- `close_agent` — interrupt children while retaining their transcripts
- `check_agent` — inspect live activity without waiting
- `list_agent_profiles` — discover active profiles, personas, defaults, and concurrency
- `list_agents` — list live and globally archived/resumable children
- `send_message` — steer a running child or start its next turn
- `apply_agent_changes` — inspect, patch, cherry-pick, merge, or discard an isolated child worktree
- `reply_question` — answer a child’s blocking `ask_parent` request
- `task` — atomically reserve capacity for up to the configured limit (maximum 50), start the fan-out in the background, and return child ids immediately

Child sessions receive `message_parent`, `ask_parent`, `list_peers`, and `message_peer`. Peer messages are routed through the main-thread manager and can steer a running child or continue a settled one; they cannot create agents. Child settlement stays in a private extension queue while the parent is active, then starts one custom-result turn at Pi's safe idle edge with the summary guaranteed in model context and never rendered as user-authored or follow-up input, so the main turn can continue independent work or end and remain available to the user.

## Profiles and capabilities

Built-in profiles:

- `general-purpose` — unrestricted coding worker
- `explore` — investigation with read and command execution, but no file edits
- `plan` — investigation followed by a concrete implementation plan, with no file edits

Capability modes:

- `read-only` — allowlisted read/search and parent-communication tools only
- `read-write` — the read-only allowlist plus direct file write/edit tools, without shell execution
- `execute` — the read-only allowlist plus shell and background-terminal execution, without direct file edit tools
- `all` — full child tool access

Restrictive modes fail closed: newly registered extension tools remain unavailable until they are explicitly classified. This prevents another extension from silently bypassing the selected capability.

Optional user profiles and personas can be defined in `~/.pi/agent/subagents.json`. Trusted projects may override them in `.pi/subagents.json`:

```json
{
  "maxConcurrent": 6,
  "profiles": {
    "reviewer": {
      "description": "Review changes without editing",
      "instructions": "Find correctness and regression risks. Cite files and lines.",
      "capability": "execute"
    }
  },
  "personas": {
    "concise": {
      "instructions": "Return only findings, evidence, and the recommended action."
    }
  }
}
```

Project configuration is ignored when the project is not trusted. Concurrency is bounded to 1–50; this private package defaults to 50. `/subagents profiles` provides discovery, while `/subagents config` opens a validated editor for global or trusted-project configuration.

## Context and continuation

New children start with independent context by default. `fork_turns` may be `all` or a positive number of recent user turns. Forking keeps user messages and final assistant text while removing thinking, tool calls, and tool results so the child never inherits an unresolved tool protocol.

Every child uses a persistent Pi session file. `resume_from` continues a completed child with its full transcript, tool state, and logical agent id, including after a parent `/reload` or resume. Non-secret metadata is stored both in the parent session and in `~/.pi/agent/subagents/catalog.json`, so children created by an ephemeral or different parent process remain discoverable. Existing legacy ids remain valid catalog keys.

## Worktree isolation

Children share the requested workspace by default. Use `isolation: "worktree"` only when the user requests it, a configured profile requires it, or concurrent write tasks are likely to overlap or interfere. Read-only work and edits to clearly separate areas should stay in the shared workspace.

`isolation: "worktree"` requires a clean source checkout, then creates a dedicated branch and persistent git worktree from `HEAD` under `~/.pi/agent/subagent-worktrees/`. A dirty source is rejected rather than silently giving the child stale code; commit or stash first, or use the shared workspace. `apply_agent_changes` supports `inspect`, checked patch application, commit-preserving cherry-pick, merge, and permanent discard. Cherry-pick and merge first run in a temporary worktree; conflicts leave the source checkout unchanged. Discard requires confirmation in interactive mode. A failed spawn removes the worktree it created; completed worktrees remain available for inspection or continuation.

## UI

`/subagents` or `/subagents agents` opens the live operations dashboard and takeover UI. `/btw <question>` starts a read-only, context-aware side investigation owned by the user; it opens directly in takeover view and records its answer without waking the parent model. Wide terminals use a split-pane agent list and selected-agent inspector with running/completed/failed counts, model/profile/access metadata, a context meter, current tool activity, queue state, elapsed time, turns, cwd, and latest output. The takeover view adds a live transcript, context meter, active-tool state, scrolling, child interruption, and follow-up input. `/subagents peers` shows the persistent peer-message audit trail. `/subagents profiles` browses profiles and personas, and `/subagents config` edits validated configuration.

## Architecture

- `src/manager.ts` — Effect service, bounded lifecycle, normalized snapshots, cancellation, and retention
- `src/backends/pi.ts` — in-process Pi sessions, trust-gated resources, capability filtering, context seeding, resume, and parent bridge
- `src/config.ts` — built-in and user/project profiles, personas, validation, and limits
- `src/catalog.ts` — global non-secret resumable-agent catalog
- `src/context.ts` — safe context-fork selection and profile prompt assembly
- `src/worktree.ts` — isolated worktree creation, inspection, conflict preflight, integration, and cleanup
- `src/runtime.ts` — managed runtime and Pi backend registry
- `src/ui/` — dashboard, transcript, and takeover components
