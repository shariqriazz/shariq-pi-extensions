import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

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

  assert.deepEqual(events, ["message_end", "session_compact", "session_start", "model_select", "session_shutdown"]);
  assert.deepEqual(
    commands.map(({ name }) => name),
    ["context-usage"],
  );
});

test("shutdown removes the injected panel, widget, and retained globals", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, handler);
    },
    registerCommand() {},
  };
  piContextUsage(pi as never);
  const block = {};
  const chat = { children: [block] };
  const renders: boolean[] = [];
  const globals = globalThis as any;
  globals.__piContextUsageBlock = block;
  globals.__piContextUsageChat = chat;
  globals.__piContextUsageTui = {
    requestRender(force: boolean) {
      renders.push(force);
    },
  };
  const widgets: Array<[string, unknown]> = [];

  await handlers.get("session_shutdown")?.(
    {},
    {
      hasUI: true,
      ui: {
        setWidget(name: string, value: unknown) {
          widgets.push([name, value]);
        },
      },
    },
  );

  assert.deepEqual(chat.children, []);
  assert.deepEqual(widgets, [["__pi_context_usage_capture", undefined]]);
  assert.deepEqual(renders, [true]);
  assert.equal(globals.__piContextUsageBlock, undefined);
  assert.equal(globals.__piContextUsageChat, undefined);
  assert.equal(globals.__piContextUsageTui, undefined);
});

test("quiet startup still mounts the card, which stays inside narrow widths", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  piContextUsage({
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    getActiveTools: () => ["read"],
    getAllTools: () => [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "builtin" },
      },
    ],
  } as never);
  // quietStartup: Pi's document holds [header, empty loaded resources, chat].
  const resources = { children: [] as unknown[] };
  const document = { children: [{ children: [] }, resources, { children: [] }] };
  const tui = { children: [document], requestRender() {} };
  let capture: any;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  await handlers.get("session_start")?.(
    {},
    {
      hasUI: true,
      cwd: "/tmp",
      model: undefined,
      isProjectTrusted: () => false,
      getSystemPrompt: () => "You are a helpful assistant.",
      getContextUsage: () => ({ tokens: 1200, contextWindow: 200000, percent: 0.6 }),
      sessionManager: { getBranch: () => [], buildContextEntries: () => [], getEntries: () => [] },
      ui: {
        theme,
        setWidget(name: string, value: any) {
          if (name === "__pi_context_usage_capture") capture = value;
        },
        setHeader() {
          throw new Error("Context Usage must not replace another extension's header");
        },
      },
    },
  );
  capture(tui).render(80);
  const deadline = Date.now() + 2_000;
  while (resources.children.length === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(resources.children.length, 1);
  const block = resources.children[0] as { render(width: number): string[] };
  for (const width of [80, 12, 3]) {
    const lines = block.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
  }
  assert.match(block.render(80).join("\n"), /~1\.2k|~1,200|~1200/);
  await handlers.get("session_shutdown")?.({}, { hasUI: true, ui: { setWidget() {} } });
});

test("keeps core parsing and estimate helpers available", () => {
  assert.equal(internals.stripAnsi("\u001b[31mred\u001b[0m"), "red");
  assert.equal(internals.cleanDenominator(2.6), 2.6);
  assert.equal(internals.cleanDenominator(-1), 4);
  assert.match(internals.contextWindowLabel(372_000), /372k/i);
  assert.deepEqual(internals.splitConfigPaths("C:\\config\\one.json;D:\\config\\two.json", ";"), [
    "C:\\config\\one.json",
    "D:\\config\\two.json",
  ]);
});

test("is standalone and has no private runtime imports", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.\.\/_lib\//);
});

test("parses the Pi 1.0 structured system prompt without double counting", () => {
  const prompt = [
    "You are an expert coding assistant running in Pi.",
    "<tools>\n- read: Read file contents\n</tools>",
    "<rules>\n- Be concise in your responses\n</rules>",
    '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\n# Repo rules\nUse bun.\n</project_instructions>\n</project_context>',
    "<skills>\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\n\n<available_skills>\n  <skill>\n    <name>demo</name>\n    <description>Demo skill</description>\n    <location>/skills/demo/SKILL.md</location>\n  </skill>\n</available_skills>\n</skills>",
    "<cwd>\n/repo\n</cwd>",
  ].join("\n\n");

  const remainder = internals.getPromptRemainder(prompt);
  assert.doesNotMatch(remainder, /Repo rules/);
  assert.doesNotMatch(remainder, /available_skills|demo/);
  assert.match(remainder, /Be concise/);

  const { skills } = internals.buildSkillsSection(prompt, 4);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["demo"],
  );
  assert.equal(internals.parseContextSections(prompt, 4).length, 1);
});
