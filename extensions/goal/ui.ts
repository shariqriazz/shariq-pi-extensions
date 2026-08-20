import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  frameBottom,
  framedRow,
  frameTop,
  joinSides,
  meter,
  oneLine,
  padLine,
  stateLabel,
  type SemanticState,
  viewportSlice,
} from "../shared/tui-dashboard.ts";
import type { GoalProgressItem, GoalState, GoalStatus } from "./types.ts";

export type GoalDashboardAction =
  | "close"
  | "edit"
  | "pause"
  | "resume"
  | "clear";

interface GoalDashboardOptions {
  getGoal(): GoalState | null;
  elapsedSeconds(goal: GoalState): number;
  formatTokens(tokens: number): string;
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusState(status: GoalStatus): SemanticState {
  switch (status) {
    case "active":
      return "active";
    case "complete":
      return "success";
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "warning";
    case "paused":
      return "muted";
  }
}

function progressState(item: GoalProgressItem): SemanticState {
  switch (item.status) {
    case "complete":
      return "success";
    case "blocked":
      return "error";
    case "in_progress":
      return "active";
    case "pending":
      return "muted";
  }
}

function progressColor(item: GoalProgressItem): "accent" | "success" | "warning" | "error" | "muted" {
  switch (progressState(item)) {
    case "active":
      return "accent";
    case "success":
      return "success";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "muted":
      return "muted";
  }
}

function progressGlyph(item: GoalProgressItem): string {
  switch (item.status) {
    case "complete":
      return "✓";
    case "blocked":
      return "!";
    case "in_progress":
      return "◆";
    case "pending":
      return "○";
  }
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  return `${remainder}s`;
}

export class GoalDashboard implements Component {
  private selected = 0;
  private closed = false;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly options: GoalDashboardOptions;
  private readonly done: (action: GoalDashboardAction) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: GoalDashboardOptions,
    done: (action: GoalDashboardAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.options = options;
    this.done = done;
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
  }

  private close(action: GoalDashboardAction): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.done(action);
  }

  dispose(): void {
    if (!this.closed) clearInterval(this.ticker);
    this.closed = true;
  }

