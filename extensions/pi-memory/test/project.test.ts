import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isEphemeralProject, resolveProject } from "../src/project.ts";

test("preserves Git root paths ending in whitespace", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-memory-space-project-"));
  const directory = join(parent, "repo ");
  try {
    mkdirSync(directory);
    execFileSync("git", ["-C", directory, "init", "-q"]);
    assert.equal(resolveProject(directory).rootPath, realpathSync.native(directory));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recognizes projects under the operating system temporary directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-project-"));
  try {
    assert.equal(isEphemeralProject(resolveProject(directory)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
