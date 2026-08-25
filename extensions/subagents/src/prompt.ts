/** All model-facing strings for the canonical Pi subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Start a flat, background Pi subagent with an optional profile, capability policy, or parent-context fork. Children may message existing peers but cannot spawn agents. The shared workspace is the default; use an isolated git worktree only when requested or needed to prevent concurrent edits from interfering. Completed children can be resumed with their transcript and tool state.";

export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Start an independent background worker with optional context or a configured profile";

export const WORKTREE_ISOLATION_DESCRIPTION =
  "Workspace isolation. Default none. Use worktree only with a clean source checkout when the user requests it, a configured profile requires it, or concurrent write tasks are likely to overlap or interfere. Read-only work and clearly separate edits should share the workspace.";

export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use spawn_agent for work that can proceed independently. Children may coordinate with existing peers but cannot spawn agents.",
  "Give spawn_agent a complete task when fork_turns is none. Use fork_turns only when prior conversation is materially required.",
  "Use list_agent_profiles when a task needs a configured profile or persona whose name or defaults are unknown.",
  "Use agent_type explore or capability read-only for investigation that must not modify files.",
  "Keep isolation none by default. Use worktree only with a clean source checkout when the user requests it, a configured profile requires it, or concurrent write tasks are likely to overlap or interfere. Do not isolate read-only work or clearly separate edits.",
  "After isolated work finishes, inspect it and use apply_agent_changes only when its changes should enter the source repository.",
  "Use resume_from to continue a completed child's existing context instead of restating its original task.",
  "After spawn_agent or task starts background work, continue useful parent work; otherwise end the turn so Pi remains available to the user.",
  "Do not poll background agents. Completion notices arrive automatically and wake the parent; wait_agent only collects results already available and reports running agents without blocking.",
  "When a completion notice invokes the parent, use its attached summary and continue the original task immediately; do not wait for another user message or call a status tool for the same result.",
];

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt: "Standalone task with context, paths, constraints, and expected report.",
  name: "Short name for listings/dashboard",
  workingDir: "Working directory; default current directory",
  model: 'Model hint ("provider/model-id" or id); default parent model.',
  reasoningEffort: "Thinking level; default parent level.",
  readonly: "Compatibility alias for read-only capability",
  isolation: WORKTREE_ISOLATION_DESCRIPTION,
};

export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  modelLabel: string;
  cwd: string;
  agentType?: string;
  capability?: string;
  isolation?: string;
  resumed?: boolean;
}) {
  const attributes = [
    options.modelLabel,
    options.agentType,
    options.capability,
    options.isolation === "worktree" ? "isolated worktree" : undefined,
    options.resumed ? "resumed" : undefined,
    options.cwd,
  ].filter(Boolean);
  return (
    `Started Pi subagent ${options.id} "${options.title}" (${attributes.join(", ")}).\n` +
    "It will report and wake the parent when finished. Continue useful work or end the turn instead of polling; when invoked by the result, continue the original task immediately."
  );
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Collect outputs already available for selected subagents without blocking. Running agents are reported as pending and will send completion notices automatically; omit ids to check all running subagents.";

export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Optional Pi subagent ids, e.g. ["sa-1", "sa-2"]',
};

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Close subagents, interrupting active work while preserving partial transcripts.";

export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Pi subagent ids to close, e.g. ["sa-1", "sa-2"]',
};

export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Inspect one subagent's status/latest activity without waiting or consuming its result.";

export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Pi subagent id",
};

export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List tracked subagents with status, model, context use, elapsed time, and cwd.";

export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error" | "cancelled";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : options.status === "cancelled" ? "was cancelled" : "finished";
  let text = `Pi subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
