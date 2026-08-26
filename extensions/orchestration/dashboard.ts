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
import { frameBottom, frameTop, framedRow, joinSides } from "../shared/tui-dashboard.ts";
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
  private detailScroll = 0;
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
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(8, rows - 5);

    if (matchesKey(data, Key.escape)) {
      if (this.detail) {
        this.detail = false;
        this.detailScroll = 0;
      } else {
        this.close({ kind: "close" });
        return;
      }
    } else if (this.detail) {
      if (this.keys.matches(data, "tui.select.up") || data === "k" || matchesKey(data, Key.up)) {
        this.detailScroll = Math.max(0, this.detailScroll - 1);
      } else if (this.keys.matches(data, "tui.select.down") || data === "j" || matchesKey(data, Key.down)) {
        this.detailScroll = this.detailScroll + 1;
      } else if (matchesKey(data, Key.pageUp)) {
        this.detailScroll = Math.max(0, this.detailScroll - Math.max(1, bodyHeight - 4));
      } else if (matchesKey(data, Key.pageDown)) {
        this.detailScroll = this.detailScroll + Math.max(1, bodyHeight - 4);
      } else if (runs[this.selected]) {
        const run = runs[this.selected];
        if (data === "a" && run.status === "awaiting-approval") this.close({ kind: "approve", id: run.id });
        else if (data === "f" && run.status === "awaiting-approval") this.close({ kind: "feedback", id: run.id });
        else if (data === "p") this.close({ kind: "toggle-pause", id: run.id });
        else if (data === "x") this.close({ kind: "cancel", id: run.id });
      }
    } else if (!this.detail) {
      if (this.keys.matches(data, "tui.select.up") || data === "k" || matchesKey(data, Key.up)) {
        this.selected = Math.max(0, this.selected - 1);
        this.selectedId = runs[this.selected]?.id;
      } else if (this.keys.matches(data, "tui.select.down") || data === "j" || matchesKey(data, Key.down)) {
        this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
        this.selectedId = runs[this.selected]?.id;
      } else if (this.keys.matches(data, "tui.select.confirm") && runs[this.selected]) {
        this.detail = true;
        this.detailScroll = 0;
      } else if (data === "n") this.close({ kind: "create" });
      else if (data === "s") this.close({ kind: "settings" });
    }
    this.tui.requestRender();
  }

  render(width: number) {
    const runs = this.engine.list();
    this.reconcileSelection(runs);
    const selected = runs[this.selected];
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(8, rows - 5);
    const innerWidth = Math.max(1, width - 2);

    let body: string[];
    if (this.detail && selected) {
      const allDetailLines = this.renderDetail(selected, innerWidth);
      const maxScroll = Math.max(0, allDetailLines.length - bodyHeight);
      this.detailScroll = Math.min(this.detailScroll, maxScroll);
      const visible = allDetailLines.slice(this.detailScroll, this.detailScroll + bodyHeight);
      if (this.detailScroll > 0 && visible.length > 0) {
        visible[0] = this.theme.fg("dim", `  ↑ ${this.detailScroll} more lines`);
      }
      if (this.detailScroll + bodyHeight < allDetailLines.length && visible.length > 0) {
        visible[visible.length - 1] = this.theme.fg("dim", `  ↓ ${allDetailLines.length - (this.detailScroll + bodyHeight)} more lines`);
      }
      body = visible;
    } else {
      const listContent = this.renderList(runs, innerWidth);
      body = listContent.length > bodyHeight
        ? [...listContent.slice(0, bodyHeight - 1), this.theme.fg("dim", "… more")]
        : listContent;
    }

    const status = runs.length
      ? `${runs.filter((run) => ["planning", "running"].includes(run.status)).length} active · ${runs.length} total`
      : "idle";
    const controls = this.detail && selected
      ? [
          selected.status === "awaiting-approval" ? "a approve · f feedback" : "",
          ["paused", "interrupted", "blocked"].includes(selected.status) ? "p resume" : selected.status === "running" ? "p pause" : "",
          !["completed", "cancelled"].includes(selected.status) ? "x cancel" : "",
          "j/k scroll",
          "esc back",
        ].filter(Boolean).join(" · ")
      : "j/k select · enter open · n new · s settings · esc close";
    const lines = [
      joinSides(`  ${this.theme.fg("accent", this.theme.bold("◆ ORCHESTRATION"))}`, `${this.theme.fg("muted", status)}  `, width),
      frameTop(this.theme, width, this.detail && selected ? `${selected.id} · RUN DETAIL` : `${runs.length} RUN${runs.length === 1 ? "" : "S"} · CONTROL CENTER`),
    ];
    for (let row = 0; row < bodyHeight; row++) lines.push(framedRow(this.theme, body[row] ?? "", width));
    lines.push(frameBottom(this.theme, width));
    lines.push(truncateToWidth(this.theme.fg("dim", `  ${controls}`), width, ""));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private split(left: string, right: string, width: number) {
    const rightWidth = visibleWidth(right);
    const clipped = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
    return clipped + " ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth)) + right;
  }

  private renderList(runs: OrchestrationRun[], width: number) {
    const lines: string[] = [];
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
    if (start > 0) lines.unshift(this.theme.fg("dim", `  ↑ ${start} more`));
    const below = runs.length - start - visible.length;
    if (below > 0) lines.push(this.theme.fg("dim", `  ↓ ${below} more`));
    return lines;
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
    return lines;
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
