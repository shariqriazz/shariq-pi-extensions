/** All model-facing strings for the canonical Pi subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Start a background Pi subagent and return its id. The child works in its own context and session, may message existing peers, and cannot start agents of its own. When it finishes, its summary arrives as a new message that starts your next turn. Use resume_from to continue a finished child with its full transcript.";

export const SUBAGENT_SPAWN_PROMPT_SNIPPET = "Delegate work to a background Pi subagent.";

export const WORKTREE_ISOLATION_DESCRIPTION =
  "Default none. Use worktree only when concurrent writers would overlap; it needs a clean source checkout.";

export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use spawn_agent or task only when the user asks to delegate or run work in parallel. Unless fork_turns is set, write a message that stands on its own: the goal, relevant paths, allowed scope, and the report you expect.",
  "Use agent_type explore or a read-only capability for investigation that must not edit files. Keep isolation none unless concurrent writers would overlap; review a worktree child's changes and bring them back with apply_agent_changes.",
  "After starting children, continue independent work or end the turn. Their results arrive as messages that start your next turn; continue from them instead of polling wait_agent, check_agent, or list_agents.",
];

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt: "Complete task: goal, context, paths, scope, and expected report.",
  name: "Short name for listings.",
  workingDir: "Working directory; default current.",
  model: 'Model as "provider/model-id" or id; default parent model.',
  reasoningEffort: "Thinking level; default parent level.",
  readonly: "Alias for capability read-only.",
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
    "Its result will arrive as a message that starts your next turn; continue other work or end this turn."
  );
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Collect subagent results that are already available, without waiting. Running agents are listed as pending; omit ids to check every running agent.";

export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids, such as ["sa-1"].',
};

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION = "Stop running subagents. Their partial transcripts are kept.";

export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids, such as ["sa-1"].',
};

export const SUBAGENT_CHECK_TOOL_DESCRIPTION = "Show one subagent's status and latest output without waiting.";

export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id.",
};

export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List subagents, including archived resumable ones, with status, model, context use, elapsed time, and cwd.";

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
