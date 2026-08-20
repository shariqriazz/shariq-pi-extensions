import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  reconcileDashboardSelection,
  SubagentDashboard,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("wide dashboard renders a bounded split-pane operations view", () => {
  const snapshot = {
    id: "sa-1",
    backend: "pi",
    title: "Inspect the terminal interface",
    prompt: "Inspect it",
    cwd: "/tmp/project",
    status: "running",
    createdAt: Date.now() - 5_000,
    meta: {
      backend: "pi",
      origin: "model",
      modelLabel: "openai-codex/gpt-5.6-sol",
      agentType: "explore",
      capability: "execute",
      isolation: "none",
    },
    usage: { tokens: 50_000, contextWindow: 200_000 },
    transcript: [],
    liveAssistant: { text: "Reviewing the current dashboard output", thinking: "" },
    liveTools: [{ toolId: "t1", name: "read" }],
    queued: [],
    finalText: "",
    turns: 2,
  } as any;
  const listeners = new Set<() => void>();
  const view = {
    list: () => [snapshot],
    get: () => snapshot,
    size: () => 1,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeTo() { return () => {}; },
    requestAbort() {},
    requestSend() {},
  } as any;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const component = new SubagentDashboard(
    { terminal: { rows: 28 }, requestRender() {} } as any,
    theme,
    { matches: () => false, getKeys: () => [] } as any,
    view,
    { index: 0 },
    () => {},
  );
  try {
    const lines = component.render(120);
    assert.match(lines.join("\n"), /Subagent operations/);
    assert.match(lines.join("\n"), /MODEL/);
    assert.match(lines.join("\n"), /CONTEXT/);
    assert.match(lines.join("\n"), /LATEST/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  } finally {
    component.dispose();
  }
});
