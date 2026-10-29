import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  taskListUpdateText,
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

const TaskListParams = Type.Object(
  {
    tasks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({
              minLength: 1,
              maxLength: 80,
              description: "Stable id: letters, numbers, dots, underscores, hyphens.",
            }),
            content: Type.String({
              minLength: 1,
              maxLength: 500,
              description: "Concrete outcome. Keep user-supplied commands and literals exact.",
            }),
            status: StringEnum(TASK_STATUSES),
            priority: Type.Optional(StringEnum(TASK_PRIORITIES, { description: "Default medium." })),
            note: Type.Optional(
              Type.String({ maxLength: 1_000, description: "Evidence, blocker, or cancellation reason." }),
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 64, description: "The complete ordered list; replaces the previous one." },
      ),
    ),
    explanation: Type.Optional(Type.String({ maxLength: 1_000, description: "Why the list changed." })),
  },
  { additionalProperties: false },
);

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
  const base =
    content
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
  // Pi passes a fresh context to every event, so the linger timer is tied to a
  // presentation generation rather than context identity.
  let presentationGeneration = 0;

  function cancelFinishedTimer(): void {
    if (!finishedTimer) return;
    clearTimeout(finishedTimer);
    finishedTimer = undefined;
  }

  function updatePresentation(ctx: ExtensionContext): void {
    lastCtx = ctx;
    cancelFinishedTimer();
    const generation = ++presentationGeneration;
    if (!ctx.hasUI || state.tasks.length === 0) {
      clearActivitySource(ctx, ACTIVITY_SOURCE);
      ctx.ui.setStatus(ACTIVITY_SOURCE, undefined);
      return;
    }

    const counts = taskCounts(state.tasks);
    const active = hasActiveTasks(state);
    const visible = active ? state.tasks.filter((task) => !terminal(task.status)) : state.tasks.slice(-3);
    setActivitySource(
      ctx,
      ACTIVITY_SOURCE,
      visible.map((task) => ({
        id: task.id,
        label: `Tasks ${state.tasks.findIndex((item) => item.id === task.id) + 1}/${counts.total}`,
        title: task.content,
        detail: task.status.replaceAll("_", " "),
        state: (task.status === "in_progress"
          ? "active"
          : task.status === "completed"
            ? "success"
            : task.status === "blocked"
              ? "error"
              : "muted") as ActivityState,
        priority: task.status === "blocked" ? 100 : task.status === "in_progress" ? 60 : 10,
      })),
    );
    ctx.ui.setStatus(ACTIVITY_SOURCE, undefined);
    if (active) return;

    finishedTimer = setTimeout(() => {
      finishedTimer = undefined;
      if (generation !== presentationGeneration || hasActiveTasks(state)) return;
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
    return next ? tasks.map((task) => (task.id === next.id ? { ...task, status: "in_progress" } : task)) : tasks;
  }

  function mutateState(ctx: ExtensionContext, mutate: (tasks: TaskItem[]) => TaskItem[], explanation?: string): void {
    const timestamp = Date.now();
    const previous = new Map(state.tasks.map((task) => [task.id, task]));
    const next = ensureActiveTask(mutate(state.tasks.map((task) => ({ ...task }))));
    state = {
      revision: state.revision + 1,
      tasks: next.map((task) => {
        const prior = previous.get(task.id);
        const unchanged =
          prior &&
          prior.content === task.content &&
          prior.status === task.status &&
          prior.priority === task.priority &&
          prior.note === task.note;
        return { ...task, updatedAt: unchanged ? prior.updatedAt : timestamp };
      }),
      explanation,
      updatedAt: timestamp,
    };
    persist(ctx);
  }

  function visibleTaskListStates(messages: ReadonlyArray<unknown>): TaskListState[] {
    return messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const candidate = message as { role?: string; toolName?: string; details?: Partial<TaskListDetails> };
      if (candidate.role !== "toolResult" || candidate.toolName !== TASK_LIST_TOOL || !candidate.details?.state)
        return [];
      return [candidate.details.state as TaskListState];
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    state = restoreTaskList(ctx);
    updatePresentation(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreTaskList(ctx);
    updatePresentation(ctx);
  });

  // Re-inject an unfinished list only when compaction or branching removed the
  // latest snapshot from model context. Never prompt the model to start a list.
  // A finished or cleared list is sent only when the model can still see an
  // older revision with open work (for example, after a dashboard edit).
  pi.on("context", async (event) => {
    const visible = visibleTaskListStates(event.messages);
    if (visible.some((seen) => seen.revision >= state.revision)) return undefined;
    if (!hasActiveTasks(state) && !visible.some((seen) => hasActiveTasks(seen))) return undefined;
    const continuity: AgentMessage = {
      role: "custom",
      customType: "task-list-context",
      content: taskListContext(state),
      display: false,
      details: { revision: state.revision },
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, continuity] };
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
        const confirmed = await ctx.ui.confirm(
          "Clear task list?",
          "This removes every current task from this session branch.",
        );
        if (confirmed) mutateState(ctx, () => [], "Task list cleared by user.");
        continue;
      }
      if (action.kind === "add") {
        if (state.tasks.length >= MAX_TASKS) {
          ctx.ui.notify(`A task list can contain at most ${MAX_TASKS} items.`, "warning");
          continue;
        }
        const content = await ctx.ui.input("Add task", "Short, concrete outcome");
        const cleaned = content?.trim();
        if (!cleaned) continue;
        if (Array.from(cleaned).length > MAX_TASK_CONTENT_CHARS) {
          ctx.ui.notify(`Task content exceeds ${MAX_TASK_CONTENT_CHARS} characters.`, "warning");
          continue;
        }
        const id = nextUniqueId(state, cleaned);
        mutateState(
          ctx,
          (tasks) => [
            ...tasks,
            {
              id,
              content: cleaned,
              status: tasks.some((task) => task.status === "in_progress") ? "pending" : "in_progress",
              priority: "medium",
              updatedAt: Date.now(),
            },
          ],
          "Task added by user.",
        );
        continue;
      }
      const task = state.tasks.find((item) => item.id === action.id);
      if (!task) continue;
      if (action.kind === "edit") {
        // editor() prefills the current text; input() would only show it as a placeholder.
        const content = await ctx.ui.editor("Edit task", task.content);
        const cleaned = content?.trim();
        if (!cleaned) continue;
        if (Array.from(cleaned).length > MAX_TASK_CONTENT_CHARS) {
          ctx.ui.notify(`Task content exceeds ${MAX_TASK_CONTENT_CHARS} characters.`, "warning");
          continue;
        }
        mutateState(
          ctx,
          (tasks) => tasks.map((item) => (item.id === task.id ? { ...item, content: cleaned } : item)),
          "Task edited by user.",
        );
      } else if (action.kind === "delete") {
        const confirmed = await ctx.ui.confirm("Delete task?", task.content);
        if (confirmed)
          mutateState(ctx, (tasks) => tasks.filter((item) => item.id !== task.id), "Task deleted by user.");
      } else if (action.kind === "status") {
        mutateState(
          ctx,
          (tasks) => tasks.map((item) => (item.id === task.id ? { ...item, status: action.status } : item)),
          "Task status changed by user.",
        );
      } else if (action.kind === "priority") {
        mutateState(
          ctx,
          (tasks) => tasks.map((item) => (item.id === task.id ? { ...item, priority: action.priority } : item)),
          "Task priority changed by user.",
        );
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
        const confirmed = await ctx.ui.confirm(
          "Clear task list?",
          "This removes every current task from this session branch.",
        );
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
    description: `Read or replace this session's ordered task list. Omit tasks to read it. Supplying tasks replaces the whole list, so include every item to keep, with stable ids. While pending work remains, keep at least one item in_progress.

Send the first list as its own tool call in the same response as the first real action, not inside a script and not in a turn of its own. Update the list only when a task finishes, is blocked or cancelled, or the scope changes, and pair the update with the next action. Never spend a turn only on the list: when the last result finishes the work, give the final response without a separate update. The list records progress but does not prove it.`,
    promptSnippet: "Track a visible plan for multi-deliverable work.",
    promptGuidelines: [
      "Use task_list only when the user asks for a plan or checklist, the request has several separate deliverables, or long multi-phase work benefits from visible progress. Work on a single objective directly, even when it takes many reads, edits, and test runs.",
    ],
    exposure: "model-only",
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
        content: [{ type: "text", text: action === "read" ? taskListText(state) : taskListUpdateText(state) }],
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
      let output =
        theme.fg(complete ? "success" : "accent", complete ? "✓ " : "◆ ") +
        theme.fg("muted", summaryLine(details.state));
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
