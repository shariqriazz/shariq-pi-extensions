import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../../shared/tui-dashboard.ts";

export interface GitSummary {
  isRepository: boolean;
  root?: string;
  branch?: string;
  changedFiles: number;
  pullRequest?: { number: number; url: string; draft: boolean };
}

export interface ChangedFile {
  path: string;
  name: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  diff: string[];
}

interface ChangedPath {
  path: string;
  status: string;
}

const GIT_TIMEOUT_MS = 5_000;
const GH_TIMEOUT_MS = 10_000;
const MAX_CHANGED_FILES = 250;
const MAX_DIFF_LINES = 20_000;

function stripFinalLineBreak(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function safePath(value: string): string {
  return sanitizeTerminalText(value).replace(/[\r\n\t]/g, " ");
}

export function parseChangedPaths(output: string): ChangedPath[] {
  const records = output.split("\0");
  const paths: ChangedPath[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    paths.push({ status, path });
    if (status.includes("R") || status.includes("C")) index++;
  }
  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

export function parseNumstat(output: string): {
  additions: number | null;
  deletions: number | null;
} {
  const line = output.split("\n").find(Boolean);
  if (!line) return { additions: 0, deletions: 0 };
  const [added, deleted] = line.split("\t");
  return {
    additions: added === "-" ? null : Number.parseInt(added ?? "0", 10) || 0,
    deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "0", 10) || 0,
  };
}

export async function loadGitSummary(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<GitSummary> {
  const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    signal,
    timeout: GIT_TIMEOUT_MS,
  });
  if (root.code !== 0) return { isRepository: false, changedFiles: 0 };
  const repoRoot = stripFinalLineBreak(root.stdout);
  const [branch, head, status] = await Promise.all([
    pi.exec("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      signal,
      timeout: GIT_TIMEOUT_MS,
    }),
  ]);
  const branchName = branch.stdout.trim();
  const shortHead = head.stdout.trim();
  return {
    isRepository: true,
    root: repoRoot,
    branch: safePath(branchName || (shortHead ? `detached@${shortHead}` : "detached")),
    changedFiles: status.code === 0 ? parseChangedPaths(status.stdout).length : 0,
  };
}

export async function loadPullRequest(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<GitSummary["pullRequest"]> {
  const result = await pi.exec(
    "gh",
    ["pr", "view", "--json", "number,url,state,isDraft"],
    { cwd, signal, timeout: GH_TIMEOUT_MS },
  );
  if (result.code !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.number !== "number" ||
      typeof record.url !== "string" ||
      record.state !== "OPEN"
    ) {
      return undefined;
    }
    return {
      number: record.number,
      url: record.url,
      draft: record.isDraft === true,
    };
  } catch {
    return undefined;
  }
}

async function loadFile(
  pi: ExtensionAPI,
  repoRoot: string,
  changed: ChangedPath,
  hasHead: boolean,
  signal?: AbortSignal,
): Promise<ChangedFile> {
  const untracked = changed.status === "??" || !hasHead;
  const diffArgs = untracked
    ? ["diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--", "/dev/null", changed.path]
    : ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", changed.path];
  const statArgs = untracked
    ? ["diff", "--no-index", "--numstat", "--", "/dev/null", changed.path]
    : ["diff", "--numstat", "HEAD", "--", changed.path];
  const [diff, stat] = await Promise.all([
    pi.exec("git", diffArgs, { cwd: repoRoot, signal, timeout: GH_TIMEOUT_MS }),
    pi.exec("git", statArgs, { cwd: repoRoot, signal, timeout: GH_TIMEOUT_MS }),
  ]);
  const allLines = diff.stdout
    .trimEnd()
    .split("\n")
    .map(sanitizeTerminalText);
  const lines = allLines.length > MAX_DIFF_LINES
    ? [...allLines.slice(0, MAX_DIFF_LINES), `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`]
    : allLines;
  const stats = parseNumstat(stat.stdout);
  const path = safePath(changed.path);
  return {
    ...stats,
    path,
    name: path.split("/").at(-1) || path,
    status: sanitizeTerminalText(changed.status),
    diff: lines.length === 1 && lines[0] === "" ? ["No textual diff available."] : lines,
  };
}

export async function loadChangedFiles(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; files: ChangedFile[]; omitted: number } | null> {
  const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    signal,
    timeout: GIT_TIMEOUT_MS,
  });
  if (root.code !== 0) return null;
  const repoRoot = stripFinalLineBreak(root.stdout);
  const [status, head] = await Promise.all([
    pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      signal,
      timeout: GIT_TIMEOUT_MS,
    }),
  ]);
  if (status.code !== 0) return null;
  const changed = parseChangedPaths(status.stdout);
  const selected = changed.slice(0, MAX_CHANGED_FILES);
  const files: ChangedFile[] = [];
  for (const entry of selected) {
    signal?.throwIfAborted();
    files.push(await loadFile(pi, repoRoot, entry, head.code === 0, signal));
  }
  return { root: repoRoot, files, omitted: changed.length - selected.length };
}
