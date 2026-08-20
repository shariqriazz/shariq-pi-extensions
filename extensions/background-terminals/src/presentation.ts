import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatDurationMs, oneLine, sanitizeTerminalText } from "../../shared/tui-dashboard.ts";
import type { TerminalReadResult, TerminalSnapshot } from "./types.ts";
import { terminalElapsedMs } from "./types.ts";

export const MODEL_OUTPUT_MAX_BYTES = 24 * 1024;
export const MODEL_OUTPUT_MAX_LINES = 500;
export const COMPLETION_OUTPUT_MAX_BYTES = 12 * 1024;
export const COMPLETION_OUTPUT_MAX_LINES = 120;

export function formatTerminal(snapshot: TerminalSnapshot): string {
  const outcome = snapshot.status === "running"
    ? "running"
    : snapshot.status === "killed"
      ? "killed"
      : `exit ${snapshot.exitCode ?? "?"}`;
  return `${snapshot.id} [${snapshot.status}] "${oneLine(snapshot.title)}" (pid ${snapshot.pid}, ${formatDurationMs(terminalElapsedMs(snapshot))}, ${outcome}, output ${formatSize(snapshot.output.totalBytes)}, ${snapshot.cwd})`;
}

function boundedOutput(
  text: string,
  maxBytes: number,
  maxLines: number,
): { text: string; truncated: boolean } {
  const clean = sanitizeTerminalText(text).replaceAll("\r", "");
  const truncation = truncateTail(clean, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(maxLines, DEFAULT_MAX_LINES),
  });
  return { text: truncation.content, truncated: truncation.truncated };
}

export function formatReadResult(result: TerminalReadResult): string {
  const { snapshot } = result;
  let text = formatTerminal(snapshot);
  if (snapshot.errorText) text += `\nError: ${snapshot.errorText}`;
  if (snapshot.output.spillTruncated) text += "\nNotice: the private output log reached its size limit.";
  const bounded = boundedOutput(result.text, MODEL_OUTPUT_MAX_BYTES, MODEL_OUTPUT_MAX_LINES);
  text += `\nCursor: ${result.cursor}`;
  if (result.omittedBytes > 0) {
    text += `\n[${formatSize(result.omittedBytes)} omitted before the retained output window]`;
  }
  text += `\n\n${bounded.text || "(no new output)"}`;
  if (bounded.truncated) {
    text += `\n\n[Output tail-truncated for model context. Private log: ${snapshot.output.spillPath ?? "unavailable"}]`;
  }
  return text;
}

export function formatCompletion(snapshot: TerminalSnapshot): string {
  const result = snapshot.status === "killed"
    ? "was stopped"
    : snapshot.exitCode === 0
      ? "completed successfully"
      : `failed with exit ${snapshot.exitCode ?? "?"}`;
  let text = `Background terminal ${snapshot.id} "${oneLine(snapshot.title)}" ${result} after ${formatDurationMs(terminalElapsedMs(snapshot))}.`;
  if (snapshot.errorText) text += `\nError: ${snapshot.errorText}`;
  if (snapshot.output.spillTruncated) text += "\nNotice: the private output log reached its size limit.";
  const bounded = boundedOutput(
    snapshot.output.text,
    COMPLETION_OUTPUT_MAX_BYTES,
    COMPLETION_OUTPUT_MAX_LINES,
  );
  text += `\n\n${bounded.text || "(no output)"}`;
  if (bounded.truncated || snapshot.output.truncatedBytes > 0) {
    text += `\n\n[Final output tail-truncated. Private log: ${snapshot.output.spillPath ?? "unavailable"}]`;
  }
  return text;
}
