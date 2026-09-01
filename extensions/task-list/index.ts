import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clearActivitySource, setActivitySource, type ActivityState } from "../shared/activity-dock.ts";
import { oneLine } from "../shared/tui-dashboard.ts";
import {
  TASK_LIST_ENTRY,
  TASK_LIST_TOOL,
  MAX_TASKS,
  MAX_TASK_CONTENT_CHARS,
  buildUpdatedTaskList,
  copyTaskListState,
  emptyTaskListState,
  hasActiveTasks,
  restoreTaskList,
  taskCounts,
  taskListContext,
  taskListText,
} from "./state.ts";
import type {
  TaskItem,
  TaskListDetails,
  TaskListInput,
  TaskListSnapshot,
  TaskListState,
  TaskPriority,
  TaskStatus,
} from "./types.ts";
import { TASK_PRIORITIES, TASK_STATUSES } from "./types.ts";
import { openTaskDashboard, taskGlyph } from "./ui.ts";

const ACTIVITY_SOURCE = "task-list";
const FINISHED_LINGER_MS = 4_000;
const WORK_TOOL_EXCLUSIONS = new Set([
  TASK_LIST_TOOL,
  "get_goal",
  "list_agents",
  "check_agent",
  "wait_agent",
  "list_terminals",
  "pi_memory_status",
]);

const TaskListParams = Type.Object({
  tasks: Type.Optional(Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 80, description: "Stable identifier using letters, numbers, dots, underscores, or hyphens." }),
      content: Type.String({ minLength: 1, maxLength: 500, description: "Short, concrete task outcome. Preserve user-supplied commands and exact literals." }),
      status: StringEnum(TASK_STATUSES, { description: "pending | in_progress | completed | blocked | cancelled" }),
      priority: Type.Optional(StringEnum(TASK_PRIORITIES, { description: "Defaults to medium; use high only when order or urgency materially requires it." })),
      note: Type.Optional(Type.String({ maxLength: 1_000, description: "Concise evidence, blocker, cancellation reason, or execution detail." })),
    }, { additionalProperties: false }),
    { maxItems: 64, description: "The complete ordered task list. Supplying this field replaces the previous list." },
  )),
  explanation: Type.Optional(Type.String({ maxLength: 1_000, description: "Why the list changed, especially after a scope or approach change." })),
}, { additionalProperties: false });

function statusColor(status: TaskStatus): "accent" | "success" | "warning" | "error" | "muted" {
  if (status === "in_progress") return "accent";
  if (status === "completed") return "success";
  if (status === "blocked") return "error";
  if (status === "cancelled") return "muted";
  return "muted";
}

