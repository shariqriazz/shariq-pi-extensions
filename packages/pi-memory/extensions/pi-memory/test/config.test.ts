import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, loadMemoryModelConfig, saveMemoryModelConfig } from "../src/config.ts";

test("defaults to OpenAI Codex Luna at max reasoning and persists user selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-config-"));
  try {
    assert.deepEqual(defaultConfig(root).extractionModel, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "max",
    });

    saveMemoryModelConfig(root, {
      provider: "factory",
      model: "gpt-5.6-luna",
      reasoning: "high",
    });
    assert.deepEqual(loadMemoryModelConfig(root), {
      provider: "factory",
      model: "gpt-5.6-luna",
      reasoning: "high",
    });
    assert.equal(fs.statSync(path.join(root, "config.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
