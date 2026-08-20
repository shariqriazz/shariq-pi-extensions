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

interface DashboardActions {
  create(): void;
  settings(): void;
  feedback(run: OrchestrationRun): void;
  approve(run: OrchestrationRun): void;
  togglePause(run: OrchestrationRun): void;
  cancel(run: OrchestrationRun): void;
}

type Theme = ExtensionContext["ui"]["theme"];

class OrchestrationDashboard {
  private selected = 0;
  private detail = false;
  private unsubscribe: () => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly engine: OrchestrationEngine;
  private readonly actions: DashboardActions;
  private readonly close: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    engine: OrchestrationEngine,
    actions: DashboardActions,
    close: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.engine = engine;
    this.actions = actions;
    this.close = close;
    this.unsubscribe = engineChangeSubscription(engine, () => tui.requestRender());
  }

  dispose() {
    this.unsubscribe();
  }

  invalidate() {}

  handleInput(data: string) {
    const runs = this.engine.list();
    if (matchesKey(data, Key.escape)) {
      if (this.detail) this.detail = false;
      else {
        this.dispose();
        this.close();
        return;
      }
    } else if (!this.detail && (this.keys.matches(data, "tui.select.up") || data === "k")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (!this.detail && (this.keys.matches(data, "tui.select.down") || data === "j")) {
      this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
    } else if (!this.detail && this.keys.matches(data, "tui.select.confirm") && runs[this.selected]) {
      this.detail = true;
    } else if (data === "n") this.actions.create();
    else if (data === "s") this.actions.settings();
    else if (this.detail && runs[this.selected]) {
      const run = runs[this.selected];
      if (data === "a" && run.status === "awaiting-approval") this.actions.approve(run);
      else if (data === "f" && run.status === "awaiting-approval") this.actions.feedback(run);
      else if (data === "p") this.actions.togglePause(run);
      else if (data === "x") this.actions.cancel(run);
    }
    this.tui.requestRender();
  }

  render(width: number) {
    const runs = this.engine.list();
    this.selected = Math.min(this.selected, Math.max(0, runs.length - 1));
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
    for (const [index, run] of runs.entries()) {
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
    lines.push("", this.theme.fg("dim", "j/k select · enter open · n new · s settings · esc close"));
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
    const controls = [
      run.status === "awaiting-approval" ? "a approve · f feedback" : "",
      ["paused", "interrupted", "blocked"].includes(run.status) ? "p resume" : run.status === "running" ? "p pause" : "",
      !["completed", "cancelled"].includes(run.status) ? "x cancel" : "",
      "esc back",
    ].filter(Boolean).join(" · ");
    lines.push("", this.theme.fg("dim", controls));
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
  actions: DashboardActions,
) {
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) =>
      new OrchestrationDashboard(tui, theme, keys, engine, actions, () => done(undefined)),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
