import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { oneLine } from "./tui-dashboard.ts";

const WIDGET_ID = "active-work";
const MAX_VISIBLE_ITEMS = 5;

export type ActivityState = "active" | "success" | "warning" | "error" | "muted";

export type ActivityItem = {
  id: string;
  label: string;
  title: string;
  detail?: string;
  state: ActivityState;
  priority?: number;
};

let activeUi: ExtensionContext["ui"] | undefined;
const sources = new Map<string, ActivityItem[]>();

function color(state: ActivityState): "accent" | "success" | "warning" | "error" | "muted" {
  if (state === "active") return "accent";
  return state;
}

function glyph(state: ActivityState) {
  if (state === "active") return "◆";
  if (state === "success") return "✓";
  if (state === "warning") return "!";
  if (state === "error") return "×";
  return "○";
}

function bind(ctx: ExtensionContext) {
  if (activeUi === ctx.ui) return;
  activeUi?.setWidget(WIDGET_ID, undefined);
  activeUi = ctx.ui;
  sources.clear();
}

function allItems() {
  return [...sources.entries()]
    .flatMap(([source, items]) => items.map((item, index) => ({ source, index, item })))
    .sort((left, right) =>
      (right.item.priority ?? 0) - (left.item.priority ?? 0) ||
      left.source.localeCompare(right.source) ||
      left.index - right.index,
    )
    .map(({ item }) => item);
}

function publish(ctx: ExtensionContext) {
  bind(ctx);
  const items = allItems();
  if (!ctx.hasUI || items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
    render(width: number) {
      const current = allItems();
      const shown = current.slice(0, MAX_VISIBLE_ITEMS);
      const lines = [truncateToWidth(
        `${theme.fg("accent", theme.bold("Active work"))} ${theme.fg("muted", `${current.length}`)}`,
        width,
      )];
      for (const item of shown) {
        const tone = color(item.state);
        const detail = item.detail ? theme.fg("dim", ` · ${oneLine(item.detail)}`) : "";
        lines.push(truncateToWidth(
          `${theme.fg(tone, glyph(item.state))} ${theme.fg("muted", item.label)} ${theme.fg(tone === "muted" ? "muted" : "text", oneLine(item.title))}${detail}`,
          width,
        ));
      }
      if (current.length > shown.length) {
        lines.push(truncateToWidth(theme.fg("dim", `… +${current.length - shown.length} more · open the relevant dashboard`), width));
      }
      return lines;
    },
    invalidate() {},
  }));
}

export function setActivitySource(ctx: ExtensionContext, source: string, items: ActivityItem[]) {
  bind(ctx);
  if (items.length) sources.set(source, items.map((item) => ({ ...item })));
  else sources.delete(source);
  publish(ctx);
}

export function clearActivitySource(ctx: ExtensionContext, source: string) {
  bind(ctx);
  sources.delete(source);
  publish(ctx);
}

export function activityDockSnapshot() {
  return allItems().map((item) => ({ ...item }));
}
