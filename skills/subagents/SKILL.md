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

A successful `spawn_agent` or `task` call starts asynchronous work and returns control to the parent with sub-millisecond dispatch latency. When a child finishes, its settlement stays in a private extension queue while the parent is active and otherwise starts the next custom-result turn at Pi's safe idle edge, with the summary visible in model context without appearing as user-authored or follow-up input. The parent does not need to remain active or check once before ending its turn.

All subagent snapshots and transcripts persist across Pi restarts (`~/.pi/agent/subagents/runs/`), allowing `resume_from` to resume completed workers at any point. Cancellation immediately cascades across all child fibers in `<10ms`.

After dispatch:

1. Continue only parent work that is independently useful to the requested result.
2. If no such work remains, end the turn immediately. A short progress note is enough when the user needs one.
3. Do not call `wait_agent`, `list_agents`, or `check_agent` in the same turn merely because the child was just launched. Ending the turn is the waiting mechanism.
4. When a child completion notice invokes the main agent, treat its model-visible summary as the child result and continue the original task immediately. Reconcile completed results, launch any intentionally queued work if capacity requires waves, and otherwise keep waiting through notifications. Do not wait for the user to prompt you again or call a status tool to retrieve the same result.
5. When some children have settled and others are still running, never end the turn with an empty or whitespace-only message; to the user that looks like a freeze. Write one short line (for example `3 of 5 workers done; waiting on the rest`) and end the turn.

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

Even with `fork_turns`, keep the assignment explicit. Use `none` by default for implementation, testing, and documentation workers: a child does not need the parent's conversational history, corrections, or reprimands to do a bounded job. Fork a recent positive turn count only when local history materially matters, and `all` only when the full sanitized conversation is genuinely necessary. Tool protocol and private reasoning are never inherited.

## Profiles, access, and isolation

Choose the narrowest capability that can complete the assignment:

- `read-only` for allowlisted inspection tools without command execution. This strips `bash`, so the child cannot run `ls`, `find`, or `rg --files`. Use it only when the prompt already names every file the child needs; a child that has to discover files under `read-only` ends up guessing paths.
- `execute` for allowlisted inspection plus shell/background-terminal diagnostics without direct edit tools. This is the right floor for codebase audits, consistency checks, and anything that must locate files; tell the child in its prompt to run only non-mutating commands.
- `read-write` for allowlisted inspection plus direct file edits without command execution;
- `all` only when implementation and validation require unclassified extension tools or unrestricted access.

Restrictive capabilities fail closed for unclassified extension tools; use `all` only when that broader authority is actually required.

Use an established profile or persona when it matches; do not invent names without checking the catalog. Omit model and thinking overrides unless the task needs a deliberate choice, so the child inherits the parent defaults. A child inherits or downgrades the parent's model tier; never escalate children to a more expensive model or higher thinking level unless the user asked for that, since a batch of ten children multiplies the cost tenfold. When an override is necessary, use only an exact model/provider exposed by the current Pi registry or profile, never a provider example copied from another harness.

Keep `isolation=none` for read-only work and shared-checkout work with clear ownership. When two or more children will write concurrently to a repository that typechecks or compiles (TypeScript, Rust, Go, and similar), use `isolation=worktree` for each writer; concurrent edits in one checkout make builds and test runs fail against each other's half-finished changes. Worktree isolation requires a clean source checkout because the child branch starts from `HEAD`; if the source is dirty, commit or stash first or serialize the writers. Worktree isolation is not a reason to delegate, and it does not authorize publication.

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
