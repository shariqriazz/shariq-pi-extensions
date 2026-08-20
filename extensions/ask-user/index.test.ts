import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserExtension, { answerMessage } from "./index.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines: string[];
  parameters: { properties: { options: { minItems: number; maxItems: number } } };
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
