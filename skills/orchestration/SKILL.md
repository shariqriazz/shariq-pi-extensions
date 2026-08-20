---
name: orchestration
description: Use only when the user explicitly asks to orchestrate a large task, use Orchestration, start or manage an orchestration run, configure orchestration role models, or explicitly names this skill. Do not use merely because a task is large, complex, multi-domain, or suitable for subagents; ordinary delegation remains owned by the subagents skill.
---

# Orchestration

Use the Orchestration extension as the control plane for an explicitly requested large task. Do not recreate its scheduling with direct subagent tools.

## Start and configure

- Prefer `/orchestration` for the interactive dashboard.
- Use `/orchestration settings` when the user wants to choose or change the global orchestrator, explorer, frontend, backend, general-worker, or reviewer model and thinking level.
- When the user explicitly requests orchestration in natural language, call `create_orchestration` with the complete objective and project directory.
- If role models are not configured, let the extension open its settings UI. Do not guess models for the user.

The dedicated orchestrator prepares the initial dependency-aware plan. Tell the user to open `/orchestration`, discuss or revise that plan there, and approve it once. After approval, do not ask the user to approve routine task launches, reviews, fixes, or integrations.

## During a run

The extension owns worker routing, concurrency, worktrees, review cycles, integration, recovery, and automatic orchestrator wake-ups. Use `get_orchestration` only when the user asks for status in conversation; do not poll it while agents run.

Do not call `spawn_agent`, `task`, `wait_agent`, `list_agents`, or related subagent controls to duplicate or accelerate orchestration work. The extension already uses the canonical Subagents runtime and enforces one 10-worker pool per project.

Direct the user to `/orchestration` when they want to:

- inspect runs, tasks, dependencies, reviews, or blockers;
- give feedback on the initial plan;
- approve the plan;
- pause, resume, recover, or cancel a run;
- change global role-model settings.

A run should interrupt the user only for a genuine blocker or a decision that changes requested scope. Interrupted runs recover paused and require explicit resume. Completion requires task reviews, final holistic review, and successful integration. The extension never commits or pushes the source repository.
