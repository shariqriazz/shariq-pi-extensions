import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import goalExtension from "./extension.ts";
import { GOAL_TOOL_NAMES, MAX_OBJECTIVE_CHARS } from "./constants.ts";

type Handler = (event: any, ctx: any) => any;

function harness(sessionFile: string | null = "/tmp/pi-goal-test.jsonl") {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const sent: any[] = [];
  const active = new Set<string>(GOAL_TOOL_NAMES);
  let sequence = 0;
  const customRenders: string[][] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ui = {
    theme,
    notifications: [] as any[],
    statuses: new Map<string, string | undefined>(),
    notify(message: string, level: string) { this.notifications.push({ message, level }); },
    setStatus(name: string, value: string | undefined) { this.statuses.set(name, value); },
    async confirm() { return true; },
    async editor(_title: string, value: string) { return value; },
    async custom(factory: any) {
      const component = factory(
        { terminal: { rows: 30 }, requestRender() {} },
        theme,
        { matches: () => false, getKeys: () => [] },
        () => {},
      );
      customRenders.push(component.render(100));
      component.dispose?.();
      return null;
    },
  };
  const sessionManager = {
    getSessionFile: () => sessionFile ?? undefined,
    getBranch: () => entries,
  };
  const ctx = {
    sessionManager,
    ui,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: `e${++sequence}`, customType, data }); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active.clear(); for (const name of names) active.add(name); },
  };
  goalExtension(pi as never);

  async function emit(name: string, event: any = {}) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  }
  function addAssistant(usage: { input: number; output: number }, stopReason = "stop", errorMessage?: string) {
    entries.push({
      type: "message",
      id: `e${++sequence}`,
      message: { role: "assistant", provider: "test", model: "test", content: [], usage: { ...usage, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: usage.input + usage.output, cost: {} }, stopReason, errorMessage, timestamp: Date.now() },
    });
  }
  async function shutdown() { await emit("session_shutdown"); }

  return { handlers, tools, commands, entries, sent, active, ctx, ui, customRenders, emit, addAssistant, shutdown };
}

test("saved sessions expose goal tools while ephemeral sessions hide them", async () => {
  const saved = harness();
  await saved.emit("session_start", { reason: "startup" });
  assert.deepEqual([...saved.active].sort(), [...GOAL_TOOL_NAMES].sort());
  await saved.shutdown();

  const ephemeral = harness(null);
  await ephemeral.emit("session_start", { reason: "startup" });
  assert.deepEqual([...ephemeral.active], []);
  await ephemeral.shutdown();
});

test("accounts only assistant usage after goal creation and includes final completion usage", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  h.addAssistant({ input: 900, output: 100 });
  await h.tools.get("create_goal").execute("c1", { objective: "Ship the feature", token_budget: 10_000 }, undefined, undefined, h.ctx);
  h.addAssistant({ input: 100, output: 20 });
  await h.emit("turn_end");
  h.addAssistant({ input: 50, output: 10 });
  const result = await h.tools.get("update_goal").execute("c2", { status: "complete" }, undefined, undefined, h.ctx);
  assert.equal(result.details.goal.tokensUsed, 180);
  assert.equal(result.details.goal.status, "complete");
  assert.match(result.details.completionBudgetReport, /Report final token/);
  await h.shutdown();
});

test("enforces the budget between model/tool turns", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.tools.get("create_goal").execute("c1", { objective: "Budgeted work", token_budget: 100 }, undefined, undefined, h.ctx);
  h.addAssistant({ input: 90, output: 20 });
  await h.emit("turn_end");
  const current = await h.tools.get("get_goal").execute("g1", {}, undefined, undefined, h.ctx);
  assert.equal(current.details.goal.status, "budget_limited");
  assert.equal(current.details.goal.tokensUsed, 110);
  assert.equal((h.sent.at(-1)?.message as any)?.details?.kind, "budget_limited");
  await h.shutdown();
});

