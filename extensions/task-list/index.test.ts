import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import taskListExtension from "./index.ts";
import { activityDockSnapshot } from "../shared/activity-dock.ts";
import { TASK_LIST_ENTRY, buildUpdatedTaskList, emptyTaskListState, restoreTaskList } from "./state.ts";
import { TaskDashboard } from "./ui.ts";

function harness(branch: any[] = []) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries = [...branch];
  const sent: any[] = [];
  const widgets = new Map<string, unknown>();
  const statuses = new Map<string, unknown>();
  const notifications: any[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => `~${text}~`,
  };
  const keybindings = {
    matches: (data: string, name: string) => name === "tui.select.cancel" ? data === "\u001b" : false,
    getKeys: (name: string) => name.endsWith("up") ? ["↑"] : name.endsWith("down") ? ["↓"] : name.endsWith("cancel") ? ["esc"] : [],
  };
  const ui = {
    theme,
    setWidget(name: string, value: unknown) { widgets.set(name, value); },
    setStatus(name: string, value: unknown) { statuses.set(name, value); },
    notify(message: string, level: string) { notifications.push({ message, level }); },
    async confirm() { return true; },
    async input(_title: string, value: string) { return value; },
    async custom(factory: any) {
      const component = factory({ terminal: { rows: 28 }, requestRender() {} }, theme, keybindings, () => {});
      component.render(100);
      component.dispose?.();
      return { kind: "close" };
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/task-list.jsonl" },
    hasPendingMessages: () => false,
    isIdle: () => true,
  };
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data, id: `e${entries.length + 1}` });
    },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
  };
  taskListExtension(pi as never);
  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }
  return { handlers, tools, commands, entries, sent, widgets, statuses, notifications, ctx, ui, theme, keybindings, emit };
}

const initialTasks = [
  { id: "inspect", content: "Inspect the implementation", status: "in_progress" as const, priority: "high" as const },
  { id: "test", content: "Run focused tests", status: "pending" as const },
];

test("registers a whole-list tool, a narrow trigger, and /tasks", () => {
  const h = harness();
  const tool = h.tools.get("task_list");
  assert.ok(tool);
  assert.ok(h.commands.has("tasks"));
  assert.equal(tool.exposure, "model-only");
  assert.match(tool.description, /replaces the whole list/);
  assert.match(tool.description, /as its own tool call in the same response as the first real action, not inside a script/);
  assert.match(tool.description, /only when a task finishes/);
  assert.match(tool.description, /Never spend a turn only on the list/);
  const guidance = tool.promptGuidelines.join("\n");
  assert.match(guidance, /several separate deliverables/);
  assert.match(guidance, /single objective directly/);
  assert.doesNotMatch(guidance, /three distinct actions/);
});

test("writes, reads, persists, and summarizes the complete ordered list", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  const tool = h.tools.get("task_list");
  const updated = await tool.execute("t1", { tasks: initialTasks, explanation: "Starting implementation." }, undefined, undefined, h.ctx);
  assert.equal(updated.details.action, "update");
  // A write is acknowledged compactly; the model already holds the list it sent.
  assert.equal(updated.content[0].text, "Task list saved (revision 1): 0/2 completed · 1 active · 1 pending · 0 blocked · 0 cancelled. In progress: inspect.");
  assert.equal(updated.details.counts.total, 2);
  assert.equal(updated.details.counts.inProgress, 1);
  assert.equal(updated.details.state.tasks[0].priority, "high");
  assert.equal(updated.details.state.tasks[1].priority, "medium");
  assert.equal(h.entries.at(-1).customType, TASK_LIST_ENTRY);
  assert.ok(h.widgets.get("active-work"));
  assert.deepEqual(activityDockSnapshot(h.ctx.ui as never).map((item) => item.label), ["Tasks 1/2", "Tasks 2/2"]);
  assert.equal(h.statuses.get("task-list"), undefined);

  const read = await tool.execute("t2", {}, undefined, undefined, h.ctx);
  assert.equal(read.details.action, "read");
  assert.match(read.content[0].text, /\[>\] inspect: Inspect the implementation/);
  assert.deepEqual(read.details.state.tasks.map((task: any) => task.id), ["inspect", "test"]);
  await h.emit("session_shutdown");
});

