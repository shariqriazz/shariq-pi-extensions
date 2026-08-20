import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  frameBottom,
  framedRow,
  frameTop,
  joinSides,
  oneLine,
  padLine,
  sanitizeTerminalText,
  stateLabel,
  viewportSlice,
} from "../../shared/tui-dashboard.ts";
import type { TerminalManagerView } from "./manager.ts";
import type { TerminalSnapshot } from "./types.ts";
import { terminalElapsedMs } from "./types.ts";
import { formatDurationMs } from "../../shared/tui-dashboard.ts";

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusState(snapshot: TerminalSnapshot): "active" | "success" | "warning" | "error" | "muted" {
  switch (snapshot.status) {
    case "running":
      return "active";
    case "done":
      return "success";
    case "failed":
      return "error";
    case "killed":
      return "muted";
  }
}

function outputLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of sanitizeTerminalText(text).split("\n")) {
    const carriageSegments = rawLine.split("\r");
    const line = carriageSegments.at(-1) || [...carriageSegments].reverse().find(Boolean) || "";
    if (!line) {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(line, Math.max(10, width)));
  }
  if (out.at(-1) === "") out.pop();
  return out;
}

class OutputLineCache {
  private key = "";
  private lines: string[] = [];

  get(snapshot: TerminalSnapshot, width: number): string[] {
    const key = `${snapshot.id}:${snapshot.output.version}:${width}`;
    if (key !== this.key) {
      this.key = key;
      this.lines = outputLines(snapshot.output.text, width);
    }
    return this.lines;
  }
}

export interface Selection {
  id?: string;
  index: number;
}

export function reconcileTerminalSelection(
  selection: Selection,
  terminals: ReadonlyArray<Pick<TerminalSnapshot, "id">>,
): void {
  const stable = selection.id
    ? terminals.findIndex((terminal) => terminal.id === selection.id)
    : -1;
  selection.index = stable >= 0
    ? stable
    : Math.min(Math.max(0, selection.index), Math.max(0, terminals.length - 1));
  selection.id = terminals[selection.index]?.id;
}