test("supports blocked goals, usage-limit stops, and replacing completed goals", async () => {
  const blocked = harness();
  await blocked.emit("session_start", { reason: "startup" });
  await blocked.tools.get("create_goal").execute("c1", { objective: "Blocked work" }, undefined, undefined, blocked.ctx);
  await blocked.tools.get("update_goal_progress").execute(
    "p1",
    { items: [{ id: "dependency", title: "Obtain required external input", status: "blocked" }] },
    undefined,
    undefined,
    blocked.ctx,
  );
  await assert.rejects(
    blocked.tools.get("update_goal").execute("u0", { status: "blocked" }, undefined, undefined, blocked.ctx),
    /0\/3 goal turns/,
  );
  for (let turn = 0; turn < 2; turn++) {
    await blocked.emit("agent_start");
    await blocked.emit("tool_execution_start");
    await blocked.emit("agent_end", { messages: [] });
  }
  await blocked.emit("agent_start");
  const blockedResult = await blocked.tools.get("update_goal").execute("u1", { status: "blocked" }, undefined, undefined, blocked.ctx);
  assert.equal(blockedResult.details.goal.status, "blocked");
  await blocked.commands.get("goal").handler("resume", blocked.ctx);
  assert.equal((await blocked.tools.get("get_goal").execute("g1", {}, undefined, undefined, blocked.ctx)).details.goal.status, "active");
  await blocked.shutdown();

  const limited = harness();
  await limited.emit("session_start", { reason: "startup" });
  await limited.tools.get("create_goal").execute("c1", { objective: "Rate-limited work" }, undefined, undefined, limited.ctx);
  limited.addAssistant({ input: 10, output: 1 }, "error", "429 usage limit exceeded");
  await limited.emit("agent_settled");
  assert.equal((await limited.tools.get("get_goal").execute("g1", {}, undefined, undefined, limited.ctx)).details.goal.status, "usage_limited");
  await limited.shutdown();

  const completed = harness();
  await completed.emit("session_start", { reason: "startup" });
  await completed.tools.get("create_goal").execute("c1", { objective: "First" }, undefined, undefined, completed.ctx);
  await completed.tools.get("update_goal").execute("u1", { status: "complete" }, undefined, undefined, completed.ctx);
  const replacement = await completed.tools.get("create_goal").execute("c2", { objective: "Second" }, undefined, undefined, completed.ctx);
  assert.equal(replacement.details.goal.objective, "Second");
  assert.equal(replacement.details.goal.status, "active");
  await completed.shutdown();
});

test("checklist completion requires evidence and blocks premature goal completion", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.tools.get("create_goal").execute("c1", { objective: "Verified work" }, undefined, undefined, h.ctx);
  await h.tools.get("update_goal_progress").execute(
    "p1",
    { items: [{ id: "tests", title: "Run the relevant tests", status: "pending" }] },
    undefined,
    undefined,
    h.ctx,
  );
  await assert.rejects(
    h.tools.get("update_goal").execute("u1", { status: "complete" }, undefined, undefined, h.ctx),
    /checklist items remain unfinished/,
  );
  await assert.rejects(
    h.tools.get("update_goal_progress").execute(
      "p2",
      { items: [{ id: "tests", title: "Run the relevant tests", status: "complete" }] },
      undefined,
      undefined,
      h.ctx,
    ),
    /needs concrete evidence/,
  );
  await h.tools.get("update_goal_progress").execute(
    "p3",
    { items: [{ id: "tests", title: "Run the relevant tests", status: "complete", evidence: "npm test passed" }] },
    undefined,
    undefined,
    h.ctx,
  );
  const completed = await h.tools.get("update_goal").execute("u2", { status: "complete" }, undefined, undefined, h.ctx);
  assert.equal(completed.details.goal.status, "complete");
  assert.equal(completed.details.goal.progress[0].evidence, "npm test passed");
  await h.shutdown();
});

test("goal status renders the objective and checklist in the TUI panel", async () => {
  const h = harness();
  (h.ctx as any).mode = "tui";
  await h.emit("session_start", { reason: "startup" });
  await h.tools.get("create_goal").execute("c1", { objective: "Render visible progress" }, undefined, undefined, h.ctx);
  await h.tools.get("update_goal_progress").execute(
    "p1",
    { items: [{ id: "panel", title: "Render the progress panel", status: "in_progress" }] },
    undefined,
    undefined,
    h.ctx,
  );
  await h.commands.get("goal").handler("status", h.ctx);
  const rendered = h.customRenders.at(-1)?.join("\n") ?? "";
  assert.match(rendered, /Goal control center/);
  assert.match(rendered, /Render visible progress/);
  assert.match(rendered, /\[panel\] Render the progress panel/);
  assert.ok((h.customRenders.at(-1) ?? []).every((line) => visibleWidth(line) <= 100));
  await h.shutdown();
});

