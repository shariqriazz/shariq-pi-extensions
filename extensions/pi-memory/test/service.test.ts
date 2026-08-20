import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import { selectForInjection } from "../src/retrieval.ts";
import { MemoryService } from "../src/service.ts";

test("service queues capture, persists memory, retrieves it, and writes projections", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-service-"));
  const config = defaultConfig(root);
  const service = new MemoryService(config);
  try {
    const project = service.initialize(process.cwd());
    const entries = [
      { type: "message", id: "u1", message: { role: "user", content: "Use exact runtime pins." } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "I will preserve exact pins." }] } },
    ];
    const context = {
      sessionManager: {
        getBranch: () => entries,
        getSessionId: () => "service-session",
        getSessionFile: () => "/tmp/service-session.jsonl",
      },
    };
    assert.equal(service.enqueueCurrentSession(context as never, project), true);
    assert.ok(service.database.claimNextJob("test-owner", 60_000, 4));

    const memory = service.save({
      scope: "project",
      project,
      kind: "convention",
      title: "Use exact runtime pins",
      content: "Use exact runtime pins in project configuration.",
      tags: ["runtime"],
    });
    assert.equal(service.search("runtime pins", project.id, 10)[0]?.memoryId, memory.memoryId);
    assert.equal(selectForInjection(service.database, "runtime configuration", project.id, { maxResults: 5, maxCharacters: 2_000 })[0]?.memoryId, memory.memoryId);
    assert.equal(fs.existsSync(path.join(root, "projects", project.directoryName, "MEMORY.md")), true);
  } finally {
    await service.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
