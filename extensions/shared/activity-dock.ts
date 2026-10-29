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

type DockUi = ExtensionContext["ui"];

// Pi loads every extension entrypoint through its own module instance, so a
// module-local map would give each extension a private dock that overwrites
// the others. Keep the per-UI state on a process-wide registry instead.
const REGISTRY_KEY = Symbol.for("shariq-pi-extensions/activity-dock/v1");
const registry: WeakMap<DockUi, Map<string, ActivityItem[]>> = ((globalThis as Record<symbol, unknown>)[
  REGISTRY_KEY
] as WeakMap<DockUi, Map<string, ActivityItem[]>> | undefined) ??
(((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = new WeakMap<
  DockUi,
  Map<string, ActivityItem[]>
>()) as WeakMap<DockUi, Map<string, ActivityItem[]>>);

function sourcesFor(ui: DockUi) {
  let sources = registry.get(ui);
  if (!sources) {
    sources = new Map();
    registry.set(ui, sources);
  }
  return sources;
}

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

function allItems(sources: Map<string, ActivityItem[]>) {
  return [...sources.entries()]
    .flatMap(([source, items]) => items.map((item, index) => ({ source, index, item })))
    .sort(
      (left, right) =>
        (right.item.priority ?? 0) - (left.item.priority ?? 0) ||
        left.source.localeCompare(right.source) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

function publish(ctx: ExtensionContext, sources: Map<string, ActivityItem[]>) {
  const items = allItems(sources);
  if (items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
    render(width: number) {
      const current = allItems(sources);
      const shown = current.slice(0, MAX_VISIBLE_ITEMS);
      const lines = [
        truncateToWidth(
          `${theme.fg("accent", theme.bold("Active work"))} ${theme.fg("muted", `${current.length}`)}`,
          width,
        ),
      ];
      for (const item of shown) {
        const tone = color(item.state);
        const detail = item.detail ? theme.fg("dim", ` · ${oneLine(item.detail)}`) : "";
        lines.push(
          truncateToWidth(
            `${theme.fg(tone, glyph(item.state))} ${theme.fg("muted", item.label)} ${theme.fg(tone === "muted" ? "muted" : "text", oneLine(item.title))}${detail}`,
            width,
          ),
        );
      }
      if (current.length > shown.length) {
        lines.push(
          truncateToWidth(
            theme.fg("dim", `… +${current.length - shown.length} more · open the relevant dashboard`),
            width,
          ),
        );
      }
      return lines;
    },
    invalidate() {},
  }));
}

// Headless child sessions have no dock and must never touch another session's.
export function setActivitySource(ctx: ExtensionContext, source: string, items: ActivityItem[]) {
  if (!ctx.hasUI) return;
  const sources = sourcesFor(ctx.ui);
  if (items.length)
    sources.set(
      source,
      items.map((item) => ({ ...item })),
    );
  else sources.delete(source);
  publish(ctx, sources);
}

export function clearActivitySource(ctx: ExtensionContext, source: string) {
  if (!ctx.hasUI) return;
  const sources = sourcesFor(ctx.ui);
  if (!sources.delete(source)) return;
  publish(ctx, sources);
}

export function activityDockSnapshot(ui: DockUi) {
  return allItems(registry.get(ui) ?? new Map()).map((item) => ({ ...item }));
}
