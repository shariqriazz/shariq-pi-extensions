import type {
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  frameBottom,
  frameTop,
  joinSides,
  oneLine,
  padLine,
  stateLabel,
  viewportSlice,
} from "../../shared/tui-dashboard.ts";
import type { ChangedFile } from "./git.ts";

function statusState(status: string): "success" | "warning" | "error" {
  if (status === "??" || status.includes("A")) return "success";
  if (status.includes("D")) return "error";
  return "warning";
}

function statText(file: ChangedFile): string {
  if (file.additions === null || file.deletions === null) return "binary";
  return `+${file.additions} -${file.deletions}`;
}

function styleDiff(theme: Theme, line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ")) {
    return theme.fg("accent", theme.bold(line));
  }
  if (line.startsWith("@@")) return theme.fg("mdHeading", line);
  if (line.startsWith("---") || line.startsWith("+++")) return theme.fg("muted", line);
  if (line.startsWith("+")) return theme.fg("success", line);
  if (line.startsWith("-")) return theme.fg("error", line);
  if (line.startsWith("…")) return theme.fg("warning", line);
  return theme.fg("text", line);
}

function combine(left: string, right: string, width: number): string {
  return truncateToWidth(`${left}${right}`, width, "");
}

export class GitChangesView {
  private selected = 0;
  private focus: "files" | "diff" = "files";
  private diffOffset = 0;
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedLines?: string[];
  private readonly files: ReadonlyArray<ChangedFile>;
  private readonly root: string;
  private readonly omitted: number;
  private readonly theme: Theme;
  private readonly rows: () => number;
  private readonly requestRender: () => void;
  private readonly close: () => void;

  constructor(
    files: ReadonlyArray<ChangedFile>,
    root: string,
    omitted: number,
    theme: Theme,
    rows: () => number,
    requestRender: () => void,
    close: () => void,
  ) {
    this.files = files;
    this.root = root;
    this.omitted = omitted;
    this.theme = theme;
    this.rows = rows;
    this.requestRender = requestRender;
    this.close = close;
  }

  private current(): ChangedFile {
    return this.files[this.selected]!;
  }

  private invalidateRender(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
    this.requestRender();
  }

  private moveFile(amount: number): void {
    this.selected = (this.selected + amount + this.files.length) % this.files.length;
    this.diffOffset = 0;
    this.invalidateRender();
  }

  private moveDiff(amount: number): void {
    const bodyHeight = Math.max(1, this.rows() - 8);
    const max = Math.max(0, this.current().diff.length - bodyHeight);
    this.diffOffset = Math.max(0, Math.min(max, this.diffOffset + amount));
    this.invalidateRender();
  }

