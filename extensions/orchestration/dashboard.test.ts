import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openOrchestrationDashboard } from "./dashboard.ts";

test("orchestration dashboard stays bounded and returns actions before nested UI", async () => {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let action: unknown;
  const theme = {
    fg(_color: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const tui = { requestRender() {}, terminal: { rows: 30 } };
  const keys = {
    matches(data: string, binding: string) {
      return (binding === "tui.select.confirm" && data === "\r") ||
        (binding === "tui.select.up" && data === "up") ||
        (binding === "tui.select.down" && data === "down");
    },
  };
  const run = {
    id: "orc_test",
    objective: "Build a complete application with a deliberately long objective",
    cwd: "/tmp/project",
    projectKey: "project",
    gitBacked: true,
    status: "awaiting-approval",
    summary: "Plan summary",
    tasks: [{
      id: "frontend",
      title: "Build a responsive frontend with long descriptive text",
      description: "Frontend",
      role: "frontend",
      dependencies: [],
      acceptanceCriteria: ["works"],
      status: "pending",
      fixRounds: 0,
    }],
    createdAt: 1,
    updatedAt: 1,
  };
  const engine = {
    list: () => [run],
  };
  const ctx = {
    ui: {
      custom(factory: Function) {
        component = factory(tui, theme, keys, (value: unknown) => { action = value; });
        return Promise.resolve();
      },
    },
  };
  await openOrchestrationDashboard(ctx as never, engine as never);
  assert.ok(component);
  for (const width of [28, 60, 100]) {
    const lines = component!.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.length, 29);
    if (width >= 60) assert.match(lines.join("\n"), /ORCHESTRATION/);
    assert.match(lines.join("\n"), /CONTROL CENTER/);
  }
  component!.handleInput("\r");
  assert.ok(component!.render(40).every((line) => visibleWidth(line) <= 40));
  assert.match(component!.render(60).join("\n"), /RUN DETAIL/);
  // Test scrolling in detail view
  component!.handleInput("j");
  component!.handleInput("k");
  component!.handleInput("x");
  assert.deepEqual(action, { kind: "cancel", id: "orc_test" });
});
