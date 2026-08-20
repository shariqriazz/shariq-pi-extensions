import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import piContextUsage, { internals } from "./index.ts";

test("registers only the expected lifecycle handlers and command", () => {
  const events: string[] = [];
  const commands: Array<{ name: string; description?: string }> = [];
  const pi = {
    on(name: string) {
      events.push(name);
    },
    registerCommand(name: string, options: { description?: string }) {
      commands.push({ name, description: options.description });
    },
  };

  piContextUsage(pi as never);

  assert.deepEqual(events, [
    "message_end",
    "session_compact",
    "session_start",
    "model_select",
    "session_shutdown",
  ]);
  assert.deepEqual(commands.map(({ name }) => name), ["context-usage"]);
});

test("shutdown removes the injected panel, widget, and retained globals", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    registerCommand() {},
  };
  piContextUsage(pi as never);
  const block = {};
  const chat = { children: [block] };
  const renders: boolean[] = [];
  const globals = globalThis as any;
  globals.__piContextUsageBlock = block;
  globals.__piContextUsageChat = chat;
  globals.__piContextUsageTui = { requestRender(force: boolean) { renders.push(force); } };
  const widgets: Array<[string, unknown]> = [];

  await handlers.get("session_shutdown")?.({}, {
    hasUI: true,
    ui: { setWidget(name: string, value: unknown) { widgets.push([name, value]); } },
  });

  assert.deepEqual(chat.children, []);
  assert.deepEqual(widgets, [["__pi_context_usage_capture", undefined]]);
  assert.deepEqual(renders, [true]);
  assert.equal(globals.__piContextUsageBlock, undefined);
  assert.equal(globals.__piContextUsageChat, undefined);
  assert.equal(globals.__piContextUsageTui, undefined);
});

test("keeps core parsing and estimate helpers available", () => {
  assert.equal(internals.stripAnsi("\u001b[31mred\u001b[0m"), "red");
  assert.equal(internals.cleanDenominator(2.6), 2.6);
  assert.equal(internals.cleanDenominator(-1), 4);
  assert.match(internals.contextWindowLabel(372_000), /372k/i);
  assert.deepEqual(internals.splitConfigPaths("C:\\config\\one.json;D:\\config\\two.json", ";"), ["C:\\config\\one.json", "D:\\config\\two.json"]);
});

test("is standalone and has no private runtime imports", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.\.\/_lib\//);
});
