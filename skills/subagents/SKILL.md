---
name: subagents
description: Use only when the user explicitly asks Pi to use subagents, delegate work, run agents in parallel, or explicitly names this skill, or when Fusion mode is on. Do not invoke merely because a task is large, complex, multi-domain, or potentially parallelizable.
compatibility: Pi with the Pi-only subagents extension and its spawn, task, messaging, question, profile, dashboard, and worktree tools.
---

# Pi subagents

Pi child agents each get their own context window and persistent session, cannot start agents of their own, and stay visible in `/subagents`.

## Activation boundary

Delegate only when the user explicitly asks for it. Task size or convenience is not authorization. The exception is Fusion mode (`"fusion": true` in `subagents.json`): the user has already authorized delegation, and the `fusion` skill decides what to hand off. If the user asks only to set up or explain delegation, do not start productive work beyond that request.

## Choose the operation

- `spawn_agent` starts one background child; `task` starts a batch of independent children and reserves capacity for all of them or none. Both return as soon as the children start.
- `send_message` steers a running child or starts the next turn of an idle one. Use it instead of spawning a duplicate.
- `resume_from` on `spawn_agent` continues a finished or cancelled child with its full transcript, including children from earlier Pi sessions. It keeps the child's stored profile, capability, and worktree unless you override them; a child that is still loaded rejects overrides.
- `check_agent` shows one child's current activity. `wait_agent` collects results that are already available and lists the rest as pending; it never blocks.
- `close_agent` stops exact running children and keeps their partial transcripts.
- Use `list_agents` or `list_agent_profiles` only when you need live ids, profiles, personas, or defaults for an immediate decision.

## Wait by notification

When a child finishes, its summary arrives as a new message that starts your next turn. Results that land while you are still working are held and delivered together when your turn ends.

After dispatch:

1. Continue only parent work that is independently useful to the requested result.
2. If none remains, end the turn. A short progress note is enough when the user needs one.
3. Do not call `wait_agent`, `list_agents`, or `check_agent` in the same turn just because a child started. Ending the turn is the waiting mechanism.
4. When a result message starts your turn, treat it as the child's result and continue the original task: reconcile it, launch any queued follow-up work, and otherwise keep waiting for the remaining results. Do not wait for the user or call a status tool to fetch the same result.
5. When some children have finished and others are still running, never end a turn with an empty message; to the user that looks like a freeze. Write one short line, such as `3 of 5 workers done; waiting on the rest`, and end the turn.

Check progress only when the user asks, a child has run far longer than its task should take, an interruption left its state unclear, or the answer changes an immediate coordination decision. After a check, act on it or end the turn. Never poll on a schedule, and never use a loop, timer, `sleep`, or background terminal to schedule a later check.

## Write complete assignments

Without `fork_turns`, the child sees only its message. State:

- the objective and the report or artifact you expect;
- relevant paths, sources, and current facts;
- allowed scope and what it must not touch;
- whether it may edit files or run commands;
- the validation and evidence required before it reports done.

Keep `fork_turns` at `none` for implementation, testing, and documentation work. Use a positive number of recent turns only when that history materially matters, and `all` only when the full conversation is necessary. Forks copy user messages and final assistant text, never tool calls or thinking.

## Profiles, access, and isolation

Give each child the narrowest capability that can finish the work:

- `read-only`: inspection tools without `bash`, so the child cannot list or search for files. Use it only when the message names every file the child needs.
- `execute`: inspection plus shell and background terminals, without direct edit tools. Use it for audits and anything that must locate files, and tell the child to run only non-mutating commands.
- `read-write`: inspection plus direct file edits, without command execution.
- `all`: everything, including extension tools no other mode allows. Use it only when the work needs that.

Use an existing profile or persona when one fits; check `list_agent_profiles` rather than inventing names. Omit model and thinking overrides so children inherit the parent's, or the tier the user configured for their profile. Never move children to a more expensive model or higher thinking level unless the user asked; a batch of ten children multiplies that cost by ten. When an override is needed, use only a provider and model the current Pi registry exposes.

Keep `isolation` at `none` for read-only work and for writers with clearly separate files. When two or more children will write concurrently in a repository that compiles or typechecks, give each writer `isolation: "worktree"`, because half-finished edits in one checkout break each other's builds. Worktree isolation needs a clean source checkout; commit or stash first, or run the writers one after another. Isolation does not authorize publishing.

## Coordinate and integrate

Parallelize independent reads freely, and concurrent writes only across clearly separate files. You stay responsible for resolving contradictions and validating the combined result.

Children can send you updates, ask blocking questions, and message peers. Answer a question with `reply_question`; when the answer needs the user's authority, ask the user instead of inventing one.

Inspect a finished worktree child with `apply_agent_changes` before integrating it. Prefer `patch` when the source checkout has unrelated changes. Use `cherry-pick` or `merge` only on a clean checkout; both are tried in a temporary worktree first. Use `discard` only when losing that worktree is intended.

## Completion gate

A child's report is evidence to review, not proof. Before answering the user:

1. Read the complete result.
2. Inspect the changed files or live state.
3. Check the work against the original request and boundaries.
4. Run proportionate validation when integration could cause regressions.
5. Report verified results separately from claims you could not confirm.
