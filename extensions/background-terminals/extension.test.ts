import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

function addHook(hooks: Map<string, (...args: any[]) => any>) {
  return (name: string, handler: (...args: any[]) => any) => {
    const previous = hooks.get(name);
    hooks.set(name, previous
      ? (...args: any[]) => { previous(...args); handler(...args); }
      : handler);
  };
}

test("registers the PTY tool surface, control-center commands, and lifecycle cleanup", () => {
  const tools = new Map<string, any>();
  const commands: string[] = [];
  const hooks: string[] = [];
  const renderers: string[] = [];
  extension({
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand(name: string) { commands.push(name); },
    registerMessageRenderer(name: string) { renderers.push(name); },
    on(name: string) { hooks.push(name); },
    sendMessage() {},
    sendUserMessage() {},
  } as never);

  assert.deepEqual([...tools.keys()], [
    "start_terminal",
    "read_terminal",
    "write_terminal",
    "list_terminals",
    "stop_terminal",
  ]);
  assert.deepEqual(commands, ["term", "ps"]);
  assert.deepEqual(renderers, ["background-terminal-result"]);
  assert.ok(hooks.includes("session_start"));
  assert.ok(hooks.includes("agent_start"));
  assert.ok(hooks.includes("agent_settled"));
  assert.ok(hooks.includes("session_shutdown"));

  const start = tools.get("start_terminal");
  assert.match(start.description, /pseudo-terminal \(PTY\)/);
  const guidelines = start.promptGuidelines.join("\n");
  assert.match(guidelines, /Use start_terminal by default/);
  assert.match(guidelines, /Never use a large bash timeout/);
  assert.match(guidelines, /end the turn immediately/);
  assert.match(guidelines, /private extension queue/);
  assert.match(guidelines, /custom-result turn/);
  assert.match(guidelines, /continue the original task immediately/);
  assert.match(guidelines, /do not call read_terminal, list_terminals, or start a timer/);
  assert.match(JSON.stringify(start.parameters), /working_dir/);

  const read = tools.get("read_terminal");
  assert.match(read.description, /only when the user asks for progress or current output is required for immediate interaction/);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.renderCall, "function", `${tool.name} should render a compact call card`);
    assert.equal(typeof tool.renderResult, "function", `${tool.name} should render a compact result card`);
  }
  assert.match(read.description, /automatically sends a follow-up/);

  const write = tools.get("write_terminal");
  assert.match(write.description, /Ctrl\+C/);
  assert.match(JSON.stringify(write.parameters), /press_enter/);
});

test("aborting startup stops the newly created terminal instead of orphaning it", async () => {
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  const messages: any[] = [];
  extension({
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerMessageRenderer() {},
    on: addHook(hooks),
    sendMessage(message: any) { messages.push(message); },
    sendUserMessage(message: any) { messages.push(message); },
  } as never);
  const context = { cwd: process.cwd(), hasUI: false, isIdle: () => false, ui: {} };
  hooks.get("session_start")?.({}, context);
  const controller = new AbortController();
  const starting = tools.get("start_terminal").execute(
    "call-abort",
    { command: "sleep 30", title: "abort fixture", wait_ms: 5_000 },
    controller.signal,
    undefined,
    context,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(starting, /aborted/);

  const listed = await tools.get("list_terminals").execute();
  assert.equal(listed.details.terminals.length, 1);
  assert.equal(listed.details.terminals[0].status, "killed");
  assert.equal(messages.length, 0);
  await hooks.get("session_shutdown")?.();
});

test("settlement waits locally while the parent is active and flushes at agent_settled", async () => {
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  const custom: Array<{ message: any; options: any }> = [];
  const user: Array<{ content: any; options: any }> = [];
  extension({
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerMessageRenderer() {},
    on: addHook(hooks),
    sendMessage(message: any, options: any) { custom.push({ message, options }); },
    sendUserMessage(content: any, options: any) { user.push({ content, options }); },
  } as never);

  const context = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => false,
    ui: {},
  };
  hooks.get("session_start")?.({}, context);
  hooks.get("agent_start")?.({});
  const started = await tools.get("start_terminal").execute(
    "call-read-settled",
    {
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('finished'), 30)"`,
      title: "read completion fixture",
      wait_ms: 0,
    },
    undefined,
    undefined,
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const read = await tools.get("read_terminal").execute(
    "call-read",
    { id: started.details.id, cursor: 0, wait_ms: 0 },
    undefined,
  );
  assert.equal(read.details.status, "done");
  assert.equal(custom.length, 0, "active-parent settlement must stay out of Pi's visible queues");
  assert.deepEqual(user, []);
  hooks.get("agent_settled")?.({});
  assert.equal(custom.length, 1);
  assert.match(custom[0]?.message.content, /read completion fixture.*completed successfully/s);
  assert.deepEqual(custom[0]?.options, { triggerTurn: true });
  await hooks.get("session_shutdown")?.();
});

test("a terminal that settles during its initial read returns synchronously without a duplicate follow-up", async () => {
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  const messages: any[] = [];
  extension({
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerMessageRenderer() {},
    on: addHook(hooks),
    sendMessage(message: any) { messages.push(message); },
    sendUserMessage(message: any) { messages.push(message); },
  } as never);

  const context = { cwd: process.cwd(), hasUI: false, isIdle: () => false, ui: {} };
  hooks.get("session_start")?.({}, context);
  const result = await tools.get("start_terminal").execute(
    "call-sync-settle",
    { command: `${JSON.stringify(process.execPath)} -e ""`, title: "sync fixture", wait_ms: 5_000 },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.details.status, "done");
  assert.equal(messages.length, 0);
  await hooks.get("session_shutdown")?.();
});

test("a model-started terminal returns immediately and wakes an idle parent on completion", async () => {
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  const custom: Array<{ message: any; options: any }> = [];
  const user: Array<{ content: any; options: any }> = [];
  extension({
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerMessageRenderer() {},
    on: addHook(hooks),
    sendMessage(message: any, options: any) { custom.push({ message, options }); },
    sendUserMessage(content: any, options: any) { user.push({ content, options }); },
  } as never);

  const context = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    ui: {},
  };
  hooks.get("session_start")?.({}, context);
  const startedAt = Date.now();
  const result = await tools.get("start_terminal").execute(
    "call-1",
    {
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('finished'), 40)"`,
      title: "completion fixture",
      wait_ms: 0,
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.details.status, "running");
  assert.ok(Date.now() - startedAt < 500, "start_terminal should not wait for process completion");

  const deadline = Date.now() + 2_000;
  while (custom.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(custom.length, 1);
  assert.match(custom[0]?.message.content, /completion fixture.*completed successfully/s);
  assert.deepEqual(custom[0]?.options, { triggerTurn: true });
  assert.deepEqual(user, []);
  await hooks.get("session_shutdown")?.();
});
