import type {
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import type { OrchestrationEngine } from "./engine.ts";
import type { OrchestrationRun } from "./types.ts";

export type OrchestrationDashboardAction =
  | { kind: "close" }
  | { kind: "create" }
  | { kind: "settings" }
  | { kind: "feedback"; id: string }
  | { kind: "approve"; id: string }
  | { kind: "toggle-pause"; id: string }
  | { kind: "cancel"; id: string };

type Theme = ExtensionContext["ui"]["theme"];

class OrchestrationDashboard {
  private selected = 0;
  private selectedId?: string;
  private detail = false;
  private unsubscribe: () => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly engine: OrchestrationEngine;
  private readonly done: (action: OrchestrationDashboardAction) => void;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    engine: OrchestrationEngine,
    done: (action: OrchestrationDashboardAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.engine = engine;
    this.done = done;
    this.unsubscribe = engineChangeSubscription(engine, () => tui.requestRender());
  }

  private close(action: OrchestrationDashboardAction) {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.done(action);
  }

  dispose() {
    if (!this.closed) this.unsubscribe();
    this.closed = true;
  }

  invalidate() {}

  private reconcileSelection(runs: OrchestrationRun[]) {
    const stable = this.selectedId ? runs.findIndex((run) => run.id === this.selectedId) : -1;
    this.selected = stable >= 0 ? stable : Math.min(this.selected, Math.max(0, runs.length - 1));
    this.selectedId = runs[this.selected]?.id;
  }

  handleInput(data: string) {
    const runs = this.engine.list();
    this.reconcileSelection(runs);
    if (matchesKey(data, Key.escape)) {
      if (this.detail) this.detail = false;
      else {
        this.close({ kind: "close" });
        return;
      }
    } else if (!this.detail && (this.keys.matches(data, "tui.select.up") || data === "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.selectedId = runs[this.selected]?.id;
    } else if (!this.detail && (this.keys.matches(data, "tui.select.down") || data === "j")) {
      this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
      this.selectedId = runs[this.selected]?.id;
    } else if (!this.detail && this.keys.matches(data, "tui.select.confirm") && runs[this.selected]) {
      this.detail = true;
    } else if (data === "n") this.close({ kind: "create" });
    else if (data === "s") this.close({ kind: "settings" });
    else if (this.detail && runs[this.selected]) {
      const run = runs[this.selected];
      if (data === "a" && run.status === "awaiting-approval") this.close({ kind: "approve", id: run.id });
      else if (data === "f" && run.status === "awaiting-approval") this.close({ kind: "feedback", id: run.id });
      else if (data === "p") this.close({ kind: "toggle-pause", id: run.id });
      else if (data === "x") this.close({ kind: "cancel", id: run.id });
    }
    this.tui.requestRender();
  }

  render(width: number) {
    const runs = this.engine.list();
    this.reconcileSelection(runs);
    const lines = this.detail && runs[this.selected]
      ? this.renderDetail(runs[this.selected], width)
      : this.renderList(runs, width);
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private split(left: string, right: string, width: number) {
    const rightWidth = visibleWidth(right);
    const clipped = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
    return clipped + " ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth)) + right;
  }

  private renderList(runs: OrchestrationRun[], width: number) {
    const lines = [
      this.split(
        this.theme.fg("accent", this.theme.bold("Orchestration")),
        this.theme.fg("dim", `${runs.length} run${runs.length === 1 ? "" : "s"}`),
        width,
      ),
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
    ];
    if (!runs.length) lines.push(this.theme.fg("muted", "No runs yet. Press n to create one."));
    const rows = this.tui.terminal.rows || 30;
    const visibleCount = Math.max(1, Math.floor((rows - 5) / 2));
    const start = Math.min(Math.max(0, this.selected - Math.floor(visibleCount / 2)), Math.max(0, runs.length - visibleCount));
    const visible = runs.slice(start, start + visibleCount);
    for (const [offset, run] of visible.entries()) {
      const index = start + offset;
      const marker = index === this.selected ? this.theme.fg("accent", "❯") : " ";
      const complete = run.tasks.filter((task) => task.status === "completed").length;
      const color = run.status === "completed" ? "success" : run.status === "blocked" ? "error" : run.status === "running" ? "warning" : "muted";
      lines.push(
        this.split(
          `${marker} ${this.theme.fg(color, "■")} ${this.theme.fg(index === this.selected ? "accent" : "text", run.objective.slice(0, 72))}`,
          this.theme.fg("dim", `${complete}/${run.tasks.length} · ${run.status}`),
          width,
        ),
      );
      lines.push(`    ${this.theme.fg("dim", `${run.id} · ${run.cwd}`)}`);
    }
    if (start > 0) lines.splice(2, 0, this.theme.fg("dim", `  ↑ ${start} more`));
    const below = runs.length - start - visible.length;
    if (below > 0) lines.push(this.theme.fg("dim", `  ↓ ${below} more`));
    lines.push("", this.theme.fg("dim", "j/k select · enter open · n new · s settings · esc close"));
    const maxRows = Math.max(8, rows);
    if (lines.length <= maxRows) return lines;
    return [...lines.slice(0, maxRows - 2), this.theme.fg("dim", "… more runs"), lines.at(-1)!];
  }

  private renderDetail(run: OrchestrationRun, width: number) {
    const lines = [
      this.split(
        this.theme.fg("accent", this.theme.bold(run.objective.slice(0, 100))),
        this.theme.fg(run.status === "completed" ? "success" : run.status === "blocked" ? "error" : "warning", run.status),
        width,
      ),
      this.theme.fg("dim", `${run.id} · ${run.cwd}`),
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
      this.theme.fg("muted", run.summary || "No summary yet."),
      "",
      this.theme.fg("accent", this.theme.bold("Tasks")),
    ];
    for (const task of run.tasks) {
      const color = task.status === "completed" ? "success" : task.status === "blocked" ? "error" : ["implementing", "reviewing", "integrating"].includes(task.status) ? "warning" : "muted";
      lines.push(
        this.split(
          ` ${this.theme.fg(color, "■")} ${this.theme.fg("text", task.title)} ${this.theme.fg("dim", `(${task.role})`)}`,
          this.theme.fg(color, task.status),
          width,
        ),
      );
      if (task.dependencies.length) lines.push(`   ${this.theme.fg("dim", `depends: ${task.dependencies.join(", ")}`)}`);
      if (task.reviewSummary) lines.push(`   ${this.theme.fg("muted", `review: ${task.reviewSummary.slice(0, 140)}`)}`);
      if (task.error) lines.push(`   ${this.theme.fg("error", task.error.slice(0, 180))}`);
    }
    if (run.finalReviewSummary) lines.push("", this.theme.fg("accent", `Final review: ${run.finalReviewSummary}`));
    if (run.error) lines.push("", this.theme.fg("error", run.error));
    const controls = [
      run.status === "awaiting-approval" ? "a approve · f feedback" : "",
      ["paused", "interrupted", "blocked"].includes(run.status) ? "p resume" : run.status === "running" ? "p pause" : "",
      !["completed", "cancelled"].includes(run.status) ? "x cancel" : "",
      "esc back",
    ].filter(Boolean).join(" · ");
    lines.push("", this.theme.fg("dim", controls));
    const maxRows = Math.max(8, (this.tui.terminal.rows || 30) - 2);
    if (lines.length <= maxRows) return lines;
    return [...lines.slice(0, maxRows - 2), this.theme.fg("dim", "… more tasks in run state"), lines.at(-1)!];
  }
}

const listeners = new WeakMap<OrchestrationEngine, Set<() => void>>();
export function notifyDashboard(engine: OrchestrationEngine) {
  for (const listener of listeners.get(engine) ?? []) listener();
}
function engineChangeSubscription(engine: OrchestrationEngine, listener: () => void) {
  const set = listeners.get(engine) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(engine, set);
  return () => set.delete(listener);
}

export async function openOrchestrationDashboard(
  ctx: ExtensionContext,
  engine: OrchestrationEngine,
) {
  return ctx.ui.custom<OrchestrationDashboardAction>(
    (tui, theme, keys, done) =>
      new OrchestrationDashboard(tui, theme, keys, engine, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
