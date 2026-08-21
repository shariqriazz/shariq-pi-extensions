import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AntigravityDashboard, type AntigravityDashboardSnapshot } from "./dashboard.ts";

function snapshot(): AntigravityDashboardSnapshot {
  const now = Date.now();
  return {
    authentication: "stored OAuth",
    modelCount: 7,
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
        { modelId: "gemini-3.7-flash-low", displayName: "Gemini Flash", group: "gemini", remainingFraction: 0.72, resetTime: "2099-01-01T00:00:00Z" },
        { modelId: "claude-opus-4-6-thinking", displayName: "Claude Opus", group: "non-gemini", remainingFraction: 0.31, resetTime: "2099-01-01T00:00:00Z" },
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
    assert.match(lines.join("\n"), /Gemini: 72% remaining|GEMINI.*REMAINING/);
    assert.doesNotMatch(lines.join("\n"), /hidden/);
  }
  component.handleInput("down");
  assert.ok(component.render(120).every((line) => visibleWidth(line) <= 120));
});
