import { oneLine, stateLabel } from "./tui-dashboard.ts";

export type ToolCardState = "active" | "success" | "warning" | "error" | "muted";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type ToolResultLike = {
  content?: Array<{ type?: string; text?: string }>;
};

export function toolCallCard(
  theme: ThemeLike,
  label: string,
  title: string,
  detail?: string,
) {
  return `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", oneLine(title))}${detail ? `\n${theme.fg("dim", oneLine(detail))}` : ""}`;
}

export function toolResultCard(
  result: ToolResultLike,
  expanded: boolean,
  theme: ThemeLike,
  state: ToolCardState,
  label: string,
  summary: string,
) {
  const header = `${stateLabel(theme as never, state, label)} ${theme.fg("muted", oneLine(summary))}`;
  if (!expanded) return `${header}\n${theme.fg("dim", "ctrl+o to expand")}`;
  const body = result.content
    ?.filter((item) => item.type === "text" && item.text)
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  return body ? `${header}\n${theme.fg("toolOutput", body)}` : header;
}
