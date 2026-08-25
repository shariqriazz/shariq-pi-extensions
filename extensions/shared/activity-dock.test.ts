import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { activityDockSnapshot, clearActivitySource, setActivitySource } from "./activity-dock.ts";

test("shared activity dock aggregates, prioritizes, bounds, and clears sources", () => {
  let widget: any;
  const theme = {
    fg(_color: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const ctx = {
    hasUI: true,
    ui: {
      theme,
      setWidget(_id: string, value: unknown) { widget = value; },
    },
  } as any;
  setActivitySource(ctx, "tasks", [
    { id: "task-1", label: "Tasks 1/3", title: "Implement", state: "active", priority: 60 },
  ]);
  setActivitySource(ctx, "agents", Array.from({ length: 6 }, (_, index) => ({
    id: `sa-${index}`,
    label: "Subagent",
    title: `Worker ${index}`,
    state: index === 0 ? "error" as const : "active" as const,
    priority: index === 0 ? 100 : 50,
  })));
  assert.equal(activityDockSnapshot()[0]?.id, "sa-0");
  const component = widget({}, theme);
  const lines = component.render(72);
  assert.ok(lines.every((line: string) => visibleWidth(line) <= 72));
  assert.match(lines.join("\n"), /Active work 7/);
  assert.match(lines.join("\n"), /\+2 more/);
  clearActivitySource(ctx, "agents");
  assert.deepEqual(activityDockSnapshot().map((item) => item.id), ["task-1"]);
  clearActivitySource(ctx, "tasks");
  assert.equal(widget, undefined);
});
