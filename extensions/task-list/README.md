# Pi Task List

A branch-safe task list for ordinary multi-step work. The active model creates and maintains the list while it works; there is no background planner or separate task-list agent.

This extension is independent of the Goal extension. A normal task can use Task List without becoming a persistent goal, and an explicitly created goal can use its own evidence ledger and Task List at the same time.

## Model tool

`task_list` reads or replaces the current session list:

- omit `tasks` to read the current list;
- supply `tasks` to replace the entire ordered list;
- send stable IDs so progress survives revisions;
- use `explanation` when scope, order, or approach changes.

Each item has:

- `id` — stable letters/numbers/dots/underscores/hyphens identifier;
- `content` — a concrete outcome, including exact user-provided commands or literals when relevant;
- `status` — `pending`, `in_progress`, `completed`, `blocked`, or `cancelled`;
- `priority` — `high`, `medium`, or `low` (`medium` by default);
- `note` — optional evidence, blocker, cancellation reason, or execution detail.

A list may contain up to 64 items. A model write with pending work must keep at least one item `in_progress`. Sequential work should have one active item; several are allowed only when work is genuinely running in parallel.

## Update discipline

The tool definition and Pi prompt guidance explicitly require the model to:

1. create a list for requests with at least three distinct actions, multiple requested tasks, or meaningful phases;
2. skip the list for direct answers and one- or two-action work;
3. send the initial list in the same assistant message as the first real action;
4. update the list as each step changes instead of batching bookkeeping at the end;
5. mark work complete only after its outcome is verified;
6. preserve every user-requested item and exact command, flag, path, and success condition;
7. reconcile the full list before the final response.

The runtime reinforces these instructions without assigning the list to another worker:

- after two substantive tool calls with no list, the next model context receives a conditional reminder;
- routine file reads, edits, commands, and tool calls do not trigger bookkeeping updates while the current task remains active;
- the model updates only for task-level transitions: verified completion and handoff to the next task, genuine blockers or cancellations, user-requested scope changes, and final reconciliation;
- status-only inspection tools do not count as substantive progress.

The list remains a coordination aid, not evidence that implementation or verification succeeded.

## Continuity

Every update stores a complete immutable snapshot in Pi custom session entries. State is reconstructed from the active branch on startup, resume, reload, and tree navigation, so branching restores the list that belonged to that point in history.

Active items are injected into model context only when the current snapshot is no longer represented there, including after compaction. Completed and cancelled work is summarized by count in that continuity message so the model does not redo it.

No external task database or writable package file is used.

## Subagents

Pi subagents load this extension with their normal child resources. `task_list` is explicitly allowed under every child capability policy because it changes only the child session's planning state. Each child owns an independent list in its own persistent Pi session; a child does not mutate the parent model's list.

## User interface

Run:

```text
/tasks
```

While work is active, a compact widget above the editor shows progress and the current items. A finished list lingers for four seconds so the final checkmark is visible, then clears from the live chrome while remaining available in session history.

`/tasks` opens the full-width interactive dashboard:

- `↑`/`↓` or `j`/`k` — select an item;
- `space` — advance pending → in progress → completed;
- `b` — block/unblock;
- `c` — cancel/restore;
- `p` — cycle priority;
- `a` — add;
- `e` — edit;
- `d` — delete with confirmation;
- `h` — hide/show completed and cancelled items;
- `X` — clear the list with confirmation;
- `Esc` or `q` — close.

User edits automatically promote the next pending item when no task remains in progress. `/tasks clear` provides the same guarded clear action without opening the dashboard. In print, JSON, or RPC-oriented use, the tool remains fully functional and `/tasks status` falls back to a text summary where a custom terminal dashboard is unavailable.

## Design inputs

The implementation combines the strongest verified patterns from the compared harnesses:

- Pi's branch-aware tool-result/session-entry model and custom TUI surfaces;
- Codex's concise ordered plan, optional update explanation, and timely status transitions;
- OpenCode's whole-list replacement and persistent session projection;
- Grok Build's compact live panel, cancelled state, compaction continuity, and stale-list reminders;
- DeepSeek Harness's strict input validation, parallel-active policy, and dedicated composer panel;
- Hermes Agent's stable IDs, read-or-write tool, merge-informed state model, four-state UI, and post-compaction active-list injection;
- Factory Droid's same-message task/action rule, three-action threshold, real-time completion discipline, stale-plan warning, and compact TodoWrite presentation.

OpenClaw's inspected task/update surfaces do not provide a comparable model-maintained coding-session todo tool, so no incompatible lifecycle was copied from them.

## Validation

From the repository root:

```bash
bun test extensions/task-list extensions/subagents/context-config.test.ts
bun x tsc --noEmit
npm run validate
```