test("a narration-only run suppresses automatic continuation until resumed", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.tools.get("create_goal").execute("c1", { objective: "Keep making real progress" }, undefined, undefined, h.ctx);
  const sentBefore = h.sent.length;
  await h.emit("agent_start");
  await h.emit("agent_end", { messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const current = await h.tools.get("get_goal").execute("g1", {}, undefined, undefined, h.ctx);
  assert.equal(current.details.goal.status, "active");
  assert.equal(current.details.goal.continuationSuppressed.reason, "no_tool_progress");
  assert.equal(h.sent.length, sentBefore);
  await h.commands.get("goal").handler("resume", h.ctx);
  assert.equal((await h.tools.get("get_goal").execute("g2", {}, undefined, undefined, h.ctx)).details.goal.continuationSuppressed, null);
  assert.equal(h.sent.length, sentBefore + 1);
  await h.shutdown();
});

test("tool-backed work continues automatically at the next safe idle boundary", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.tools.get("create_goal").execute("c1", { objective: "Continue useful work" }, undefined, undefined, h.ctx);
  const sentBefore = h.sent.length;
  await h.emit("agent_start");
  await h.emit("tool_execution_start");
  await h.emit("agent_end", { messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(h.sent.length, sentBefore + 1);
  assert.equal((await h.tools.get("get_goal").execute("g1", {}, undefined, undefined, h.ctx)).details.goal.continuationSuppressed, null);
  await h.shutdown();
});

test("interruptions and ordinary run errors pause instead of bypassing the blocked gate", async () => {
  for (const [message, reason] of [["Request aborted by user", "interrupted"], ["provider connection failed", "error"]] as const) {
    const h = harness();
    await h.emit("session_start", { reason: "startup" });
    await h.tools.get("create_goal").execute("c1", { objective: "Recover safely" }, undefined, undefined, h.ctx);
    h.addAssistant({ input: 10, output: 1 }, "error", message);
    await h.emit("agent_settled");
    const current = await h.tools.get("get_goal").execute("g1", {}, undefined, undefined, h.ctx);
    assert.equal(current.details.goal.status, "paused");
    assert.equal(current.details.goal.continuationSuppressed.reason, reason);
    await h.shutdown();
  }
});

test("continuation steering includes strict completion and blocked audits", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.commands.get("goal").handler("Verify <all> requirements", h.ctx);
  const content = (h.sent.at(-1)?.message as any)?.content as string;
  assert.match(content, /Preserve the original scope/);
  assert.match(content, /at least three consecutive goal turns/);
  assert.match(content, /Verify &lt;all&gt; requirements/);
  await h.shutdown();
});

test("recovers assistant usage written after the latest persisted snapshot", async () => {
  const h = harness();
  h.entries.push({
    type: "custom",
    id: "snapshot",
    customType: "goal-state",
    data: { goal: { id: "goal-1", objective: "Recover accounting", status: "active", tokenBudget: 1_000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1, activeStartedAt: null } },
  });
  h.addAssistant({ input: 40, output: 2 });
  await h.emit("session_start", { reason: "resume" });
  const current = await h.tools.get("get_goal").execute("g1", {}, undefined, undefined, h.ctx);
  assert.equal(current.details.goal.tokensUsed, 42);
  await h.shutdown();
});

test("accepts objectives through 20,000 Unicode characters", async () => {
  assert.equal(MAX_OBJECTIVE_CHARS, 20_000);
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.tools.get("create_goal").execute("c1", { objective: "🧠".repeat(20_000) }, undefined, undefined, h.ctx);
  const current = await h.tools.get("get_goal").execute("g1", {}, undefined, undefined, h.ctx);
  assert.equal(Array.from(current.details.goal.objective).length, 20_000);
  await assert.rejects(h.tools.get("create_goal").execute("c2", { objective: "replacement" }, undefined, undefined, h.ctx), /unfinished goal/);
  await h.commands.get("goal").handler("clear", h.ctx);
  await assert.rejects(h.tools.get("create_goal").execute("c3", { objective: "x".repeat(20_001) }, undefined, undefined, h.ctx), /too long/);
  await h.shutdown();
});
