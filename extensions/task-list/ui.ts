import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  frameBottom,
  framedRow,
  frameTop,
  joinSides,
  meter,
  oneLine,
  padLine,
  stateLabel,
  viewportSlice,
  type SemanticState,
} from "../shared/tui-dashboard.ts";
import { taskCounts } from "./state.ts";
import type { TaskItem, TaskListState, TaskPriority, TaskStatus } from "./types.ts";

export type TaskDashboardAction =
  | { kind: "close" }
  | { kind: "add" }
  | { kind: "edit"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "status"; id: string; status: TaskStatus }
  | { kind: "priority"; id: string; priority: TaskPriority }
  | { kind: "clear" };

interface TaskDashboardOptions {
  getState(): TaskListState;
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusState(status: TaskStatus): SemanticState {
  switch (status) {
    case "in_progress": return "active";
    case "completed": return "success";
    case "blocked": return "error";
    case "pending":
    case "cancelled": return "muted";
  }
}

function statusColor(status: TaskStatus): "accent" | "success" | "error" | "muted" {
  switch (status) {
    case "in_progress": return "accent";
    case "completed": return "success";
    case "blocked": return "error";
    case "pending":
    case "cancelled": return "muted";
  }
}

export function taskGlyph(status: TaskStatus): string {
  switch (status) {
    case "pending": return "○";
    case "in_progress": return "◆";
    case "completed": return "✓";
    case "blocked": return "!";
    case "cancelled": return "×";
  }
}

function nextWorkingStatus(status: TaskStatus): TaskStatus {
  switch (status) {
    case "pending": return "in_progress";
    case "in_progress": return "completed";
    case "completed": return "pending";
    case "blocked": return "in_progress";
    case "cancelled": return "pending";
  }
}

function nextPriority(priority: TaskPriority): TaskPriority {
  if (priority === "high") return "medium";
  if (priority === "medium") return "low";
  return "high";
}

export class TaskDashboard implements Component {
  private selected = 0;
  private showFinished = true;
  private closed = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly options: TaskDashboardOptions;
  private readonly done: (action: TaskDashboardAction) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: TaskDashboardOptions,
    done: (action: TaskDashboardAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.options = options;
    this.done = done;
  }

  private visibleTasks(): TaskItem[] {
    const tasks = this.options.getState().tasks;
    return this.showFinished
      ? tasks
      : tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
  }

  private close(action: TaskDashboardAction): void {
    if (this.closed) return;
    this.closed = true;
    this.done(action);
  }

  private selectedTask(): TaskItem | undefined {
    const visible = this.visibleTasks();
    this.selected = Math.min(this.selected, Math.max(0, visible.length - 1));
    return visible[this.selected];
  }

  handleInput(data: string): void {
    const visible = this.visibleTasks();
    this.selected = Math.min(this.selected, Math.max(0, visible.length - 1));
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      this.close({ kind: "close" });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (visible.length > 0) this.selected = (this.selected - 1 + visible.length) % visible.length;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (visible.length > 0) this.selected = (this.selected + 1) % visible.length;
      this.tui.requestRender();
      return;
    }
    if (data === "h") {
      this.showFinished = !this.showFinished;
      this.selected = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "a") {
      this.close({ kind: "add" });
      return;
    }
    if (data === "X") {
      this.close({ kind: "clear" });
      return;
    }
    const task = this.selectedTask();
    if (!task) return;
    if (data === "e") this.close({ kind: "edit", id: task.id });
    else if (data === "d") this.close({ kind: "delete", id: task.id });
    else if (data === " ") this.close({ kind: "status", id: task.id, status: nextWorkingStatus(task.status) });
    else if (data === "b") this.close({ kind: "status", id: task.id, status: task.status === "blocked" ? "pending" : "blocked" });
    else if (data === "c") this.close({ kind: "status", id: task.id, status: task.status === "cancelled" ? "pending" : "cancelled" });
    else if (data === "p") this.close({ kind: "priority", id: task.id, priority: nextPriority(task.priority) });
  }