  handleInput(data: string): void {
    if (this.focus === "files") {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.close();
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") this.moveFile(1);
      else if (matchesKey(data, Key.up) || data === "k") this.moveFile(-1);
      else if (matchesKey(data, Key.home) || data === "g") {
        this.selected = 0;
        this.diffOffset = 0;
        this.invalidateRender();
      } else if (matchesKey(data, Key.end) || data === "G") {
        this.selected = this.files.length - 1;
        this.diffOffset = 0;
        this.invalidateRender();
      } else if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.tab) ||
        matchesKey(data, Key.right) ||
        data === "l"
      ) {
        this.focus = "diff";
        this.invalidateRender();
      }
      return;
    }

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.left) ||
      data === "h"
    ) {
      this.focus = "files";
      this.invalidateRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") this.moveDiff(4);
    else if (matchesKey(data, Key.up) || data === "k") this.moveDiff(-4);
    else if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
      this.moveDiff(Math.max(1, Math.floor((this.rows() - 8) / 2)));
    } else if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
      this.moveDiff(-Math.max(1, Math.floor((this.rows() - 8) / 2)));
    } else if (matchesKey(data, Key.home) || data === "g") {
      this.diffOffset = 0;
      this.invalidateRender();
    } else if (matchesKey(data, Key.end) || data === "G") {
      this.diffOffset = Math.max(0, this.current().diff.length - Math.max(1, this.rows() - 8));
      this.invalidateRender();
    } else if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
    }
  }

  private renderList(width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const viewport = viewportSlice(this.files, this.selected, height);
    const lines: string[] = [];
    for (let row = 0; row < height; row++) {
      const file = viewport.items[row];
      if (!file) {
        lines.push(`${this.theme.fg("border", "│")}${padLine("", inner)}${this.theme.fg("border", "│")}`);
        continue;
      }
      const index = viewport.start + row;
      const selected = index === this.selected;
      const prefix = selected ? "❯" : " ";
      const left = `${prefix} ${file.status.padEnd(2)} ${oneLine(file.path)}`;
      const rowText = joinSides(left, statText(file), inner);
      const styled = selected
        ? this.theme.bg("selectedBg", this.theme.fg("accent", rowText))
        : this.theme.fg(statusState(file.status), rowText);
      lines.push(`${this.theme.fg(selected ? "borderAccent" : "border", "│")}${padLine(styled, inner)}${this.theme.fg(selected ? "borderAccent" : "border", "│")}`);
    }
    return lines;
  }

  private renderDiff(width: number, height: number): string[] {
    const file = this.current();
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    const max = Math.max(0, file.diff.length - height);
    this.diffOffset = Math.min(this.diffOffset, max);
    for (let row = 0; row < height; row++) {
      const source = file.diff[this.diffOffset + row];
      const content = source === undefined ? "" : styleDiff(this.theme, source.replaceAll("\t", "    "));
      lines.push(`${this.theme.fg(this.focus === "diff" ? "borderAccent" : "border", "│")}${padLine(content, inner)}${this.theme.fg(this.focus === "diff" ? "borderAccent" : "border", "│")}`);
    }
    return lines;
  }

  render(width: number): string[] {
    const terminalRows = this.rows();
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedHeight === terminalRows
    ) {
      return this.cachedLines;
    }
    const safeWidth = Math.max(1, width);
    const bodyHeight = Math.max(4, terminalRows - 7);
    const current = this.current();
    const totals = this.files.reduce(
      (sum, file) => ({
        additions: sum.additions + (file.additions ?? 0),
        deletions: sum.deletions + (file.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    );
    const loaded = this.omitted > 0
      ? `${this.files.length} shown · ${this.omitted} omitted`
      : `${this.files.length} changed`;
    const header = joinSides(
      `  ${this.theme.bold("Git changes")} ${this.theme.fg("muted", oneLine(this.root))}`,
      `${stateLabel(this.theme, "success", `+${totals.additions}`)}  ${stateLabel(this.theme, "error", `-${totals.deletions}`)}`,
      safeWidth,
    );
    const lines = [header];

    if (safeWidth >= 88) {
      const leftWidth = Math.max(34, Math.floor(safeWidth * 0.4));
      const rightWidth = safeWidth - leftWidth;
      const listTitle = `${loaded}${this.focus === "files" ? " · active" : ""}`;
      const diffTitle = `${oneLine(current.path)} · ${statText(current)}${this.focus === "diff" ? " · active" : ""}`;
      lines.push(combine(frameTop(this.theme, leftWidth, listTitle), frameTop(this.theme, rightWidth, diffTitle), safeWidth));
      const list = this.renderList(leftWidth, bodyHeight);
      const diff = this.renderDiff(rightWidth, bodyHeight);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(combine(list[row]!, diff[row]!, safeWidth));
      }
      lines.push(combine(frameBottom(this.theme, leftWidth), frameBottom(this.theme, rightWidth), safeWidth));
    } else if (this.focus === "files") {
      lines.push(frameTop(this.theme, safeWidth, loaded));
      lines.push(...this.renderList(safeWidth, bodyHeight));
      lines.push(frameBottom(this.theme, safeWidth));
    } else {
      lines.push(frameTop(this.theme, safeWidth, `${oneLine(current.path)} · ${statText(current)}`));
      lines.push(...this.renderDiff(safeWidth, bodyHeight));
      lines.push(frameBottom(this.theme, safeWidth));
    }

    const hint = this.focus === "files"
      ? "  up/down/jk select · enter/tab inspect · g/G first/last · escape close"
      : "  up/down/jk scroll · ctrl+u/d page · tab/h files · ctrl+c close";
    lines.push(padLine(this.theme.fg("dim", hint), safeWidth));
    this.cachedWidth = width;
    this.cachedHeight = terminalRows;
    this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth, ""));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }
}

export async function openGitChanges(
  ctx: ExtensionContext,
  root: string,
  files: ReadonlyArray<ChangedFile>,
  omitted: number,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new GitChangesView(
        files,
        root,
        omitted,
        theme,
        () => tui.terminal.rows || 30,
        () => tui.requestRender(),
        () => done(undefined),
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        minWidth: 40,
      },
    },
  );
}
