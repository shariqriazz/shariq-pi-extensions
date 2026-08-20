# Pi Goal extension

A Pi-native persisted-goal system using Pi session entries and lifecycle hooks, with evidence checklists, bounded continuation, and explicit user controls.

## Tools

- `create_goal` — explicitly create a goal; replaces an existing goal only when it is complete.
- `get_goal` — inspect objective, checklist, continuation state, status, budget, token usage, elapsed time, and remaining budget.
- `update_goal_progress` — maintain a structured checklist and evidence ledger.
- `update_goal` — mark a goal `complete` or `blocked` under strict, runtime-enforced completion and blocker rules.

Goal tools are active only for persisted Pi sessions. Temporary/`--no-session` children do not receive them.

## Statuses

- `active`
- `paused`
- `blocked`
- `usage_limited`
- `budget_limited`
- `complete`

Use `/goal [<objective>|status|clear|edit|pause|resume]` for host-side control. Bare `/goal` and `/goal status` open the fullscreen control center with progress and budget meters, objective and checklist panels, selected-item evidence, live waiting/blocker state, and keyboard actions for pause/resume, edit, and guarded clear. Completed goals can be replaced without confirmation; unfinished goals require confirmation. Paused, blocked, and usage-limited goals can be resumed.

## Lifecycle and accounting

- State is branch-safe and persisted as Pi custom session entries.
- Uncached input plus output usage is counted only while the goal is active.
- Usage is checkpointed after each model/tool turn, including the request that calls `update_goal`.
- Token limits stop work between tool turns rather than waiting for the outer agent run to finish.
- Interrupted runs and ordinary provider errors pause the goal without bypassing the blocker gate; exhausted usage/rate limits become `usage_limited`.
- Narration-only runs suppress further automatic continuation until the user resumes or steers the goal.
- Tool-backed active goals continue automatically when Pi becomes idle, after resume, and after `/reload`.
- Completed checklist items require concrete evidence. A goal with unfinished items cannot be marked complete.
- Blocking requires a specific blocked checklist item to persist for three goal turns.
- Continuation, completion-audit, blocked-audit, objective-update, and budget-limit steering follows current Codex behavior.

## Pi-specific policy

Pi allows goal objectives up to **20,000 Unicode characters**. Current Codex uses 4,000; this larger limit is intentional.

## Validation

From the repository root, run `npm run validate`.
