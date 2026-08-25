/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: full popup (overlay) listing all subagents.
 * - TakeoverView: full interactive view of one subagent with an input line
 *   to steer/continue it.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed, latestText, type SubagentSnapshot } from "../domain.ts";
import { contextPercent, formatContextUtilization } from "../format.ts";
import {
  joinSides,
  meter,
  oneLine,
  padLine,
  stateLabel,
  viewportSlice,
} from "../../../shared/tui-dashboard.ts";
import type { SubagentReadModel } from "../manager.ts";
import { buildTranscriptLines } from "./transcript.ts";

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

// --- Entry point ---------------------------------------------------------------

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    await openSubagentTakeover(ctx, view, picked);
    // After leaving the takeover view, fall back to the dashboard.
  }
}

export async function openSubagentTakeover(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
  id: string,
) {
  if (!view.get(id)) {
    ctx.ui.notify(`Subagent ${id} is no longer tracked`, "warning");
    return;
  }
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(tui, theme, keybindings, id, view, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

export async function openPeerMessageViewer(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
) {
  if (view.peerMessages().length === 0) {
    ctx.ui.notify("No peer messages yet", "info");
    return;
  }
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) => {
      const unsubscribe = view.subscribe(() => tui.requestRender());
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        done(null);
      };
      return {
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.cancel") ||
            keybindings.matches(data, "tui.select.confirm")
          ) close();
        },
        render(width: number) {
          const messages = view.peerMessages().slice(-Math.max(1, (tui.terminal.rows || 30) - 5));
          const lines = [theme.fg("accent", theme.bold("Peer coordination")), theme.fg("border", "─".repeat(width))];
          for (const message of messages) {
            const time = new Date(message.sentAt).toLocaleTimeString();
            const state = message.status === "delivered"
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
            const sender = message.senderId
              ? `${message.sender} (${message.senderId})`
              : message.sender;
            lines.push(truncateToWidth(`${state} ${time} ${sender} → ${message.targetTitle} (${message.targetId})`, width));
            lines.push(truncateToWidth(`  ${message.message}`, width));
            if (message.error) lines.push(truncateToWidth(theme.fg("error", `  ${message.error}`), width));
          }
          lines.push(theme.fg("border", "─".repeat(width)));
          lines.push(truncateToWidth(theme.fg("dim", "Enter/Esc close"), width));
          return lines;
        },
        invalidate() {},
        dispose() {
          if (!closed) unsubscribe();
          closed = true;
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
  );
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

export class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;

  private closed = false;
  private abortArmed?: string;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    // Elapsed times, token counts, and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    return this.view.list();
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    return true;
  }

  private close(result: string | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.abortArmed) {
        this.abortArmed = undefined;
        this.tui.requestRender();
        return;
      }
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + subs.length) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.abortArmed = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.abortArmed = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = subs[this.selection.index];
      if (!snap || snap.status !== "running") return;
      if (this.abortArmed === snap.id) {
        this.abortArmed = undefined;
        this.view.requestAbort(snap.id);
      } else {
        this.abortArmed = snap.id;
      }
      this.tui.requestRender();
      return;
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(7, rows - 6);
    const innerWidth = Math.max(1, width - 2);
    const running = subs.filter((snap) => snap.status === "running").length;
    const done = subs.filter((snap) => snap.status === "done").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const selected = subs[this.selection.index];

    const headerLeft = theme.fg("accent", theme.bold("Subagent operations"));
    const counts = [
      running > 0 ? stateLabel(theme, "warning", `${running} running`) : "",
      done > 0 ? stateLabel(theme, "success", `${done} done`) : "",
      failed > 0 ? stateLabel(theme, "error", `${failed} failed`) : "",
    ].filter(Boolean).join(theme.fg("dim", " · "));
    const lines = [joinSides(`  ${headerLeft}`, `${counts || theme.fg("muted", "idle")}  `, width)];

    lines.push(
      theme.fg("border", "╭") +
        this.borderSegment(innerWidth, `${subs.length} agent${subs.length === 1 ? "" : "s"} · live control`) +
        theme.fg("border", "╮"),
    );

    const divider = theme.fg("border", "│");
    if (width >= 100 && selected) {
      const leftWidth = Math.max(38, Math.floor((innerWidth - 1) * 0.48));
      const rightWidth = Math.max(20, innerWidth - leftWidth - 1);
      const list = this.renderRows(subs, leftWidth, bodyHeight, true);
      const detail = this.renderSelected(selected, rightWidth, bodyHeight);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(
          divider +
            padLine(list[row] ?? "", leftWidth) +
            theme.fg("borderMuted", "│") +
            padLine(detail[row] ?? "", rightWidth) +
            divider,
        );
      }
    } else {
      const list = this.renderRows(subs, innerWidth, bodyHeight, false);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(divider + padLine(list[row] ?? "", innerWidth) + divider);
      }
    }

    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} take over · ${this.abortArmed ? "x again to abort · esc cancel" : "x abort (confirm)"} · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );
    return lines;
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
    compact: boolean,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];
    const viewport = viewportSlice(subs, this.selection.index, height);

    for (let row = 0; row < viewport.items.length; row++) {
      const snap = viewport.items[row];
      const index = viewport.start + row;
      const selected = index === this.selection.index;
      const marker = selected ? theme.fg("accent", "❯") : " ";
      const title = selected
        ? theme.fg("accent", oneLine(snap.title))
        : theme.fg("text", oneLine(snap.title));
      const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;
      const utilization = formatContextUtilization(snap.usage);
      const rightParts = compact
        ? [theme.fg("muted", formatElapsed(snap)), statusWord(snap, theme)]
        : [
            theme.fg("muted", snap.meta.modelLabel ?? "?"),
            ...(utilization ? [theme.fg("muted", utilization)] : []),
            theme.fg("muted", formatElapsed(snap)),
            statusWord(snap, theme),
          ];
      const line = joinSides(left, `${rightParts.join(theme.fg("dim", " · "))} `, width);
      out.push(selected ? theme.bg("selectedBg", padLine(line, width)) : line);
    }
    if (viewport.start > 0 && out.length > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ↑ ${viewport.start} more`), width);
    }
    const below = subs.length - viewport.start - viewport.items.length;
    if (below > 0 && out.length > 0) {
      out[out.length - 1] = truncateToWidth(theme.fg("dim", `   ↓ ${below} more`), width);
    }
    return out;
  }

  private renderSelected(
    snap: SubagentSnapshot,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const state = snap.status === "running" ? "warning" : snap.status === "done" ? "success" : "error";
    const percent = contextPercent(snap.usage);
    const activeTools = snap.liveTools.filter((tool) => !tool.done);
    const lines: string[] = [
      ` ${stateLabel(theme, state, snap.status === "error" ? "failed" : snap.status)} ${theme.fg("accent", theme.bold(oneLine(snap.title)))}`,
      ` ${theme.fg("dim", snap.id)} ${theme.fg("muted", `· ${formatElapsed(snap)} · ${snap.turns} turn${snap.turns === 1 ? "" : "s"}`)}`,
      "",
      ` ${theme.fg("muted", "MODEL")} ${theme.fg("text", snap.meta.modelLabel ?? "inherit")}`,
      ` ${theme.fg("muted", "PROFILE")} ${theme.fg("text", snap.meta.agentType ?? "general-purpose")}${snap.meta.persona ? theme.fg("dim", ` · ${snap.meta.persona}`) : ""}`,
      ` ${theme.fg("muted", "ACCESS")} ${theme.fg("text", snap.meta.capability ?? "all")}${snap.meta.isolation === "worktree" ? theme.fg("warning", " · worktree") : ""}`,
      ` ${theme.fg("muted", "SOURCE")} ${theme.fg("text", snap.meta.origin === "btw" ? "user aside" : "model delegation")}`,
    ];
    if (percent !== undefined) {
      lines.push("", ` ${theme.fg("muted", "CONTEXT")} ${meter(theme, percent, 100, Math.max(12, width - 12), percent >= 85 ? "warning" : "active")}`);
    }
    lines.push("");
    if (activeTools.length > 0) {
      lines.push(` ${theme.fg("muted", "NOW")} ${theme.fg("toolTitle", oneLine(activeTools[0]!.name))}${activeTools.length > 1 ? theme.fg("dim", ` +${activeTools.length - 1}`) : ""}`);
    } else if (snap.status === "running") {
      lines.push(` ${theme.fg("muted", "NOW")} ${theme.fg("warning", "thinking / responding")}`);
    } else {
      lines.push(` ${theme.fg("muted", "NOW")} ${theme.fg("dim", "settled")}`);
    }
    if (snap.queued.length > 0) {
      lines.push(` ${theme.fg("muted", "QUEUE")} ${theme.fg("warning", `${snap.queued.length} message${snap.queued.length === 1 ? "" : "s"}`)}`);
    }
    lines.push("", ` ${theme.fg("muted", "LATEST")}`);
    const latest = oneLine(latestText(snap) || snap.errorText || "No output yet.");
    const preview = wrapTextWithAnsi(latest, Math.max(10, width - 2)).slice(0, Math.max(1, height - lines.length - 3));
    lines.push(...preview.map((line) => ` ${theme.fg(snap.errorText ? "error" : "toolOutput", line)}`));
    lines.push("", truncateToWidth(` ${theme.fg("dim", snap.cwd)}`, width));
    return lines.slice(0, height);
  }

  invalidate(): void {}
}

// --- Takeover view ------------------------------------------------------------

const TRANSCRIPT_SCROLL_STEP = 6;

export class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;

  private input = new Input();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private transcriptCacheKey = "";
  private transcriptCache: string[] = [];
  private closed = false;

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
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestAbort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private transcriptLines(snap: SubagentSnapshot, width: number): string[] {
    const live = snap.liveAssistant;
    const toolVersion = snap.liveTools
      .map((tool) => `${tool.toolId}:${tool.done ? 1 : 0}:${tool.isError ? 1 : 0}:${tool.outputPreview ?? ""}`)
      .join("|");
    const key = [
      width,
      snap.transcript.length,
      live?.text.length ?? 0,
      live?.thinking.length ?? 0,
      toolVersion,
      live?.text.slice(-80) ?? "",
      live?.thinking.slice(-80) ?? "",
      snap.queued.map((message) => `${message.kind}:${message.text}`).join("|"),
      snap.status,
    ].join(":");
    if (key !== this.transcriptCacheKey) {
      this.transcriptCacheKey = key;
      this.transcriptCache = buildTranscriptLines(snap, width, this.theme);
    }
    return this.transcriptCache;
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    // Header, metadata, input, borders, and hints consume eight rows.
    return Math.max(6, rows - 9);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      lines.push(border);
      lines.push(theme.fg("dim", `${this.id} is no longer tracked`));
      lines.push(border);
      return lines;
    }

    lines.push(border);
    const utilization = formatContextUtilization(snap.usage);
    const header =
      `${statusGlyph(snap, theme)} ` +
      theme.fg("accent", theme.bold(`${snap.id} · ${snap.title}`)) +
      theme.fg("muted", ` · ${snap.status} · ${formatElapsed(snap)}`) +
      theme.fg("dim", ` · ${snap.backend}: ${snap.meta.modelLabel ?? "?"}`) +
      (utilization ? theme.fg("dim", ` · ${utilization}`) : "");
    lines.push(truncateToWidth(header, width));
    const percent = contextPercent(snap.usage);
    const activeTools = snap.liveTools.filter((tool) => !tool.done);
    const metaLeft =
      ` ${theme.fg("muted", "MODEL")} ${theme.fg("text", snap.meta.modelLabel ?? "inherit")}` +
      theme.fg("dim", ` · ${snap.meta.capability ?? "all"}${snap.meta.isolation === "worktree" ? " · worktree" : ""}`);
    const metaRight = percent === undefined
      ? activeTools.length > 0
        ? theme.fg("toolTitle", oneLine(activeTools[0]!.name))
        : ""
      : `${meter(theme, percent, 100, Math.min(24, Math.max(10, Math.floor(width / 4))), percent >= 85 ? "warning" : "active")}`;
    lines.push(joinSides(metaLeft, `${metaRight} `, width));
    lines.push(border);

    // Fixed-height transcript viewport. Error and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    const transcript = this.transcriptLines(snap, width);
    const viewport = this.viewportHeight();
    const errorRows = snap.errorText ? 1 : 0;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows - scrollRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (snap.errorText) {
      body.push(
        truncateToWidth(theme.fg("error", `error: ${snap.errorText}`), width),
      );
    }

    const capacity = Math.max(
      1,
      viewport - body.length - (this.scrollOffset > 0 ? 1 : 0),
    );
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) body.push(theme.fg("dim", "(no output yet)"));
    else body.push(...visible);

    if (this.scrollOffset > 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`),
          width,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(border);
    lines.push(...this.input.render(width));
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} abort run · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")} scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page`,
        ),
        width,
      ),
    );
    lines.push(border);
    return lines;
  }

  invalidate(): void {
    this.transcriptCacheKey = "";
    this.input.invalidate();
  }
}
