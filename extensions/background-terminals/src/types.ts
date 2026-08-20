export type TerminalStatus = "running" | "done" | "failed" | "killed";

export interface TerminalOutputView {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncatedBytes: number;
  readonly cursor: number;
  readonly version: number;
  readonly spillPath?: string;
  readonly spillTruncated: boolean;
}

export interface TerminalSnapshot {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly pid: number;
  readonly status: TerminalStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly exitCode?: number;
  readonly signal?: number;
  readonly errorText?: string;
  readonly output: TerminalOutputView;
  readonly cols: number;
  readonly rows: number;
}

export interface StartTerminalOptions {
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface TerminalReadResult {
  readonly snapshot: TerminalSnapshot;
  readonly text: string;
  readonly cursor: number;
  readonly omittedBytes: number;
}

export function terminalElapsedMs(snapshot: TerminalSnapshot): number {
  return Math.max(0, (snapshot.settledAt ?? Date.now()) - snapshot.createdAt);
}
