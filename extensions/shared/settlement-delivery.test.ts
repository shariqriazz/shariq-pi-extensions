import assert from "node:assert/strict";
import test from "node:test";
import { settlementDelivery } from "./settlement-delivery.ts";

function harness() {
  const hooks = new Map<string, Array<(...args: any[]) => any>>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  } as never;
  const emit = (name: string, ...args: any[]) => {
    for (const handler of hooks.get(name) ?? []) handler(...args);
  };
  return { pi, hooks, sent, emit };
}

const result = (name: string) => ({ customType: name, content: `${name} finished`, display: true });
const start = (app: ReturnType<typeof harness>, sessionManager = {}) => {
  app.emit("session_start", {}, { sessionManager });
  return sessionManager;
};

test("idle settlement starts one custom model turn without user or follow-up delivery", () => {
  const app = harness();
  const deliver = settlementDelivery(app.pi);
  start(app);
  deliver(result("terminal"));

  assert.deepEqual(app.sent, [{
    message: result("terminal"),
    options: { triggerTurn: true },
  }]);
});

test("active-parent settlements wait locally and flush together at the safe idle edge", () => {
  const app = harness();
  const deliver = settlementDelivery(app.pi);
  start(app);
  app.emit("agent_start", {});
  deliver(result("terminal"));
  deliver(result("subagent"));
  assert.deepEqual(app.sent, []);

  app.emit("agent_settled", {});
  assert.deepEqual(app.sent, [
    { message: result("terminal"), options: { triggerTurn: false } },
    { message: result("subagent"), options: { triggerTurn: true } },
  ]);
});

test("distinct suite extension APIs share one coordinator for the same session", () => {
  const firstApp = harness();
  const secondApp = harness();
  const first = settlementDelivery(firstApp.pi);
  const second = settlementDelivery(secondApp.pi);
  const sessionManager = {};
  start(firstApp, sessionManager);
  start(secondApp, sessionManager);
  firstApp.emit("agent_start", {});
  secondApp.emit("agent_start", {});
  first(result("terminal"));
  second(result("subagent"));

  firstApp.emit("agent_settled", {});
  secondApp.emit("agent_settled", {});
  assert.deepEqual(firstApp.sent, [
    { message: result("terminal"), options: { triggerTurn: false } },
    { message: result("subagent"), options: { triggerTurn: true } },
  ]);
  assert.deepEqual(secondApp.sent, []);
});

test("shutdown drops pending output instead of waking a replaced session", () => {
  const app = harness();
  const deliver = settlementDelivery(app.pi);
  start(app);
  app.emit("agent_start", {});
  deliver(result("terminal"));
  app.emit("session_shutdown", {});
  app.emit("agent_settled", {});
  assert.deepEqual(app.sent, []);
});
