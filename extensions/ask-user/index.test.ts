import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUserExtension, { answerMessage, AskUserView } from "./index.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines: string[];
  parameters: { properties: { options: { minItems: number; maxItems: number } } };
  execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any): Promise<any>;
}

test("registers a narrowly gated ask_user tool", () => {
  let tool: RegisteredTool | undefined;
  const api = {
    registerTool(definition: RegisteredTool) {
      tool = definition;
    },
  };
  askUserExtension(api as unknown as ExtensionAPI);

  assert.ok(tool);
  assert.equal(tool.name, "ask_user");
  assert.match(tool.description, /materially blocks safe progress/);
  assert.match(tool.description, /reversible low-risk default/);
  assert.ok(tool.promptGuidelines.every((line) => line.includes("ask_user")));
  assert.equal(tool.parameters.properties.options.minItems, 2);
  assert.equal(tool.parameters.properties.options.maxItems, 5);
});

test("rejects blank and duplicate choices after display normalization", async () => {
  let tool: RegisteredTool | undefined;
  askUserExtension({
    registerTool(definition: RegisteredTool) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  const ctx = { mode: "print" };
  await assert.rejects(
    tool!.execute(
      "blank",
      { question: "Choose", options: [{ label: " \u001b[31m " }, { label: "Valid" }] },
      undefined,
      undefined,
      ctx,
    ),
    /visible text/,
  );
  await assert.rejects(
    tool!.execute(
      "duplicate",
      { question: "Choose", options: [{ label: "Keep" }, { label: "  keep  " }] },
      undefined,
      undefined,
      ctx,
    ),
    /distinct/,
  );
  await assert.rejects(
    tool!.execute(
      "spacing",
      { question: "Choose", options: [{ label: "Use  the  cache" }, { label: "Use the cache" }] },
      undefined,
      undefined,
      ctx,
    ),
    /distinct/,
  );
});

test("formats selected, custom, and dismissed answers without filler", () => {
  assert.equal(
    answerMessage({ answer: "Keep current behavior", custom: false, optionIndex: 2 }),
    "The user selected option 2: Keep current behavior",
  );
  assert.equal(
    answerMessage({ answer: "Use the staging account", custom: true }),
    "The user wrote: Use the staging account",
  );
  assert.match(answerMessage(null), /dismissed/);
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;
function stubEditor() {
  return {
    focused: false,
    onSubmit: undefined as any,
    render: () => ["> draft"],
    handleInput() {},
    setText() {},
    invalidate() {},
  } as any;
}

test("long questions scroll while choices and controls stay visible; long labels wrap", () => {
  const question = Array.from({ length: 60 }, (_, index) => `Line ${index} of a very long question body.`).join("\n");
  const options = [
    { label: `Deploy to the production cluster in the primary region with the ${"x".repeat(40)} flag enabled` },
    { label: `Deploy to the production cluster in the primary region with the ${"x".repeat(40)} flag disabled` },
    { label: "Write my own answer…", custom: true },
  ];
  const view = new AskUserView(
    question,
    options,
    theme,
    () => {},
    () => {},
    stubEditor(),
    () => 20,
  );
  const lines = view.render(60);
  assert.ok(lines.length <= 20, `rendered ${lines.length} rows`);
  assert.ok(lines.every((line) => visibleWidth(line) <= 60));
  const text = lines.join("\n");
  assert.match(text, /^\s+enabled/m);
  assert.match(text, /^\s+disabled/m);
  assert.match(text, /Write my own answer/);
  assert.match(text, /choose/);
  assert.match(text, /pgup\/pgdn question 1-/);
  view.handleInput("\x1b[6~");
  assert.match(view.render(60).join("\n"), /Line 5 /);
});

test("ctrl+c dismisses even while writing a custom answer", () => {
  let result: unknown = "pending";
  const view = new AskUserView(
    "Choose",
    [{ label: "A" }, { label: "B" }, { label: "Write my own answer…", custom: true }],
    theme,
    () => {},
    (selection) => {
      result = selection;
    },
    stubEditor(),
  );
  view.handleInput("3");
  view.handleInput("\x03");
  assert.equal(result, null);
});

test("validation errors render as errors, not as a dismissed question", () => {
  let tool: any;
  askUserExtension({
    registerTool(definition: any) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  const rendered = tool
    .renderResult(
      { content: [{ type: "text", text: "option labels must be distinct after normalization." }] },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    )
    .render(120)
    .join("\n");
  assert.match(rendered, /not asked/);
  assert.doesNotMatch(rendered, /dismissed/);
});