  handleInput(data: string): void {
    const goal = this.options.getGoal();
    const progress = goal?.progress ?? [];
    this.selected = Math.min(this.selected, Math.max(0, progress.length - 1));

    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "q"
    ) {
      this.close("close");
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (progress.length > 0) {
        this.selected = (this.selected - 1 + progress.length) % progress.length;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (progress.length > 0) {
        this.selected = (this.selected + 1) % progress.length;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "e") {
      this.close("edit");
      return;
    }
    if (data === "x") {
      this.close("clear");
      return;
    }
    if (data === "p" || data === " ") {
      if (goal?.status === "active") this.close("pause");
      else if (goal && goal.status !== "complete" && goal.status !== "budget_limited") {
        this.close("resume");
      }
      return;
    }
    if (data === "r" && goal && goal.status !== "active" && goal.status !== "complete") {
      this.close("resume");
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const goal = this.options.getGoal();
    if (!goal) {
      return [
        frameTop(theme, width, "Goal"),
        framedRow(theme, theme.fg("muted", "No goal is currently set."), width),
        frameBottom(theme, width),
      ];
    }

    const rows = this.tui.terminal.rows || 30;
    const completed = goal.progress.filter((item) => item.status === "complete").length;
    const current = goal.progress.find((item) => item.status === "in_progress");
    const status = stateLabel(theme, statusState(goal.status), goal.status.replaceAll("_", " "));
    const elapsed = formatElapsed(this.options.elapsedSeconds(goal));
    const titleLeft = theme.fg("accent", theme.bold("Goal control center"));
    const titleRight = `${status}${theme.fg("dim", ` · ${elapsed}`)}`;
    const lines: string[] = [joinSides(`  ${titleLeft}`, `${titleRight}  `, width)];

    const progressText = goal.progress.length > 0
      ? `${completed}/${goal.progress.length} complete`
      : "checklist not started";
    const progressMeter = goal.progress.length > 0
      ? meter(theme, completed, goal.progress.length, Math.min(28, Math.max(12, width - 48)), completed === goal.progress.length ? "success" : "active")
      : theme.fg("borderMuted", "────────");
    lines.push(
      joinSides(
        `  ${theme.fg("muted", "PROGRESS")}  ${progressMeter} ${theme.fg("text", progressText)}`,
        goal.tokenBudget == null
          ? `${theme.fg("muted", "TOKENS")} ${theme.fg("text", this.options.formatTokens(goal.tokensUsed))}  `
          : `${theme.fg("muted", "BUDGET")} ${theme.fg("text", `${this.options.formatTokens(goal.tokensUsed)} / ${this.options.formatTokens(goal.tokenBudget)}`)}  `,
        width,
      ),
    );
    if (goal.tokenBudget != null && width >= 72) {
      lines.push(
        `  ${theme.fg("muted", "TOKEN BUDGET")}  ${meter(theme, goal.tokensUsed, goal.tokenBudget, Math.max(12, width - 24), goal.tokensUsed >= goal.tokenBudget ? "warning" : "active")}`,
      );
    }

    lines.push(frameTop(theme, width, "objective"));
    const objectiveWidth = Math.max(10, width - 4);
    const objectiveLines = wrapTextWithAnsi(oneLine(goal.objective), objectiveWidth).slice(0, 3);
    for (const line of objectiveLines) {
      lines.push(framedRow(theme, ` ${theme.fg("text", line)}`, width));
    }
    if (objectiveLines.length === 0) lines.push(framedRow(theme, "", width));
    lines.push(frameBottom(theme, width));

    const chromeRows = lines.length + 5;
    const detailRows = current || goal.continuationSuppressed || goal.blockedTurnStreak > 0 ? 2 : 0;
    const listHeight = Math.max(3, rows - chromeRows - detailRows);
    lines.push(frameTop(theme, width, `checklist · ${completed}/${goal.progress.length}`));

    if (goal.progress.length === 0) {
      lines.push(
        framedRow(
          theme,
          ` ${theme.fg("muted", "No checklist yet — the agent creates one for meaningful multi-step work.")}`,
          width,
        ),
      );
      for (let index = 1; index < listHeight; index++) lines.push(framedRow(theme, "", width));
    } else {
      this.selected = Math.min(this.selected, goal.progress.length - 1);
      const viewport = viewportSlice(goal.progress, this.selected, listHeight);
      for (let row = 0; row < listHeight; row++) {
        const item = viewport.items[row];
        if (!item) {
          lines.push(framedRow(theme, "", width));
          continue;
        }
        const index = viewport.start + row;
        const selected = index === this.selected;
        const marker = selected ? theme.fg("accent", "❯") : " ";
        const glyph = theme.fg(progressColor(item), progressGlyph(item));
        const id = theme.fg("dim", `[${oneLine(item.id)}]`);
        const itemStatus = theme.fg(
          progressColor(item),
          item.status.replaceAll("_", " "),
        );
        const right = `${itemStatus} `;
        const left = ` ${marker} ${glyph} ${id} ${selected ? theme.fg("accent", oneLine(item.title)) : theme.fg("text", oneLine(item.title))}`;
        lines.push(framedRow(theme, joinSides(left, right, Math.max(0, width - 2)), width, selected));
      }
    }
    lines.push(frameBottom(theme, width));

    const selectedItem = goal.progress[this.selected];
    if (selectedItem?.evidence) {
      lines.push(
        truncateToWidth(
          `  ${theme.fg("success", "evidence")} ${theme.fg("muted", oneLine(selectedItem.evidence))}`,
          width,
        ),
      );
    } else if (goal.continuationSuppressed) {
      lines.push(
        truncateToWidth(
          `  ${theme.fg("warning", "waiting")} ${theme.fg("muted", oneLine(goal.continuationSuppressed.message))}`,
          width,
        ),
      );
    } else if (goal.blockedTurnStreak > 0) {
      lines.push(
        `  ${theme.fg("warning", `blocked gate ${goal.blockedTurnStreak}/3 turns`)}`,
      );
    }

    const toggle = goal.status === "active" ? "p pause" : goal.status === "complete" ? "" : "r resume";
    const hints = [
      `${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select`,
      toggle,
      "e edit",
      "x clear",
      `${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
    ].filter(Boolean).join(" · ");
    lines.push(truncateToWidth(theme.fg("dim", `  ${hints}`), width));
    return lines.map((line) => padLine(line, width));
  }

  invalidate(): void {}
}

export async function openGoalDashboard(
  ctx: ExtensionCommandContext,
  options: GoalDashboardOptions,
): Promise<GoalDashboardAction> {
  if (ctx.mode !== "tui") return "close";
  return ctx.ui.custom<GoalDashboardAction>(
    (tui, theme, keybindings, done) =>
      new GoalDashboard(tui, theme, keybindings, options, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        minWidth: 48,
        maxHeight: "100%",
      },
    },
  );
}
