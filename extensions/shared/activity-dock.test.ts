import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { activityDockSnapshot, clearActivitySource, setActivitySource } from "./activity-dock.ts";

test("shared activity dock aggregates, prioritizes, bounds, and clears sources", () => {
  let widget: any;
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      theme,
      setWidget(_id: string, value: unknown) {
        widget = value;
      },
    },
  } as any;
  setActivitySource(ctx, "tasks", [
    { id: "task-1", label: "Tasks 1/3", title: "Implement", state: "active", priority: 60 },
  ]);
  setActivitySource(
    ctx,
    "agents",
    Array.from({ length: 6 }, (_, index) => ({
      id: `sa-${index}`,
      label: "Subagent",
      title: `Worker ${index}`,
      state: index === 0 ? ("error" as const) : ("active" as const),
      priority: index === 0 ? 100 : 50,
    })),
  );
  assert.equal(activityDockSnapshot(ctx.ui)[0]?.id, "sa-0");
  const component = widget({}, theme);
  const lines = component.render(72);
  assert.ok(lines.every((line: string) => visibleWidth(line) <= 72));
  assert.match(lines.join("\n"), /Active work 7/);
  assert.match(lines.join("\n"), /\+2 more/);
  clearActivitySource(ctx, "agents");
  assert.deepEqual(
    activityDockSnapshot(ctx.ui).map((item) => item.id),
    ["task-1"],
  );
  clearActivitySource(ctx, "tasks");
  assert.equal(widget, undefined);
});

test("activity dock is shared across separately loaded module copies and ignores headless sessions", async () => {
  // Pi loads each extension entrypoint through its own module instance.
  const copy = (await import(`./activity-dock.ts?copy=${Date.now()}`)) as typeof import("./activity-dock.ts");
  let widget: unknown;
  const ui = {
    setWidget(_id: string, value: unknown) {
      widget = value;
    },
  };
  const parent = { hasUI: true, ui } as any;
  const headless = {
    hasUI: false,
    ui: {
      setWidget() {
        throw new Error("headless dock must stay untouched");
      },
    },
  } as any;
  setActivitySource(parent, "tasks", [{ id: "task-1", label: "Tasks", title: "One", state: "active" }]);
  copy.setActivitySource(parent, "terminals", [{ id: "term-1", label: "Terminal", title: "Two", state: "active" }]);
  copy.clearActivitySource(headless, "tasks");
  assert.deepEqual(
    activityDockSnapshot(ui as any)
      .map((item) => item.id)
      .sort(),
    ["task-1", "term-1"],
  );
  clearActivitySource(parent, "tasks");
  copy.clearActivitySource(parent, "terminals");
  assert.equal(widget, undefined);
});
