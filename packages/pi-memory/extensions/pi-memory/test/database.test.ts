import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/database.ts";
import type { MemoryCandidate, ProjectIdentity } from "../src/types.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-db-"));
  const database = new MemoryDatabase(path.join(root, "memory.sqlite"));
  const project: ProjectIdentity = {
    id: "project-a", identity: "git:github.com/example/a", rootPath: "/example/a",
    displayName: "a", directoryName: "a-project-a",
  };
  database.upsertProject(project);
  return { root, database, project };
}

function candidate(overrides: Partial<Omit<MemoryCandidate, "operation" | "targetId"> > = {}): Omit<MemoryCandidate, "operation" | "targetId"> {
  return {
    scope: "project", kind: "convention", title: "Use mise",
    content: "Use mise for project runtime management.", tags: ["mise", "runtime"],
    importance: 4, confidence: 0.95, evidenceEntryIds: ["entry-1"], ...overrides,
  };
}

test("stores, deduplicates, scopes, searches, and forgets memories", () => {
  const { root, database, project } = fixture();
  try {
    const first = database.addMemory({ candidate: candidate(), projectId: project.id, sourceKind: "manual", sourceRef: "test" });
    const duplicate = database.addMemory({ candidate: candidate({ title: "Mise runtime rule" }), projectId: project.id, sourceKind: "manual", sourceRef: "test-2" });
    assert.equal(first.memoryId, duplicate.memoryId);
    assert.equal(database.countMemories(), 1);
    assert.equal(database.listSources(first.memoryId).length, 2);

    const results = database.search("mise runtime", project.id, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.memoryId, first.memoryId);

    assert.equal(database.search("mise runtime", "another-project", 10).length, 0);
    assert.equal(database.forgetMemory(first.memoryId), true);
    assert.equal(database.search("mise runtime", project.id, 10).length, 0);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removes former-agent references before they can remain active", () => {
  const { root, database, project } = fixture();
  try {
    database.addMemory({
      candidate: candidate({ title: "Former runtime", content: "A Codex-only command should not guide Pi." }),
      projectId: project.id,
      sourceKind: "manual",
      sourceRef: "test",
    });
    assert.equal(database.removeFormerAgentReferences(), 1);
    assert.equal(database.countMemories(), 0);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detaches bootstrap memories from former agent sources", () => {
  const { root, database, project } = fixture();
  const databasePath = database.databasePath;
  try {
    const memory = database.addMemory({ candidate: candidate(), projectId: project.id, sourceKind: "manual", sourceRef: "test" });
    database.db.prepare("UPDATE memories SET source_kind='codex-import', source_ref=? WHERE memory_id=?")
      .run("/Users/example/.codex/memories/source.md", memory.memoryId);
    database.db.prepare("UPDATE memory_sources SET source_kind='grok-import', source_ref=? WHERE memory_id=?")
      .run("/Users/example/.grok/memory/MEMORY.md", memory.memoryId);
    const formerAgentProject = { ...project, id: "former-agent", identity: "path:/Users/example/.codex", rootPath: "/Users/example/.codex", displayName: "former" };
    database.upsertProject(formerAgentProject);
    database.addMemory({ candidate: candidate({ content: "Former-agent-only configuration." }), projectId: formerAgentProject.id, sourceKind: "manual", sourceRef: "test" });
    database.db.exec("CREATE TABLE imports(source_key TEXT PRIMARY KEY, source_hash TEXT NOT NULL, imported_at INTEGER NOT NULL, memory_count INTEGER NOT NULL)");
    database.close();

    const migrated = new MemoryDatabase(databasePath);
    const record = migrated.getMemory(memory.memoryId);
    assert.equal(record?.sourceKind, "bootstrap-import");
    assert.match(record?.sourceRef ?? "", /^pi-bootstrap:\/\/[a-f0-9]{64}$/);
    const sources = migrated.listSources(memory.memoryId);
    assert.equal(sources[0]?.sourceKind, "bootstrap-import");
    assert.match(sources[0]?.sourceRef ?? "", /^pi-bootstrap:\/\/[a-f0-9]{64}$/);
    assert.equal(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='imports'").get(), undefined);
    assert.equal(migrated.getProject(formerAgentProject.id), undefined);
    assert.equal(migrated.db.prepare("SELECT count(*) count FROM memories WHERE project_id=?").get(formerAgentProject.id)?.count, 0);
    assert.equal(migrated.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value, "5");
    migrated.close();
  } finally {
    try { database.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claims jobs once and advances checkpoint only after completion", () => {
  const { root, database, project } = fixture();
  try {
    const capture = {
      sessionId: "session-1", sessionFile: "/session.jsonl", project, leafId: "leaf-1",
      entryIds: ["entry-1"], transcript: "[entry-1] User: remember this", queryText: "remember this", capturedAt: Date.now(),
    };
    assert.equal(database.enqueueCapture(capture), true);
    assert.equal(database.enqueueCapture(capture), false);
    assert.equal(database.getCaptureCheckpoint("session-1"), "leaf-1");
    const job = database.claimNextJob("owner", 60_000, 4);
    assert.ok(job);
    assert.equal(database.claimNextJob("other", 60_000, 4), undefined);
    assert.equal(database.enqueueCapture({ ...capture, leafId: "leaf-2", entryIds: ["entry-2"], capturedAt: capture.capturedAt + 1 }), true);
    assert.equal(database.getCaptureCheckpoint("session-1"), "leaf-2");
    assert.equal(database.claimNextJob("other", 60_000, 4), undefined);
    assert.equal(database.renewJobLease(job.id, "wrong-owner", 60_000), false);
    assert.equal(database.renewJobLease(job.id, "owner", 60_000), true);
    assert.equal(database.getCheckpoint("session-1"), undefined);
    assert.equal(database.completeJob(job, "wrong-owner"), false);
    assert.equal(database.completeJob(job, "owner"), true);
    assert.equal(database.getCheckpoint("session-1"), "leaf-1");
    assert.equal(database.getCaptureCheckpoint("session-1"), "leaf-2");
    const second = database.claimNextJob("owner", 60_000, 4);
    assert.ok(second);
    assert.equal(database.completeJob(second, "owner"), true);
    assert.equal(database.getCheckpoint("session-1"), "leaf-2");
    assert.equal(database.completeJob(job, "owner"), false);
    assert.equal(database.getCheckpoint("session-1"), "leaf-2");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an expired lease cannot be renewed by its former owner", () => {
  const { root, database, project } = fixture();
  try {
    database.enqueueCapture({
      sessionId: "expired-session", sessionFile: "/session.jsonl", project, leafId: "leaf",
      entryIds: ["entry"], transcript: "durable result", queryText: "durable", capturedAt: Date.now(),
    });
    const job = database.claimNextJob("owner", 60_000, 4);
    assert.ok(job);
    database.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, job.id);
    assert.equal(database.renewJobLease(job.id, "owner", 60_000), false);
    assert.equal(database.completeJob(job, "owner"), false);
    assert.equal(database.failJob(job, "owner", "stale worker", 4), false);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redacts persistence boundaries for memories and queued captures", () => {
  const { root, database, project } = fixture();
  try {
    const memory = database.addMemory({
      candidate: candidate({ title: "Secret-shaped input", content: "api_key=super-secret-value" }),
      projectId: project.id, sourceKind: "manual", sourceRef: "manual secret=another-secret-value",
    });
    assert.ok(!memory.content.includes("super-secret-value"));
    assert.ok(!database.listSources(memory.memoryId)[0]?.sourceRef.includes("another-secret-value"));
    database.enqueueCapture({
      sessionId: "secret-session", sessionFile: "/session.jsonl", project, leafId: "secret-leaf",
      entryIds: ["entry"], transcript: "password=raw-password-value", queryText: "token secret=raw-token-value", capturedAt: Date.now(),
    });
    const job = database.claimNextJob("owner", 60_000, 4);
    assert.ok(job);
    assert.ok(!job.payload.transcript.includes("raw-password-value"));
    assert.ok(!job.payload.queryText.includes("raw-token-value"));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FTS BM25 ranks the stronger lexical match first", () => {
  const { root, database, project } = fixture();
  try {
    const strong = database.addMemory({
      candidate: candidate({ title: "Authentication token rotation", content: "Authentication token rotation prevents authentication token reuse.", importance: 3 }),
      projectId: project.id, sourceKind: "manual", sourceRef: "strong",
    });
    database.addMemory({
      candidate: candidate({ title: "General deployment notes", content: "Deployment logging and monitoring include an authentication check and periodic token cleanup.", importance: 3 }),
      projectId: project.id, sourceKind: "manual", sourceRef: "weak",
    });
    const results = database.search("authentication token rotation", project.id, 10);
    assert.equal(results[0]?.memoryId, strong.memoryId);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("global memories are visible across projects and pinned memories survive unrelated queries", () => {
  const { root, database, project } = fixture();
  try {
    const global = database.addMemory({
      candidate: candidate({ scope: "global", kind: "preference", title: "Never commit automatically", content: "Never commit or push without explicit approval.", importance: 5 }),
      projectId: null, sourceKind: "manual", sourceRef: "test",
    });
    const results = database.search("completely unrelated query", project.id, 10);
    assert.ok(results.some((memory) => memory.memoryId === global.memoryId));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
