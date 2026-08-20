import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isEphemeralProject, resolveProject } from "../src/project.ts";

test("recognizes projects under the operating system temporary directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-project-"));
  try {
    assert.equal(isEphemeralProject(resolveProject(directory)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