export async function openTerminalDashboard(
  ctx: ExtensionCommandContext,
  view: TerminalManagerView,
): Promise<void> {
  const selection: Selection = { index: 0 };
  while (view.list().length > 0) {
    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new TerminalDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (!selected) return;
    if (!view.get(selected)) continue;
    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
        new TerminalDetail(tui, theme, keybindings, view, selected, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
  }
}

export class TerminalDashboard implements Component {
  private closed = false;
  private killArmed?: string;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly view: TerminalManagerView;
  private readonly selection: Selection;
  private readonly done: (id: string | null) => void;
  private readonly outputCache = new OutputLineCache();

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: TerminalManagerView,
    selection: Selection,
    done: (id: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
    this.unsubscribe = this.view.subscribe(() => this.tui.requestRender());
  }

  private close(id: string | null): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
    this.done(id);
  }

  dispose(): void {
    if (!this.closed) {
      clearInterval(this.ticker);
      this.unsubscribe();
    }
    this.closed = true;
  }

  handleInput(data: string): void {
    const terminals = this.view.list();
    reconcileTerminalSelection(this.selection, terminals);
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const terminal = terminals[this.selection.index];
      if (terminal) this.close(terminal.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (terminals.length > 0) {
        this.selection.index = (this.selection.index - 1 + terminals.length) % terminals.length;
        this.selection.id = terminals[this.selection.index]?.id;
        this.killArmed = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (terminals.length > 0) {
        this.selection.index = (this.selection.index + 1) % terminals.length;
        this.selection.id = terminals[this.selection.index]?.id;
        this.killArmed = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const terminal = terminals[this.selection.index];
      if (!terminal || terminal.status !== "running") return;
      if (this.killArmed === terminal.id) {
        this.killArmed = undefined;
        this.view.requestKill(terminal.id);
      } else {
        this.killArmed = terminal.id;
      }
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const terminals = this.view.list();
    reconcileTerminalSelection(this.selection, terminals);
    const selected = terminals[this.selection.index];
    const running = terminals.filter((terminal) => terminal.status === "running").length;
    const failed = terminals.filter((terminal) => terminal.status === "failed").length;
    const completed = terminals.length - running - failed;
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(7, rows - 6);
    const innerWidth = Math.max(1, width - 2);
    const counts = [
      running ? stateLabel(theme, "active", `${running} running`) : "",
      completed ? stateLabel(theme, "success", `${completed} settled`) : "",
      failed ? stateLabel(theme, "error", `${failed} failed`) : "",
    ].filter(Boolean).join(theme.fg("dim", " · "));
    const lines = [
      joinSides(
        `  ${theme.fg("accent", theme.bold("Background terminals"))}`,
        `${counts || theme.fg("muted", "idle")}  `,
        width,
      ),
      frameTop(theme, width, `${terminals.length} terminal${terminals.length === 1 ? "" : "s"} · PTY sessions`),
    ];

    if (width >= 100 && selected) {
      const leftWidth = Math.max(38, Math.floor((innerWidth - 1) * 0.48));
      const rightWidth = Math.max(20, innerWidth - leftWidth - 1);
      const list = this.renderList(terminals, leftWidth, bodyHeight);
      const detail = this.renderPreview(selected, rightWidth, bodyHeight);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(
          theme.fg("border", "│") +
          padLine(list[row] ?? "", leftWidth) +
          theme.fg("borderMuted", "│") +
          padLine(detail[row] ?? "", rightWidth) +
          theme.fg("border", "│"),
        );
      }
    } else {
      const list = this.renderList(terminals, innerWidth, bodyHeight);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(framedRow(theme, list[row] ?? "", width));
      }
    }
    lines.push(frameBottom(theme, width));
    const killHint = this.killArmed ? theme.fg("warning", "x again to stop") : "x stop (confirm)";
    lines.push(
      truncateToWidth(
        theme.fg("dim", `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} inspect · ${killHint} · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`),
        width,
      ),
    );
    return lines;
  }

  private renderList(
    terminals: ReadonlyArray<TerminalSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const viewport = viewportSlice(terminals, this.selection.index, height);
    return viewport.items.map((terminal, row) => {
      const selected = viewport.start + row === this.selection.index;
      const left = ` ${selected ? this.theme.fg("accent", "❯") : " "} ${stateLabel(this.theme, statusState(terminal), terminal.id)} ${selected ? this.theme.fg("accent", oneLine(terminal.title)) : this.theme.fg("text", oneLine(terminal.title))}`;
      const right = `${this.theme.fg("muted", formatDurationMs(terminalElapsedMs(terminal)))} `;
      const line = joinSides(left, right, width);
      return selected ? this.theme.bg("selectedBg", padLine(line, width)) : line;
    });
  }

  private renderPreview(terminal: TerminalSnapshot, width: number, height: number): string[] {
    const theme = this.theme;
    const lines = [
      ` ${stateLabel(theme, statusState(terminal), terminal.status)} ${theme.fg("accent", theme.bold(oneLine(terminal.title)))}`,
      ` ${theme.fg("dim", `${terminal.id} · pid ${terminal.pid} · ${formatDurationMs(terminalElapsedMs(terminal))}`)}`,
      "",
      ` ${theme.fg("muted", "COMMAND")}`,
      ...wrapTextWithAnsi(oneLine(terminal.command), Math.max(10, width - 2)).slice(0, 2).map((line) => ` ${theme.fg("text", line)}`),
      "",
      ` ${theme.fg("muted", "OUTPUT")} ${theme.fg("text", formatSize(terminal.output.totalBytes))}${terminal.output.truncatedBytes ? theme.fg("warning", " · retained tail") : ""}`,
      ` ${theme.fg("muted", "SIZE")} ${theme.fg("text", `${terminal.cols}×${terminal.rows}`)}`,
      "",
      ` ${theme.fg("muted", "LATEST")}`,
    ];
    const output = this.outputCache.get(terminal, Math.max(10, width - 2));
    const room = Math.max(1, height - lines.length - 2);
    lines.push(...output.slice(-room).map((line) => ` ${theme.fg("toolOutput", line)}`));
    lines.push("", ` ${theme.fg("dim", terminal.cwd)}`);
    return lines.slice(0, height);
  }

  invalidate(): void {}
}

export class TerminalDetail implements Component, Focusable {
  private readonly input = new Input();
  private scrollOffset = 0;
  private closed = false;
  private killArmed = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly view: TerminalManagerView;
  private readonly id: string;
  private readonly done: (value: null) => void;
  private readonly outputCache = new OutputLineCache();
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: TerminalManagerView,
    id: string,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.id = id;
    this.done = done;
    this.unsubscribe = this.view.subscribeTo(id, () => this.scheduleRender());
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
    this.input.onSubmit = (value) => {
      const terminal = this.view.get(this.id);
      if (!terminal || terminal.status !== "running") return;
      this.view.requestWrite(this.id, `${value}\r`);
      this.input.setValue("");
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 40);
    this.renderTimer.unref?.();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    this.done(null);
  }

  private cleanup(): void {
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
  }

  dispose(): void {
    if (!this.closed) this.cleanup();
    this.closed = true;
  }

  handleInput(data: string): void {
    const terminal = this.view.get(this.id);
    if (matchesKey(data, Key.ctrl("c"))) {
      if (terminal?.status === "running") this.view.requestWrite(this.id, "\x03");
      return;
    }
    if (this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (data === "x") {
      if (terminal?.status !== "running") return;
      if (this.killArmed) {
        this.killArmed = false;
        this.view.requestKill(this.id);
      } else {
        this.killArmed = true;
      }
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp") || data === "k") {
      this.scrollOffset += Math.max(4, this.viewportHeight() - 2);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown") || data === "j") {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(4, this.viewportHeight() - 2));
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    this.killArmed = false;
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    return Math.max(5, (this.tui.terminal.rows || 30) - 10);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const terminal = this.view.get(this.id);
    if (!terminal) return [frameTop(theme, width, "Terminal"), framedRow(theme, "No longer tracked", width), frameBottom(theme, width)];
    const viewport = this.viewportHeight();
    if (terminal.status === "running") {
      this.view.requestResize(this.id, Math.max(20, width - 2), viewport);
    }
    const lines = [
      joinSides(
        `  ${stateLabel(theme, statusState(terminal), terminal.status)} ${theme.fg("accent", theme.bold(`${terminal.id} · ${oneLine(terminal.title)}`))}`,
        `${theme.fg("muted", `pid ${terminal.pid} · ${formatDurationMs(terminalElapsedMs(terminal))}`)}  `,
        width,
      ),
      truncateToWidth(`  ${theme.fg("dim", "$ ")}${theme.fg("text", oneLine(terminal.command))}`, width),
      frameTop(theme, width, `live output · ${formatSize(terminal.output.totalBytes)} · ${terminal.cols}×${terminal.rows}`),
    ];
    const output = this.outputCache.get(terminal, Math.max(10, width - 4));
    const maxOffset = Math.max(0, output.length - viewport);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = output.length - this.scrollOffset;
    const visible = output.slice(Math.max(0, end - viewport), end);
    const body = visible.length > 0 ? visible : [theme.fg("dim", "(waiting for output)")];
    for (let row = 0; row < viewport; row++) {
      lines.push(framedRow(theme, ` ${body[row] ?? ""}`, width));
    }
    lines.push(frameBottom(theme, width));
    if (terminal.status === "running") lines.push(...this.input.render(width));
    else lines.push(truncateToWidth(`  ${theme.fg("muted", "Process settled; input is closed.")}`, width));
    const stop = this.killArmed ? theme.fg("warning", "x again to stop") : "x stop (confirm)";
    lines.push(
      truncateToWidth(
        theme.fg("dim", `  enter send · ctrl+c interrupt PTY · ${stop} · pgup/pgdn or j/k scroll · g/G top/bottom · ${configuredKeys(this.keybindings, "tui.select.cancel")} back`),
        width,
      ),
    );
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
