import assert from "node:assert/strict";
import { test } from "node:test";
import performanceStatus, { formatPerformanceStatus } from "./index.ts";

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
};

test("formats finalized per-message throughput without an estimate marker", () => {
  const line = formatPerformanceStatus(
    {
      requestStartedAt: 1_000,
      firstTokenAt: 2_000,
      completedAt: 4_000,
      streamedChars: 400,
      exactOutputTokens: 200,
      runningTools: new Map(),
      phase: "done",
    },
    { ui: { theme } } as never,
    4_000,
  );
  assert.equal(line, "◆ last response · TPS 100 tok/s · TTFT 1.0s · 3.0s · 200 out");
});

function lifecycle() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const statuses: Array<string | undefined> = [];
  performanceStatus({
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
  } as never);
  const ctx = {
    hasUI: true,
    ui: {
      theme,
      setStatus(_id: string, value: string | undefined) {
        statuses.push(value);
      },
    },
  };
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  const assistant = (output: number) => ({ role: "assistant", usage: { output } });
  const delta = (text: string) => ({
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: text },
  });
  return { handlers, statuses, emit, assistant, delta };
}

test("each response is measured from the provider call, and tool time is excluded", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const app = lifecycle();
  assert.ok(app.handlers.has("before_provider_headers"));

  app.emit("turn_start");
  t.mock.timers.tick(5_000); // local preparation before the HTTP call
  app.emit("before_provider_headers");
  t.mock.timers.tick(1_000);
  app.emit("message_update", app.delta("x".repeat(40)));
  t.mock.timers.tick(2_000);
  app.emit("message_end", { message: app.assistant(200) });
  assert.equal(app.statuses.at(-1), "◆ last response · TPS 100 tok/s · TTFT 1.0s · 3.0s · 200 out");

  // Tool runtime after message_end must not change the frozen numbers.
  app.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
  t.mock.timers.tick(30_000);
  app.emit("tool_execution_end", { toolCallId: "a", toolName: "bash" });
  assert.equal(app.statuses.at(-1), "◆ last response · TPS 100 tok/s · TTFT 1.0s · 3.0s · 200 out");

  // The next response starts fresh.
  app.emit("turn_start");
  app.emit("before_provider_headers");
  t.mock.timers.tick(500);
  app.emit("message_end", { message: app.assistant(50) });
  assert.equal(app.statuses.at(-1), "◆ last response · 0.5s · 50 out", "no delta means no TTFT or TPS");
});

test("parallel tools stay in the tool phase until the last one ends", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const app = lifecycle();
  app.emit("turn_start");
  app.emit("message_end", { message: app.assistant(10) });
  app.emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
  app.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" });
  assert.match(app.statuses.at(-1) ?? "", /^◆ tool read \+1/);
  app.emit("tool_execution_end", { toolCallId: "a", toolName: "read" });
  assert.match(app.statuses.at(-1) ?? "", /^◆ tool bash/);
  t.mock.timers.tick(10_000);
  assert.notEqual(app.statuses.at(-1), undefined, "a running tool keeps the row visible");
  app.emit("tool_execution_end", { toolCallId: "b", toolName: "bash" });
  assert.match(app.statuses.at(-1) ?? "", /^◆ last response/);
});
