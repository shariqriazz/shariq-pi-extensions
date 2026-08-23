import assert from "node:assert/strict";
import test from "node:test";
import extension, { deriveBtwTitle } from "./index.ts";

test("derives compact Unicode-safe titles for by-the-way questions", () => {
  assert.equal(deriveBtwTitle("  Why is this failing?\nMore detail"), "Why is this failing?");
  const long = "🧪".repeat(80);
  assert.equal([...deriveBtwTitle(long)].length, 60);
  assert.match(deriveBtwTitle(long), /…$/);
});

test("registers one Pi-only canonical API and the takeover dashboard", () => {
  const tools = new Map<string, any>();
  const commands: string[] = [];
  const hooks: string[] = [];
  const fakePi = {
    events: {
      on() { return () => {}; },
      emit() {},
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    on(name: string) {
      hooks.push(name);
    },
    sendMessage() {},
    getThinkingLevel() {
      return "medium";
    },
  };

  extension(fakePi as never);

  assert.deepEqual([...tools.keys()], [
    "spawn_agent",
    "wait_agent",
    "close_agent",
    "check_agent",
    "list_agent_profiles",
    "list_agents",
    "send_message",
    "apply_agent_changes",
    "reply_question",
    "task",
  ]);
  assert.deepEqual(commands, ["btw", "subagents"]);
  assert.ok(hooks.includes("session_start"));
  assert.ok(hooks.includes("agent_start"));
  assert.ok(hooks.includes("agent_settled"));
  assert.ok(hooks.includes("session_shutdown"));

  const spawnSchema = JSON.stringify(tools.get("spawn_agent")?.parameters);
  assert.match(spawnSchema, /message/);
  assert.match(spawnSchema, /agent_type/);
  assert.match(spawnSchema, /capability/);
  assert.match(spawnSchema, /fork_turns/);
  assert.match(spawnSchema, /resume_from/);
  assert.match(spawnSchema, /worktree/);
  assert.match(spawnSchema, /Default none/);
  assert.match(spawnSchema, /Read-only work and clearly separate edits should share the workspace/);
  assert.doesNotMatch(spawnSchema, /harness|claude|codex/);

  const taskTool = tools.get("task");
  const taskSchema = JSON.stringify(taskTool?.parameters);
  assert.match(taskSchema, /Default none/);
  assert.match(taskTool?.description ?? "", /background/);
  assert.match(taskTool?.description ?? "", /return their ids immediately/);
  assert.match(taskTool?.description ?? "", /Completion notices automatically start the next parent turn/);
  assert.match(taskTool?.promptGuidelines.join("\n") ?? "", /Do not call wait_agent, list_agents, or check_agent merely to watch them run/);
  assert.doesNotMatch(taskTool?.description ?? "", /wait for all/i);

  const waitTool = tools.get("wait_agent");
  assert.match(waitTool?.description ?? "", /without blocking/);
  assert.match(waitTool?.description ?? "", /completion notices automatically/);

  const guidelines = tools.get("spawn_agent")?.promptGuidelines.join("\n") ?? "";
  assert.match(guidelines, /end the turn so Pi remains available to the user/);
  assert.match(guidelines, /Do not poll background agents/);
  assert.match(guidelines, /Settlement stays private/);
  assert.match(guidelines, /custom-result turn/);
  assert.match(guidelines, /continue the original task/);
  assert.doesNotMatch(guidelines, /blocking parallel fan-out/);
  for (const legacy of [
    "subagent_spawn",
    "subagent_wait",
    "subagent_cancel",
    "subagent_check",
    "subagent_list",
  ]) {
    assert.equal(tools.has(legacy), false);
  }
});
