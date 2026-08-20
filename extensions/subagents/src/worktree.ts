import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  baseCwd: string;
  repoRoot: string;
  path: string;
  branch: string;
  /** Commit from which the isolated branch was created. Optional for v1 records. */
  baseCommit?: string;
}

export const WORKTREE_ACTIONS = ["inspect", "patch", "cherry-pick", "merge", "discard"] as const;
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

type Exec = ExtensionAPI["exec"];

function commandError(command: string, result: { code: number | null; stderr: string; stdout: string }) {
  const detail = (result.stderr || result.stdout).trim();
  return new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
}

async function checked(exec: Exec, command: string, args: string[]) {
  const result = await exec(command, args);
  if (result.code !== 0) throw commandError(`${command} ${args.join(" ")}`, result);
  return result.stdout.trim();
}

export async function createAgentWorktree(exec: Exec, cwd: string, label: string): Promise<WorktreeInfo> {
  const repoRoot = await checked(exec, "git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const sourceStatus = await checked(exec, "git", ["-C", repoRoot, "status", "--porcelain", "--untracked-files=all"]);
  if (sourceStatus) {
    throw new Error(
      "Worktree isolation requires a clean source checkout because isolated branches start from HEAD and cannot safely inherit uncommitted changes. Commit or stash the changes, or use the shared workspace.",
    );
  }
  const baseCommit = await checked(exec, "git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  const repoHash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = path.join(getAgentDir(), "subagent-worktrees", repoHash, `${slug}-${suffix}`);
  const branch = `pi-subagent/${slug}-${suffix}`;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const result = await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, baseCommit]);
  if (result.code !== 0) throw commandError("git worktree add", result);
  return { baseCwd: cwd, repoRoot, path: worktreePath, branch, baseCommit };
}

export async function discardAgentWorktree(exec: Exec, info: WorktreeInfo) {
  const remove = await exec("git", ["-C", info.repoRoot, "worktree", "remove", "--force", info.path]);
  if (remove.code !== 0) throw commandError("git worktree remove", remove);
  const branch = await exec("git", ["-C", info.repoRoot, "branch", "-D", info.branch]);
  if (branch.code !== 0) throw commandError("git branch -D", branch);
}

export async function inspectAgentWorktree(exec: Exec, info: WorktreeInfo) {
  const baseCommit = info.baseCommit ?? await checked(exec, "git", ["-C", info.repoRoot, "merge-base", "HEAD", info.branch]);
  const status = await checked(exec, "git", ["-C", info.path, "status", "--porcelain"]);
  const names = await checked(exec, "git", ["-C", info.path, "diff", "--name-only", baseCommit]);
  const untracked = status.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
  const commitsText = await checked(exec, "git", ["-C", info.repoRoot, "rev-list", "--reverse", `${baseCommit}..${info.branch}`]);
  return {
    baseCommit,
    dirty: !!status,
    files: [...new Set([...names.split(/\r?\n/).filter(Boolean), ...untracked])],
    commits: commitsText.split(/\r?\n/).filter(Boolean),
  };
}

export async function applyAgentWorktree(exec: Exec, info: WorktreeInfo) {
  const mark = await exec("git", ["-C", info.path, "add", "-N", "--", "."]);
  if (mark.code !== 0) throw commandError("git add -N", mark);
  const baseCommit = info.baseCommit ?? await checked(exec, "git", ["-C", info.repoRoot, "merge-base", "HEAD", info.branch]);
  const diff = await exec("git", ["-C", info.path, "diff", "--binary", baseCommit]);
  if (diff.code !== 0) throw commandError("git diff", diff);
  if (!diff.stdout.trim()) return { action: "patch" as const, changed: false, files: [] as string[] };

  const names = await checked(exec, "git", ["-C", info.path, "diff", "--name-only", baseCommit]);
  const patchPath = path.join(getAgentDir(), "subagent-worktrees", `.apply-${randomUUID()}.patch`);
  fs.writeFileSync(patchPath, diff.stdout, { mode: 0o600 });
  try {
    const check = await exec("git", ["-C", info.repoRoot, "apply", "--check", "--whitespace=nowarn", patchPath]);
    if (check.code !== 0) throw commandError("git apply --check", check);
    const apply = await exec("git", ["-C", info.repoRoot, "apply", "--whitespace=nowarn", patchPath]);
    if (apply.code !== 0) throw commandError("git apply", apply);
  } finally {
    fs.rmSync(patchPath, { force: true });
  }
  return { action: "patch" as const, changed: true, files: names.split(/\r?\n/).filter(Boolean) };
}

async function commitDirtyWorktree(exec: Exec, info: WorktreeInfo, label: string) {
  const status = await checked(exec, "git", ["-C", info.path, "status", "--porcelain"]);
  if (!status) return;
  await checked(exec, "git", ["-C", info.path, "add", "-A", "--", "."]);
  await checked(exec, "git", [
    "-C", info.path,
    "-c", "user.name=Pi Subagent",
    "-c", "user.email=pi-subagent@localhost",
    "commit", "-m", `Apply ${label} subagent changes`,
  ]);
}

async function ensureCleanSource(exec: Exec, info: WorktreeInfo) {
  const status = await checked(exec, "git", ["-C", info.repoRoot, "status", "--porcelain"]);
  if (status) {
    throw new Error("The source repository must be clean for cherry-pick or merge. Use action=patch to preserve unrelated working-tree changes.");
  }
}

async function integrationArgs(
  exec: Exec,
  info: WorktreeInfo,
  action: "cherry-pick" | "merge",
) {
  const inspected = await inspectAgentWorktree(exec, info);
  if (inspected.commits.length === 0) return { inspected, args: [] as string[] };
  if (action === "merge") return { inspected, args: ["merge", "--no-ff", "--no-edit", info.branch] };
  return { inspected, args: ["cherry-pick", ...inspected.commits] };
}

/** Preflight commit-aware integration in a temporary worktree before touching the source checkout. */
export async function integrateAgentWorktree(
  exec: Exec,
  info: WorktreeInfo,
  action: "cherry-pick" | "merge",
  label: string,
) {
  await ensureCleanSource(exec, info);
  await commitDirtyWorktree(exec, info, label);
  const { inspected, args } = await integrationArgs(exec, info, action);
  if (args.length === 0) {
    return { action, changed: false, files: inspected.files, commits: [] as string[] };
  }

  const preflightPath = path.join(getAgentDir(), "subagent-worktrees", `.preflight-${randomUUID()}`);
  fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
  await checked(exec, "git", ["-C", info.repoRoot, "worktree", "add", "--detach", preflightPath, "HEAD"]);
  try {
    const preflight = await exec("git", [
      "-C", preflightPath,
      "-c", "user.name=Pi Subagent",
      "-c", "user.email=pi-subagent@localhost",
      ...args,
    ]);
    if (preflight.code !== 0) {
      throw new Error(`Preflight found ${action} conflicts; the source repository was not changed. ${(preflight.stderr || preflight.stdout).trim()}`);
    }
  } finally {
    await exec("git", ["-C", info.repoRoot, "worktree", "remove", "--force", preflightPath]);
  }

  const applied = await exec("git", [
    "-C", info.repoRoot,
    "-c", "user.name=Pi Subagent",
    "-c", "user.email=pi-subagent@localhost",
    ...args,
  ]);
  if (applied.code !== 0) {
    await exec("git", ["-C", info.repoRoot, action === "merge" ? "merge" : "cherry-pick", "--abort"]);
    throw commandError(`git ${action}`, applied);
  }
  return { action, changed: true, files: inspected.files, commits: inspected.commits };
}