  render(width: number): string[] {
    const state = this.options.getState();
    const visible = this.visibleTasks();
    const counts = taskCounts(state.tasks);
    this.selected = Math.min(this.selected, Math.max(0, visible.length - 1));
    const rows = this.tui.terminal.rows || 30;
    const completed = counts.completed + counts.cancelled;
    const stateTone: SemanticState = counts.blocked > 0 ? "warning" : counts.inProgress > 0 ? "active" : completed === counts.total && counts.total > 0 ? "success" : "muted";
    const stateText = counts.blocked > 0
      ? `${counts.blocked} blocked`
      : counts.inProgress > 0
        ? `${counts.inProgress} active`
        : completed === counts.total && counts.total > 0
          ? "all done"
          : "waiting";
    const title = `  ${this.theme.fg("accent", this.theme.bold("Task list"))}`;
    const summary = `${stateLabel(this.theme, stateTone, stateText)}  `;
    const lines: string[] = [joinSides(title, summary, width)];
    lines.push(joinSides(
      `  ${meter(this.theme, completed, Math.max(1, counts.total), Math.min(28, Math.max(12, width - 54)), completed === counts.total && counts.total > 0 ? "success" : "active")} ${this.theme.fg("text", `${completed}/${counts.total} finished`)}`,
      `${this.theme.fg("muted", `${counts.pending} pending · ${counts.blocked} blocked`)}  `,
      width,
    ));
    if (state.explanation) {
      lines.push(truncateToWidth(`  ${this.theme.fg("dim", oneLine(state.explanation))}`, width));
    }

    const chromeRows = lines.length + 3;
    const detailRows = 2;
    const listHeight = Math.max(4, rows - chromeRows - detailRows);
    lines.push(frameTop(this.theme, width, `tasks · ${visible.length}${this.showFinished ? "" : ` of ${counts.total}`}`));
    if (visible.length === 0) {
      const empty = counts.total === 0
        ? "No tasks yet — the agent creates a list for multi-step work."
        : "No active tasks. Press h to show completed and cancelled items.";
      lines.push(framedRow(this.theme, ` ${this.theme.fg("muted", empty)}`, width));
      for (let index = 1; index < listHeight; index++) lines.push(framedRow(this.theme, "", width));
    } else {
      const viewport = viewportSlice(visible, this.selected, listHeight);
      for (let row = 0; row < listHeight; row++) {
        const task = viewport.items[row];
        if (!task) {
          lines.push(framedRow(this.theme, "", width));
          continue;
        }
        const index = viewport.start + row;
        const selected = index === this.selected;
        const marker = selected ? this.theme.fg("accent", "❯") : " ";
        const glyph = this.theme.fg(statusColor(task.status), taskGlyph(task.status));
        const id = this.theme.fg("dim", `[${oneLine(task.id)}]`);
        const priority = task.priority === "medium" ? "" : this.theme.fg(task.priority === "high" ? "warning" : "dim", ` ${task.priority}`);
        const right = `${this.theme.fg(statusColor(task.status), task.status.replaceAll("_", " "))}${priority} `;
        const left = ` ${marker} ${glyph} ${id} ${selected ? this.theme.fg("accent", oneLine(task.content)) : this.theme.fg(task.status === "completed" || task.status === "cancelled" ? "muted" : "text", oneLine(task.content))}`;
        lines.push(framedRow(this.theme, joinSides(left, right, Math.max(0, width - 2)), width, selected));
      }
    }
    lines.push(frameBottom(this.theme, width));

    const selected = visible[this.selected];
    if (selected?.note) {
      const wrapped = wrapTextWithAnsi(`${this.theme.fg("muted", "note")} ${this.theme.fg("dim", oneLine(selected.note))}`, Math.max(1, width - 4));
      lines.push(truncateToWidth(`  ${wrapped[0] ?? ""}`, width));
    } else {
      lines.push("");
    }
    const keys = `${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · space advance · b block · c cancel · p priority · a add · e edit · d delete · h ${this.showFinished ? "hide" : "show"} done · X clear · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`;
    lines.push(truncateToWidth(this.theme.fg("dim", `  ${keys}`), width));
    return lines.map((line) => padLine(line, width));
  }

  invalidate(): void {}
}

export async function openTaskDashboard(
  ctx: ExtensionCommandContext,
  options: TaskDashboardOptions,
): Promise<TaskDashboardAction> {
  if (ctx.mode !== "tui") return { kind: "close" };
  return ctx.ui.custom<TaskDashboardAction>(
    (tui, theme, keybindings, done) => new TaskDashboard(tui, theme, keybindings, options, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        minWidth: 52,
        maxHeight: "100%",
      },
    },
  );
}
