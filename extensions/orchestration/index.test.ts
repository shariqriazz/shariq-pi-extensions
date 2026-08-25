import assert from "node:assert/strict";
import { test } from "node:test";
import orchestration from "./index.ts";

test("registers the orchestration command, explicit-start tool, and status tool", () => {
  const commands: string[] = [];
  const tools: Array<{ name: string; description: string; promptGuidelines?: string[]; renderCall?: Function; renderResult?: Function }> = [];
  const handlers: string[] = [];
  const pi = {
    events: { on() { return () => {}; }, emit() {} },
    on(name: string) { handlers.push(name); },
    registerCommand(name: string) { commands.push(name); },
    registerTool(tool: { name: string; description: string; promptGuidelines?: string[]; renderCall?: Function; renderResult?: Function }) { tools.push(tool); },
  };
  orchestration(pi as never);
  assert.deepEqual(commands, ["orchestration"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["create_orchestration", "get_orchestration"]);
  assert.match(tools[0].promptGuidelines!.join("\n"), /explicitly asks/);
  assert.ok(tools.every((tool) => typeof tool.renderCall === "function" && typeof tool.renderResult === "function"));
  assert.deepEqual(handlers, ["session_start", "session_shutdown"]);
});
