import assert from "node:assert/strict";
import { test } from "node:test";
import performanceStatus, { formatPerformanceStatus } from "./index.ts";

const ctx = {
  ui: {
    theme: {
      fg(_color: string, text: string) { return text; },
    },
  },
};

test("formats finalized per-message throughput without an estimate marker", () => {
  const line = formatPerformanceStatus({
    requestStartedAt: 1_000,
    firstTokenAt: 2_000,
    completedAt: 4_000,
    streamedChars: 400,
    exactOutputTokens: 200,
    phase: "done",
  }, ctx as never, 4_000);
  assert.equal(line, "◆ last response · TPS 100 tok/s · TTFT 1.0s · 3.0s · 200 out");
});

test("registers streaming, tool, and lifecycle handlers", () => {
  const events: string[] = [];
  performanceStatus({ on(name: string) { events.push(name); } } as never);
  assert.deepEqual(events, [
    "turn_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "session_start",
    "session_shutdown",
  ]);
});
