import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

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
  assert.ok(hooks.includes("agent_settled"));
  assert.ok(hooks.includes("session_shutdown"));

  const start = tools.get("start_terminal");
  assert.match(start.description, /pseudo-terminal \(PTY\)/);
  const guidelines = start.promptGuidelines.join("\n");
  assert.match(guidelines, /Use start_terminal by default/);
  assert.match(guidelines, /Never use a large bash timeout/);
  assert.match(guidelines, /end the turn so Pi stays available to the user/);
  assert.match(guidelines, /completion wakes the parent automatically/);
  assert.match(JSON.stringify(start.parameters), /working_dir/);

  const write = tools.get("write_terminal");
  assert.match(write.description, /Ctrl\+C/);
  assert.match(JSON.stringify(write.parameters), /press_enter/);
});

test("a model-started terminal returns immediately and wakes an idle parent on completion", async () => {
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  const messages: Array<{ message: any; options: any }> = [];
  extension({
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerMessageRenderer() {},
    on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
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
  while (messages.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message.customType, "background-terminal-result");
  assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  await hooks.get("session_shutdown")?.();
});
