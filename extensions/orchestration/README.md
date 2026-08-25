# Orchestration

Orchestration coordinates large, explicitly requested software tasks through one dedicated orchestrator and configurable specialist agents. It uses the suite's Subagents runtime rather than creating a competing execution system.

## Workflow

1. Open `/orchestration`, choose **New**, and describe the objective.
2. The dedicated orchestrator creates a dependency-aware plan and routes tasks to explorer, frontend, backend, or general workers.
3. Review the plan in the dashboard. Give feedback if needed, then approve it once.
4. Workers run autonomously. Git-backed writing tasks use one worktree per task; non-Git projects allow only one writer at a time.
5. The configured reviewer checks each task, may make small obvious fixes, and sends larger findings back to the same worker session with its existing context.
6. Reviewed changes integrate into a temporary orchestration branch. A final holistic review gates application to the source checkout.
7. The extension applies the reviewed result without committing or pushing.

The orchestrator sleeps while agents work and wakes automatically at execution boundaries. It asks the user only for a genuine blocker or scope-changing decision.

## Roles and settings

Use `/orchestration settings` to choose a global provider/model and thinking level for:

- orchestrator
- explorer
- frontend worker
- backend worker
- general worker
- reviewer

Settings are stored with restrictive permissions under Pi's active agent directory at `orchestration/settings.json`. They apply globally and are changed only through the settings UI.

Each project has up to 10 concurrent worker, explorer, or reviewer sessions. The dedicated orchestrator does not consume one of those slots. Multiple projects may run concurrently with independent pools.

## Dashboard

Orchestration creation and inspection render as compact main-chat cards with expandable detail. Active runs appear in the shared bounded **Active work** dock; plan-ready and blocked runs are prioritized as attention states. `/orchestration` opens the full-screen operations dashboard. Dashboard actions close the overlay before opening editors, settings, or confirmation prompts, then return to the live dashboard so nested UI cannot stall.

- `j` / `k`: select a run
- `Enter`: inspect tasks and reviews
- `n`: create a run
- `s`: configure role models
- `a`: approve the initial plan
- `f`: give plan feedback
- `p`: pause, resume, or recover
- `x`: leave the dashboard and confirm cancellation while preserving artifacts
- `Esc`: go back or close

Interrupted runs recover in a paused state and require explicit resume. Run state is machine-local under Pi's active agent directory at `orchestration/runs/<run-id>/`.

## Safety boundaries

- Orchestration starts only from `/orchestration` or an explicit natural-language request.
- A Git source checkout must be clean before writing begins.
- Writing workers never share a Git worktree.
- Reviewers make only small localized fixes; larger fixes return to the original worker session.
- A task gets at most two automatic fix rounds before the run blocks.
- Source changes integrate sequentially only after review.
- The extension never commits or pushes the source repository.
- Agent thinking is not copied into orchestration artifacts.
- Disabling Subagents makes Orchestration unavailable rather than falling back to another runtime.
