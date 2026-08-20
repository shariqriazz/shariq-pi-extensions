import assert from "node:assert/strict";
import test from "node:test";
import piMemoryExtension from "../index.ts";

test("registers the complete Pi Memory tool, command, and lifecycle surface", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  piMemoryExtension({
    registerTool(definition: { name: string }) { tools.push(definition.name); },
    registerCommand(name: string) { commands.push(name); },
    on(name: string) { events.push(name); },
  } as never);

  assert.deepEqual(tools.sort(), [
    "pi_memory_correct",
    "pi_memory_forget",
    "pi_memory_read",
    "pi_memory_save",
    "pi_memory_search",
    "pi_memory_status",
  ]);
  assert.deepEqual(commands.sort(), [
    "memory-correct",
    "memory-forget",
    "memory-model",
    "memory-process",
    "memory-rebuild",
    "memory-review",
    "memory-save",
    "memory-search",
    "memory-status",
  ]);
  assert.deepEqual(events, [
    "session_start",
    "before_agent_start",
    "agent_settled",
    "session_before_compact",
    "session_shutdown",
  ]);
});
