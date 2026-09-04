import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";
import { buildModelPickerItems, ModelPickerComponent, type ModelPickerItem } from "./model-picker.ts";

const dummyTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function harness(items: ModelPickerItem[], currentModel?: string) {
  let finished: string | undefined | null = null;
  let renderRequests = 0;

  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: () => { renderRequests++; },
  };

  const keys = {
    matches: () => false,
  };

  const component = new ModelPickerComponent(
    tui as never,
    dummyTheme as never,
    keys as never,
    { title: "Select Model", currentModel },
    items,
    (res) => { finished = res; },
  );

  return { component, getResult: () => finished, getRenderRequests: () => renderRequests };
}

test("model picker renders bounded frame and filters items dynamically", () => {
  const sampleItems: ModelPickerItem[] = [
    { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, reasoning: true },
    { provider: "anthropic", id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", contextWindow: 200_000, reasoning: true },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  ];

  const h = harness(sampleItems, "google/gemini-2.5-flash");
  const lines = h.component.render(80);
  assert.ok(lines.length >= 18);
  assert.match(lines.join("\n"), /Gemini 2.5 Flash/);
  assert.match(lines.join("\n"), /1M ctx/);

  // Type search query "gpt"
  h.component.handleInput("g");
  h.component.handleInput("p");
  h.component.handleInput("t");

  const filteredLines = h.component.render(80);
  assert.match(filteredLines.join("\n"), /GPT-4o/);

  // Select item with enter
  h.component.handleInput("\r");
  assert.equal(h.getResult(), "openai/gpt-4o");
});

test("model picker cancels with escape", () => {
  const sampleItems: ModelPickerItem[] = [
    { provider: "google", id: "gemini-2.5-flash" },
  ];
  const h = harness(sampleItems);
  h.component.handleInput("\x1b");
  assert.equal(h.getResult(), undefined);
});

test("buildModelPickerItems prioritizes active/configured models from getAvailable", () => {
  const ctx = {
    modelRegistry: {
      getAvailable() {
        return [{ provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }];
      },
      getAll() {
        return [
          { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
          { provider: "unconfigured-provider", id: "some-model", name: "Some Model" },
        ];
      },
    },
  };
  const items = buildModelPickerItems(ctx as never);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "gemini-2.5-flash");
  assert.equal(items[0].provider, "google");
});
