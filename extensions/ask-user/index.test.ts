import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserExtension, { answerMessage } from "./index.ts";

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
    registerTool(definition: RegisteredTool) { tool = definition; },
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
  askUserExtension({ registerTool(definition: RegisteredTool) { tool = definition; } } as unknown as ExtensionAPI);
  const ctx = { mode: "print" };
  await assert.rejects(
    tool!.execute("blank", { question: "Choose", options: [{ label: " \u001b[31m " }, { label: "Valid" }] }, undefined, undefined, ctx),
    /visible text/,
  );
  await assert.rejects(
    tool!.execute("duplicate", { question: "Choose", options: [{ label: "Keep" }, { label: "  keep  " }] }, undefined, undefined, ctx),
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