test("rejects dropped execution discipline and malformed identities", () => {
  const empty = emptyTaskListState();
  assert.throws(() => buildUpdatedTaskList(empty, {
    tasks: [{ id: "later", content: "Do it later", status: "pending" }],
  }), /must be in_progress/);
  assert.throws(() => buildUpdatedTaskList(empty, {
    tasks: [
      { id: "same", content: "First", status: "in_progress" },
      { id: "same", content: "Second", status: "pending" },
    ],
  }), /Duplicate task id/);
  assert.throws(() => buildUpdatedTaskList(empty, {
    tasks: [{ id: "bad id", content: "Invalid id", status: "in_progress" }],
  }), /may contain only/);
});

test("restores the latest branch-local snapshot", () => {
  const first = buildUpdatedTaskList(emptyTaskListState(), { tasks: initialTasks });
  const second = buildUpdatedTaskList(first, {
    tasks: [
      { id: "inspect", content: "Inspect the implementation", status: "completed", priority: "high" },
      { id: "test", content: "Run focused tests", status: "in_progress" },
    ],
  });
  const branch = [
    { type: "custom", customType: TASK_LIST_ENTRY, data: { state: first } },
    { type: "custom", customType: TASK_LIST_ENTRY, data: { state: second } },
  ];
  const h = harness(branch);
  const restored = restoreTaskList(h.ctx as never);
  assert.equal(restored.revision, 2);
  assert.equal(restored.tasks[0].status, "completed");
  assert.equal(restored.tasks[1].status, "in_progress");
});

test("injects compaction-safe state without treating routine tools as task transitions", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.emit("tool_execution_start", { toolName: "task_list", toolCallId: "t1" });
  await h.tools.get("task_list").execute("t1", { tasks: initialTasks }, undefined, undefined, h.ctx);
  await h.emit("tool_execution_start", { toolName: "read", toolCallId: "r1" });
  await h.emit("tool_execution_start", { toolName: "edit", toolCallId: "e1" });
  await h.emit("tool_execution_start", { toolName: "bash", toolCallId: "b1" });
  const result = await h.emit("context", { messages: [] });
  const content = result.messages.map((message: any) => String(message.content)).join("\n");
  assert.match(content, /<task_list_state revision="1">/);
  assert.doesNotMatch(content, /task list is stale|update task_list now|keep the list current/i);
  await h.emit("agent_end");
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 0);
  await h.emit("session_shutdown");
});

test("a user-cleared list is reported only while the model still sees open work", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  const written = await h.tools.get("task_list").execute("t1", { tasks: initialTasks }, undefined, undefined, h.ctx);
  const seen = [{ role: "toolResult", toolName: "task_list", details: written.details }];
  assert.equal(await h.emit("context", { messages: seen }), undefined);
  await h.commands.get("tasks").handler("clear", h.ctx);
  const result = await h.emit("context", { messages: seen });
  assert.match(String(result.messages.at(-1).content), /The task list was cleared/);
  assert.equal(await h.emit("context", { messages: [] }), undefined);
  await h.emit("session_shutdown");
});

test("task text keeps user literals exactly", () => {
  const state = buildUpdatedTaskList(emptyTaskListState(), {
    tasks: [{ id: "file", content: "Rename ﬁle.txt", status: "in_progress", note: "keep ﬁ" }],
  });
  assert.equal(state.tasks[0]!.content, "Rename ﬁle.txt");
  assert.equal(state.tasks[0]!.note, "keep ﬁ");
});

test("never injects a reminder when work proceeds without a list", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.emit("input", { source: "interactive" });
  for (const toolName of ["read", "grep", "edit", "bash", "bash"]) {
    await h.emit("tool_execution_start", { toolName });
  }
  assert.equal(await h.emit("context", { messages: [] }), undefined);
  await h.emit("session_shutdown");
});

test("dashboard remains width-safe and exposes direct task controls", () => {
  const state = buildUpdatedTaskList(emptyTaskListState(), { tasks: initialTasks, explanation: "Focused implementation" });
  const actions: any[] = [];
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const theme = harness().theme;
  const keys = harness().keybindings;
  const dashboard = new TaskDashboard(tui as never, theme as never, keys as never, { getState: () => state }, (action) => actions.push(action));
  const lines = dashboard.render(72);
  assert.ok(lines.every((line) => visibleWidth(line) <= 72));
  assert.match(lines.join("\n"), /Task list/);
  assert.match(lines.join("\n"), /Inspect the implementation/);
  dashboard.handleInput(" ");
  assert.deepEqual(actions[0], { kind: "status", id: "inspect", status: "completed" });
});
