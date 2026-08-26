import assert from "node:assert/strict";
import test from "node:test";
import { OrchestrationSettingsComponent, openOrchestrationSettings } from "./settings-ui.ts";
import type { OrchestrationSettings } from "./types.ts";

const dummyTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

test("settings component renders roles and cycles thinking levels directly", () => {
  const initialSettings: OrchestrationSettings = {
    version: 1,
    maxWorkersPerProject: 10,
    roles: {
      orchestrator: { model: "antigravity/claude-opus-4-6", thinking: "medium" },
      explorer: { model: "antigravity/claude-sonnet-4-6", thinking: "high" },
      frontend: { model: "antigravity/claude-sonnet-4-6", thinking: "medium" },
      backend: { model: "antigravity/claude-sonnet-4-6", thinking: "medium" },
      general: { model: "antigravity/claude-sonnet-4-6", thinking: "medium" },
      reviewer: { model: "antigravity/claude-opus-4-6", thinking: "high" },
    },
  };

  let renderRequests = 0;
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: () => { renderRequests++; },
  };
  const keys = { matches: () => false };

  let finishedAction: any = null;
  const component = new OrchestrationSettingsComponent(
    tui as never,
    dummyTheme as never,
    keys as never,
    initialSettings,
    (action) => { finishedAction = action; },
  );

  const lines = component.render(80);
  assert.ok(lines.length >= 18);
  assert.match(lines.join("\n"), /orchestrator/);
  assert.match(lines.join("\n"), /antigravity\/claude-opus-4-6/);
  assert.match(lines.join("\n"), /⚡ medium/);

  // Press 't' to cycle thinking level for orchestrator (medium -> high)
  component.handleInput("t");
  assert.equal(initialSettings.roles.orchestrator.thinking, "high");
  assert.equal(component.changed, true);

  // Press Enter on orchestrator to pick model
  component.handleInput("\r");
  assert.deepEqual(finishedAction, { kind: "pick-model", role: "orchestrator" });
});

test("cancelling unchanged orchestration settings does not report a save", async () => {
  const notices: string[] = [];
  const changed = await openOrchestrationSettings({
    hasUI: true,
    ui: {
      async custom() { return { kind: "close" }; },
      notify(message: string) { notices.push(message); },
    },
    modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
  } as never);
  assert.equal(changed, false);
  assert.deepEqual(notices, []);
});
