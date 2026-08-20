import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyAgentWorktree, createAgentWorktree, discardAgentWorktree, integrateAgentWorktree } from "./src/worktree.ts";

const runFile = promisify(execFile);
const exec = async (command: string, args: string[]) => {
  try {
    const result = await runFile(command, args, { encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? 1, killed: false };
  }
};

test("isolated worktree changes are preflighted and applied to the source repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-subagent-worktree-test-"));
  let worktree: Awaited<ReturnType<typeof createAgentWorktree>> | undefined;
  try {
    await exec("git", ["-C", repo, "init", "-q"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", repo, "config", "user.name", "Pi Test"]);
    writeFileSync(join(repo, "file.txt"), "before\n");
    await exec("git", ["-C", repo, "add", "file.txt"]);
    await exec("git", ["-C", repo, "commit", "-qm", "initial"]);

    worktree = await createAgentWorktree(exec, repo, "worktree-test");
    writeFileSync(join(worktree.path, "file.txt"), "after\n");
    writeFileSync(join(worktree.path, "new.txt"), "new\n");
    const result = await applyAgentWorktree(exec, worktree);
    assert.deepEqual(result, { action: "patch", changed: true, files: ["file.txt", "new.txt"] });
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "after\n");
    assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "new\n");
  } finally {
    if (worktree) await discardAgentWorktree(exec, worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commit-aware integration reports conflicts before changing the source checkout", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-subagent-conflict-test-"));
  let worktree: Awaited<ReturnType<typeof createAgentWorktree>> | undefined;
  try {
    await exec("git", ["-C", repo, "init", "-q"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", repo, "config", "user.name", "Pi Test"]);
    writeFileSync(join(repo, "file.txt"), "base\n");
    await exec("git", ["-C", repo, "add", "file.txt"]);
    await exec("git", ["-C", repo, "commit", "-qm", "initial"]);

    worktree = await createAgentWorktree(exec, repo, "conflict-test");
    writeFileSync(join(worktree.path, "file.txt"), "child\n");
    writeFileSync(join(repo, "file.txt"), "parent\n");
    await exec("git", ["-C", repo, "add", "file.txt"]);
    await exec("git", ["-C", repo, "commit", "-qm", "parent change"]);
    const before = await exec("git", ["-C", repo, "rev-parse", "HEAD"]);

    await assert.rejects(
      integrateAgentWorktree(exec, worktree, "cherry-pick", "conflict-test"),
      /source repository was not changed/,
    );
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "parent\n");
    const after = await exec("git", ["-C", repo, "rev-parse", "HEAD"]);
    assert.equal(after.stdout, before.stdout);
  } finally {
    if (worktree) await discardAgentWorktree(exec, worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commit-aware cherry-pick is preflighted and preserves the child commit", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-subagent-cherry-test-"));
  let worktree: Awaited<ReturnType<typeof createAgentWorktree>> | undefined;
  try {
    await exec("git", ["-C", repo, "init", "-q"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", repo, "config", "user.name", "Pi Test"]);
    writeFileSync(join(repo, "file.txt"), "before\n");
    await exec("git", ["-C", repo, "add", "file.txt"]);
    await exec("git", ["-C", repo, "commit", "-qm", "initial"]);

    worktree = await createAgentWorktree(exec, repo, "cherry-test");
    writeFileSync(join(worktree.path, "file.txt"), "cherry\n");
    const result = await integrateAgentWorktree(exec, worktree, "cherry-pick", "cherry-test");
    assert.equal(result.action, "cherry-pick");
    assert.equal(result.changed, true);
    assert.equal(result.commits.length, 1);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "cherry\n");
    const log = await exec("git", ["-C", repo, "log", "-1", "--pretty=%s"]);
    assert.match(log.stdout, /Apply cherry-test subagent changes/);
  } finally {
    if (worktree) await discardAgentWorktree(exec, worktree);
    rmSync(repo, { recursive: true, force: true });
  }
});
