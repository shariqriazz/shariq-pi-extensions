import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AntigravityDashboard, type AntigravityDashboardSnapshot } from "./dashboard.ts";

function snapshot(): AntigravityDashboardSnapshot {
  const now = Date.now();
  return {
    authentication: "stored OAuth",
    modelCount: 4,
    accounts: Array.from({ length: 10 }, (_, index) => ({
      id: `account-${index}`,
      email: `account-${index}@example.com`,
      refresh: "hidden",
      access: "hidden",
      expires: now + 60_000,
      projectId: "project",
      addedAt: now,
      lastUsedAt: now - index * 1_000,
      active: index !== 3,
      disabled: index === 3,
      quotaUpdatedAt: now,
      quota: [
        { modelId: "gemini-5h", displayName: "5-Hour", group: "gemini", window: "five-hour", remainingFraction: 0.72, resetTime: "2099-01-01T00:00:00Z" },
        { modelId: "gemini-weekly", displayName: "Weekly", group: "gemini", window: "weekly", remainingFraction: 0.64, resetTime: "2099-01-02T00:00:00Z" },
        { modelId: "3p-5h", displayName: "5-Hour", group: "non-gemini", window: "five-hour", remainingFraction: 0.31, resetTime: "2099-01-01T00:00:00Z" },
        { modelId: "3p-weekly", displayName: "Weekly", group: "non-gemini", window: "weekly", remainingFraction: 0.88, resetTime: "2099-01-02T00:00:00Z" },
      ],
    })),
  };
}

test("Antigravity dashboard shows remaining quota and stays within the viewport", () => {
  const theme = {
    fg(_color: string, text: string) { return text; },
    bg(_color: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const keys = {
    matches(data: string, binding: string) {
      return (binding === "tui.select.cancel" && data === "escape") ||
        (binding === "tui.select.up" && data === "up") ||
        (binding === "tui.select.down" && data === "down");
    },
  };
  const component = new AntigravityDashboard(
    { terminal: { rows: 30 }, requestRender() {} } as never,
    theme as never,
    keys as never,
    snapshot(),
    async () => snapshot(),
    async () => snapshot(),
    () => {},
  );
  for (const width of [32, 72, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /Gemini: 5-Hour 72%|GEMINI MODELS.*REMAINING/);
    assert.doesNotMatch(lines.join("\n"), /hidden/);
  }
  component.handleInput("down");
  const wide = component.render(120).join("\n");
  assert.match(wide, /5-Hour/);
  assert.match(wide, /Weekly/);
  assert.match(wide, /CLAUDE MODELS/);
  assert.doesNotMatch(wide, /GPT|3\.6|3\.5/);
  assert.ok(component.render(120).every((line) => visibleWidth(line) <= 120));
});