function terminal(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function summaryLine(state: TaskListState): string {
  const counts = taskCounts(state.tasks);
  return `${counts.completed}/${counts.total} completed · ${counts.inProgress} active · ${counts.pending} pending · ${counts.blocked} blocked · ${counts.cancelled} cancelled`;
}

function nextUniqueId(state: TaskListState, content: string): string {
  const base = content
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  const existing = new Set(state.tasks.map((task) => task.id));
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `task-${Date.now()}`;
}

export default function taskListExtension(pi: ExtensionAPI) {
  let state = emptyTaskListState();
  let lastCtx: ExtensionContext | null = null;
  let finishedTimer: ReturnType<typeof setTimeout> | undefined;
  let workCallsSinceUser = 0;
  let taskCallsSinceUser = 0;

  function cancelFinishedTimer(): void {
    if (!finishedTimer) return;
    clearTimeout(finishedTimer);
    finishedTimer = undefined;
  }

  function updatePresentation(ctx: ExtensionContext): void {
    lastCtx = ctx;
    cancelFinishedTimer();
    if (!ctx.hasUI || state.tasks.length === 0) {
      clearActivitySource(ctx, ACTIVITY_SOURCE);
      ctx.ui.setStatus(ACTIVITY_SOURCE, undefined);
      return;
    }

    const counts = taskCounts(state.tasks);
    const active = hasActiveTasks(state);
    const visible = (active
      ? state.tasks.filter((task) => !terminal(task.status))
      : state.tasks.slice(-3));
    setActivitySource(ctx, ACTIVITY_SOURCE, visible.map((task) => ({
      id: task.id,
      label: `Tasks ${state.tasks.findIndex((item) => item.id === task.id) + 1}/${counts.total}`,
      title: task.content,
      detail: task.status.replaceAll("_", " "),
      state: (task.status === "in_progress" ? "active" : task.status === "completed" ? "success" : task.status === "blocked" ? "error" : "muted") as ActivityState,
      priority: task.status === "blocked" ? 100 : task.status === "in_progress" ? 60 : 10,
    })));
    ctx.ui.setStatus(ACTIVITY_SOURCE, undefined);
    if (active) return;

    finishedTimer = setTimeout(() => {
      finishedTimer = undefined;
      if (lastCtx !== ctx || hasActiveTasks(state)) return;
      clearActivitySource(ctx, ACTIVITY_SOURCE);
      ctx.ui.setStatus(ACTIVITY_SOURCE, undefined);
    }, FINISHED_LINGER_MS);
    finishedTimer.unref?.();
  }

  function persist(ctx: ExtensionContext): void {
    lastCtx = ctx;
    pi.appendEntry(TASK_LIST_ENTRY, { state: copyTaskListState(state) } satisfies TaskListSnapshot);
    updatePresentation(ctx);
  }

  function replaceState(next: TaskListState, ctx: ExtensionContext): void {
    state = next;
    persist(ctx);
  }

  function ensureActiveTask(tasks: TaskItem[]): TaskItem[] {
    if (tasks.some((task) => task.status === "in_progress")) return tasks;
    const next = tasks.find((task) => task.status === "pending");
    return next
      ? tasks.map((task) => task.id === next.id ? { ...task, status: "in_progress" } : task)
      : tasks;
  }

  function mutateState(ctx: ExtensionContext, mutate: (tasks: TaskItem[]) => TaskItem[], explanation?: string): void {
    const timestamp = Date.now();
    const previous = new Map(state.tasks.map((task) => [task.id, task]));
    const next = ensureActiveTask(mutate(state.tasks.map((task) => ({ ...task }))));
    state = {
      revision: state.revision + 1,
      tasks: next.map((task) => {
        const prior = previous.get(task.id);
        const unchanged = prior && prior.content === task.content && prior.status === task.status && prior.priority === task.priority && prior.note === task.note;
        return { ...task, updatedAt: unchanged ? prior.updatedAt : timestamp };
      }),
      explanation,
      updatedAt: timestamp,
    };
    persist(ctx);
  }

  function currentRevisionVisible(messages: ReadonlyArray<unknown>): boolean {
    return messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      const candidate = message as { role?: string; toolName?: string; details?: Partial<TaskListDetails> };
      return candidate.role === "toolResult" && candidate.toolName === TASK_LIST_TOOL && (candidate.details?.state?.revision ?? -1) >= state.revision;
    });
  }

  function reminderText(): string | null {
    if (state.tasks.length === 0 && taskCallsSinceUser === 0 && workCallsSinceUser >= 2) {
      return "You have started multi-action work without task_list. If this request requires at least three distinct actions or contains multiple user tasks, create the complete list now and call task_list in the same assistant message as the next action. Do not create a retroactive list if the work is already complete or was genuinely trivial.";
    }
    return null;
  }

  pi.on("input", async (event) => {
    if (event.source === "extension") return;
    workCallsSinceUser = 0;
    taskCallsSinceUser = 0;
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    state = restoreTaskList(ctx);
    workCallsSinceUser = 0;
    taskCallsSinceUser = 0;
    updatePresentation(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreTaskList(ctx);
    updatePresentation(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    lastCtx = ctx;
    if (event.toolName === TASK_LIST_TOOL) taskCallsSinceUser++;
    else if (!WORK_TOOL_EXCLUSIONS.has(event.toolName)) workCallsSinceUser++;
  });

  pi.on("context", async (event) => {
    const additions: AgentMessage[] = [];
    if (hasActiveTasks(state) && !currentRevisionVisible(event.messages)) {
      additions.push({
        role: "custom",
        customType: "task-list-context",
        content: taskListContext(state),
        display: false,
        details: { revision: state.revision },
        timestamp: Date.now(),
      });
    }
    const reminder = reminderText();
    if (reminder) {
      additions.push({
        role: "custom",
        customType: "task-list-reminder",
        content: `<task_list_reminder>${reminder}</task_list_reminder>`,
        display: false,
        details: { revision: state.revision },
        timestamp: Date.now(),
      });
    }
    return additions.length > 0 ? { messages: [...event.messages, ...additions] } : undefined;
  });

  pi.on("session_shutdown", async () => {
    cancelFinishedTimer();
  });

  async function runDashboard(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(taskListText(state), "info");
      return;
    }
    while (true) {
      const action = await openTaskDashboard(ctx, { getState: () => state });
      if (action.kind === "close") return;
      if (action.kind === "clear") {
        if (!state.tasks.length) continue;
        const confirmed = await ctx.ui.confirm("Clear task list?", "This removes every current task from this session branch.");
        if (confirmed) mutateState(ctx, () => [], "Task list cleared by user.");
        continue;
      }
      if (action.kind === "add") {
        if (state.tasks.length >= MAX_TASKS) {
          ctx.ui.notify(`A task list can contain at most ${MAX_TASKS} items.`, "warning");
          continue;
        }
        const content = await ctx.ui.input("Add task", "Short, concrete outcome");
        const cleaned = content?.trim().normalize("NFKC");
        if (!cleaned) continue;
        if (Array.from(cleaned).length > MAX_TASK_CONTENT_CHARS) {
          ctx.ui.notify(`Task content exceeds ${MAX_TASK_CONTENT_CHARS} characters.`, "warning");
          continue;
        }
        const id = nextUniqueId(state, cleaned);
        mutateState(ctx, (tasks) => [...tasks, {
          id,
          content: cleaned,
          status: tasks.some((task) => task.status === "in_progress") ? "pending" : "in_progress",
          priority: "medium",
          updatedAt: Date.now(),
        }], "Task added by user.");
        continue;
      }
      const task = state.tasks.find((item) => item.id === action.id);
      if (!task) continue;
      if (action.kind === "edit") {
        const content = await ctx.ui.input("Edit task", task.content);
        const cleaned = content?.trim().normalize("NFKC");
        if (!cleaned) continue;
        if (Array.from(cleaned).length > MAX_TASK_CONTENT_CHARS) {
          ctx.ui.notify(`Task content exceeds ${MAX_TASK_CONTENT_CHARS} characters.`, "warning");
          continue;
        }
        mutateState(ctx, (tasks) => tasks.map((item) => item.id === task.id ? { ...item, content: cleaned } : item), "Task edited by user.");
      } else if (action.kind === "delete") {
        const confirmed = await ctx.ui.confirm("Delete task?", task.content);
        if (confirmed) mutateState(ctx, (tasks) => tasks.filter((item) => item.id !== task.id), "Task deleted by user.");
      } else if (action.kind === "status") {
        mutateState(ctx, (tasks) => tasks.map((item) => item.id === task.id ? { ...item, status: action.status } : item), "Task status changed by user.");
      } else if (action.kind === "priority") {
        mutateState(ctx, (tasks) => tasks.map((item) => item.id === task.id ? { ...item, priority: action.priority } : item), "Task priority changed by user.");
      }
    }
  }

  pi.registerCommand("tasks", {
    description: "Open the current session task list",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "clear"];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const command = args.trim().toLowerCase();
      if (!command || command === "status") {
        await runDashboard(ctx);
        return;
      }
      if (command === "clear") {
        if (!state.tasks.length) {
          ctx.ui.notify("No tasks to clear.", "info");
          return;
        }
        const confirmed = await ctx.ui.confirm("Clear task list?", "This removes every current task from this session branch.");
        if (!confirmed) return;
        mutateState(ctx, () => [], "Task list cleared by user.");
        ctx.ui.notify("Task list cleared.", "info");
        return;
      }
      ctx.ui.notify("Usage: /tasks [status|clear]", "warning");
    },
  });

  pi.registerTool({
    name: TASK_LIST_TOOL,
    label: "Task List",
    description: `Read or replace the ordered task list for this coding session. Omit tasks to read it. When tasks is supplied, it is the COMPLETE replacement list, not a patch.

Use task_list for work with at least three distinct actions, multiple user-requested tasks, or meaningful phases that need visible progress. Skip it for a direct answer or one or two simple actions.

Start the list before substantive work and call task_list in the SAME assistant message as the first action tool. Never spend a turn only announcing or updating the list when another action can run. Keep stable ids and preserve every user-requested item, exact command, flag, path, and success condition.

Update the list only when task-level state changes—not after every file read, edit, command, or tool call. When a task is fully verified, mark it completed, move the next sequential item to in_progress, and issue that next action in the same assistant message. Also update for genuine blockers, cancellations, or user-requested scope changes. Keep one in_progress task for sequential work; use several only when work is genuinely running in parallel.

Before the final response, reconcile the whole list with actual results. No item may remain pending or in_progress if the requested work is finished. Do not claim completion from the list itself.`,
    promptSnippet: "Read or replace the current session's complete task list and progress state.",
    promptGuidelines: [
      "Use task_list for requests with at least three distinct actions, multiple requested tasks, or meaningful phases; skip it for direct answers and one- or two-action work.",
      "Create task_list before substantive multi-step work and send the update in the same assistant message as the first real action; never spend a turn on task bookkeeping alone when another action exists.",
      "Every task_list write replaces the entire ordered list. Preserve stable ids, all unfinished and user-requested work, and exact commands, flags, paths, and success conditions.",
      "Update task_list only for task-level transitions: verified completion, starting the next task, a genuine blocker or cancellation, or a user-requested scope change. Do not update it after every file read, edit, command, or tool call. Pair transitions with the next action when work remains.",
      "Before a final response, reconcile task_list with observed results and leave no stale pending or in_progress items when the requested work is finished. The list is not proof of completion.",
    ],
    parameters: TaskListParams,
    async execute(_toolCallId, params: TaskListInput, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (params.tasks !== undefined) {
        replaceState(buildUpdatedTaskList(state, params), ctx);
      }
      const action = params.tasks === undefined ? "read" : "update";
      const details: TaskListDetails = {
        action,
        state: copyTaskListState(state),
        counts: taskCounts(state.tasks),
      };
      return {
        content: [{ type: "text", text: taskListText(state) }],
        details,
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action = args.tasks === undefined ? "read" : "update";
      const count = args.tasks?.length;
      text.setText(
        theme.fg("toolTitle", theme.bold("task_list ")) +
        theme.fg("muted", action) +
        (count == null ? "" : theme.fg("dim", ` · ${count} item${count === 1 ? "" : "s"}`)),
      );
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Updating task list…"));
        return text;
      }
      const details = result.details as TaskListDetails | undefined;
      if (!details) {
        const first = result.content[0];
        text.setText(first?.type === "text" ? first.text : "");
        return text;
      }
      const counts = details.counts;
      const complete = counts.total > 0 && counts.completed + counts.cancelled === counts.total;
      let output = theme.fg(complete ? "success" : "accent", complete ? "✓ " : "◆ ") + theme.fg("muted", summaryLine(details.state));
      const visible = expanded
        ? details.state.tasks
        : details.state.tasks.filter((task) => task.status === "in_progress" || task.status === "blocked").slice(0, 3);
      for (const task of visible) {
        const color = statusColor(task.status);
        const content = terminal(task.status) ? theme.strikethrough(oneLine(task.content)) : oneLine(task.content);
        output += `\n${theme.fg(color, taskGlyph(task.status))} ${theme.fg(color, content)}${task.note && expanded ? theme.fg("dim", ` — ${oneLine(task.note)}`) : ""}`;
      }
      if (!expanded && visible.length === 0 && counts.total > 0) {
        output += `\n${theme.fg("dim", complete ? "All tasks finished" : "No active task")}`;
      }
      text.setText(output);
      return text;
    },
  });
}
