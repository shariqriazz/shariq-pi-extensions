import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FactoryDashboard, type FactoryDashboardSnapshot } from "./dashboard.ts";

const future = "2099-01-01T00:00:00Z";
const pool = {
  monthly: { usedPercent: 72, windowEnd: future, secondsRemaining: 86_400 },
  weekly: { usedPercent: 20, windowEnd: future, secondsRemaining: 3_600 },
  fiveHour: { usedPercent: 4, windowEnd: future, secondsRemaining: 1_800 },
};

function snapshot(): FactoryDashboardSnapshot {
  return {
    version: "0.200.0",
    modelCount: 12,
    authentication: "configured API keys",
    configured: 12,
    active: 11,
    accounts: Array.from({ length: 12 }, (_, index) => ({
      id: `account-${index}`,
      label: `Factory account ${index + 1}`,
      editable: true,
      disabled: index === 5,
      record: {
        id: `account-${index}`,
        label: `Factory account ${index + 1}`,
        fetchedAt: Date.now(),
        limits: { standard: pool, core: pool },
      },
      cooldownSeconds: index === 3 ? 300 : 0,
    })),
  };
}

test("Factory dashboard shows usage and supports disable and delete controls", async () => {
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
  let current = snapshot();
  const toggled: Array<{ id: string; enabled: boolean }> = [];
  const removed: string[] = [];
  const component = new FactoryDashboard(
    { terminal: { rows: 30 }, requestRender() {} } as never,
    theme as never,
    keys as never,
    current,
    async () => current,
    async (id, enabled) => {
      toggled.push({ id, enabled });
      current = { ...current, accounts: current.accounts.map((account) => account.id === id ? { ...account, disabled: !enabled } : account) };
      return current;
    },
    async (id) => {
      removed.push(id);
      current = { ...current, accounts: current.accounts.filter((account) => account.id !== id) };
      return current;
    },
    () => {},
  );
  for (const width of [32, 72, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /Standard used|STANDARD.*CONSUMED/);
  }
  component.handleInput("down");
  assert.ok(component.render(120).every((line) => visibleWidth(line) <= 120));
  assert.match(component.render(120).join("\n"), /enable\/disable/);
  assert.match(component.render(120).join("\n"), /remove/);

  component.handleInput("d");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(toggled, [{ id: "account-1", enabled: false }]);
  assert.match(component.render(120).join("\n"), /disabled/);

  component.handleInput("x");
  assert.deepEqual(removed, []);
  assert.match(component.render(120).join("\n"), /press x again to remove Factory account 2/);
  assert.doesNotMatch(component.render(120).join("\n"), /refreshing/);
  component.handleInput("escape");
  assert.deepEqual(removed, []);
  assert.doesNotMatch(component.render(120).join("\n"), /confirm permanent removal/);

  component.handleInput("x");
  component.handleInput("x");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, ["account-1"]);
  assert.doesNotMatch(component.render(120).join("\n"), /Factory account 2/);
});
