---
name: subagents
description: Use only when the user explicitly asks Pi to use subagents, delegate work, run agents in parallel, or explicitly names this skill. Do not invoke merely because a task is large, complex, multi-domain, or potentially parallelizable, and do not use for Codex persistent-thread orchestration.
compatibility: Pi with the Pi-only subagents extension and its spawn, task, messaging, question, profile, dashboard, and worktree tools.
---

# Pi subagents

Use Pi's flat child-agent system for explicitly authorized delegation. Each child has its own context window and session, cannot create more agents, and remains visible through `/subagents`.

## Activation boundary

Delegation requires an explicit user request. Task size or convenience alone is not authorization. If the user asks only to set up or explain delegation, do not start productive work beyond that request.

This skill governs temporary Pi child agents. The `codex-thread-orchestrator` skill separately governs persistent Codex task rosters; do not substitute one topology for the other.

## Choose the operation

- Use `spawn_agent` for one background child and `task` to start an atomic batch of independent background children. Both return immediately after startup.
- Use `send_message` to steer an existing child or start its next turn instead of spawning a duplicate.
- Use `check_agent` for one child’s current activity. `wait_agent` is also non-blocking: it collects results already available and reports the rest as pending.
- Use `close_agent` to interrupt exact running agents while preserving their partial transcripts.
- Use `list_agents` or `list_agent_profiles` only when live IDs, profiles, personas, or defaults are needed for an immediate decision.

## Wait by notification; inspect progress only when justified

A successful `spawn_agent` or `task` call starts asynchronous work and returns control to the parent. When a child finishes, its completion notice automatically starts the next main-agent turn. The parent does not need to remain active or check once before ending its turn.

After dispatch:

1. Continue only parent work that is independently useful to the requested result.
2. If no such work remains, end the turn immediately. A short progress note is enough when the user needs one.
3. Do not call `wait_agent`, `list_agents`, or `check_agent` in the same turn merely because the child was just launched. Ending the turn is the waiting mechanism.
4. Resume when a child completion notice invokes the main agent. Collect the completed result, launch any intentionally queued work if capacity requires waves, and otherwise keep waiting through notifications.

A progress check is reasonable when the user asks for status, a child has run materially longer than expected for its task and model, an interruption left its state unclear, or current status will change an immediate coordination decision. Prefer `check_agent` for one known child and `list_agents` for a batch overview. Use `wait_agent` to collect results already expected to be available, not as a running-status probe.

Do not turn reasonable inspection into polling. Never repeat status calls every few seconds, call them merely to watch elapsed time or context use, or keep the parent turn open while waiting. After a progress snapshot, act on it or end the turn. Check again only when the user asks, new evidence suggests a failure or stall, or another meaningful task-sized interval has elapsed and the answer will affect a real decision.

Do not create a loop, timer, `sleep`, watcher, or background terminal to schedule a later subagent check. Background terminals manage real external processes; they are not a waiting mechanism for subagents.

## Build complete assignments

When no parent context is forked, every child prompt must stand alone. State:

- the concrete objective and expected report or artifact;
- relevant paths, sources, and current facts;
- allowed scope and prohibited overlap;
- whether edits or execution are allowed;
- validation and evidence required before completion.

Even with `fork_turns`, keep the assignment explicit. Fork only the conversation needed for the task: `none` by default, a recent positive turn count when local history matters, and `all` only when the full sanitized conversation is materially necessary. Tool protocol and private reasoning are never inherited.

## Profiles, access, and isolation

Choose the narrowest capability that can complete the assignment:

- `read-only` for allowlisted inspection tools without command execution;
- `execute` for allowlisted inspection plus shell/background-terminal diagnostics without direct edit tools;
- `read-write` for allowlisted inspection plus direct file edits without command execution;
- `all` only when implementation and validation require unclassified extension tools or unrestricted access.

Restrictive capabilities fail closed for unclassified extension tools; use `all` only when that broader authority is actually required.

Use an established profile or persona when it matches; do not invent names without checking the catalog. Omit model and thinking overrides unless the task needs a deliberate choice, so the child inherits the parent defaults. When an override is necessary, use only an exact model/provider exposed by the current Pi registry or profile—never copy provider examples from another harness or assume one is installed.

Keep `isolation=none` for read-only work and shared-checkout work with clear ownership. Use a worktree only when concurrent writes could overlap or interfere. Worktree isolation requires a clean source checkout because the child branch starts from `HEAD`; if the source is dirty, commit or stash first or use the shared workspace. Worktree isolation is not a reason to delegate, and it does not authorize publication.

## Coordinate without losing ownership

Parallelize independent reads freely. Allow concurrent writes only across clearly separate surfaces. The parent remains responsible for resolving contradictions, inspecting actual changes, and validating the combined result.

Children can send updates, ask the parent a blocking question, and message peers. Answer a child question with `reply_question`; do not manufacture an answer when user authority is required. Keep peer messages scoped to concrete dependencies rather than broadcasting routine progress.

After starting background agents, follow the notification-driven waiting rule above. Do not manufacture parent work, status checks, commentary, timers, or terminal activity just to keep the turn open. When a batch result is required for the final answer, track the returned IDs and conclude only after every required completion notice and result has arrived.

## Integrate isolated changes

For a completed worktree agent, inspect before integration. Prefer `patch` when the source checkout contains unrelated work. Use cherry-pick or merge only with a clean source checkout and after the extension's preflight succeeds. Permanently discard a worktree only when that exact loss is intended and confirmed.

## Completion gate

A child report is evidence to review, not automatic proof of completion. Before answering the user:

1. Read the complete relevant result.
2. Inspect changed artifacts or live state.
3. Reconcile the work with the original request and boundaries.
4. Run proportionate parent-level validation when integration or interaction could introduce regressions.
5. Report verified results separately from unresolved child claims or residual risk.
