import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type SemanticState =
  | "active"
  | "success"
  | "warning"
  | "error"
  | "muted";

const STATE_COLORS = {
  active: "accent",
  success: "success",
  warning: "warning",
  error: "error",
  muted: "muted",
} as const;

export function stateDot(theme: Theme, state: SemanticState): string {
  return theme.fg(STATE_COLORS[state], "●");
}

export function stateLabel(
  theme: Theme,
  state: SemanticState,
  label: string,
): string {
  return `${stateDot(theme, state)} ${theme.fg(STATE_COLORS[state], label)}`;
}

export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function oneLine(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

export function padLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const truncated = truncateToWidth(text, safeWidth, "");
  return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
}

export function joinSides(left: string, right: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= safeWidth) return truncateToWidth(right, safeWidth);
  const leftWidth = Math.max(0, safeWidth - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth, "…");
  return truncateToWidth(
    fittedLeft + " ".repeat(Math.max(1, safeWidth - visibleWidth(fittedLeft) - rightWidth)) + right,
    safeWidth,
  );
}

export function rule(theme: Theme, width: number, accent = false): string {
  return theme.fg(accent ? "borderAccent" : "border", "─".repeat(Math.max(0, width)));
}

export function framedRow(
  theme: Theme,
  content: string,
  width: number,
  selected = false,
): string {
  const innerWidth = Math.max(0, width - 2);
  const body = padLine(content, innerWidth);
  const row = `${theme.fg(selected ? "borderAccent" : "border", "│")}${body}${theme.fg(selected ? "borderAccent" : "border", "│")}`;
  return selected ? theme.bg("selectedBg", row) : row;
}

export function frameTop(theme: Theme, width: number, title = ""): string {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${oneLine(title)} ` : "";
  const fitted = truncateToWidth(label, Math.max(0, inner - 1), "…");
  return (
    theme.fg("border", "╭") +
    (fitted ? theme.fg("muted", fitted) : "") +
    theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(fitted)))) +
    theme.fg("border", "╮")
  );
}

export function frameBottom(theme: Theme, width: number): string {
  return (
    theme.fg("border", "╰") +
    theme.fg("border", "─".repeat(Math.max(0, width - 2))) +
    theme.fg("border", "╯")
  );
}

export function meter(
  theme: Theme,
  value: number,
  total: number,
  width: number,
  state: SemanticState = "active",
): string {
  const safeWidth = Math.max(3, width);
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const percent = Math.round(ratio * 100);
  const percentText = `${percent}%`;
  const barWidth = Math.max(1, safeWidth - percentText.length - 1);
  const filled = Math.min(barWidth, Math.round(barWidth * ratio));
  const bar =
    theme.fg(STATE_COLORS[state], "━".repeat(filled)) +
    theme.fg("borderMuted", "─".repeat(Math.max(0, barWidth - filled)));
  return `${bar} ${theme.fg("muted", percentText)}`;
}

export function formatDurationMs(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  return `${remainder}s`;
}

export function viewportSlice<T>(
  items: ReadonlyArray<T>,
  selectedIndex: number,
  height: number,
): { start: number; items: ReadonlyArray<T> } {
  const safeHeight = Math.max(0, height);
  if (items.length <= safeHeight) return { start: 0, items };
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(safeHeight / 2)),
    Math.max(0, items.length - safeHeight),
  );
  return { start, items: items.slice(start, start + safeHeight) };
}
