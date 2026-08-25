import assert from "node:assert/strict";
import test from "node:test";
import { normalizePersistedSnapshot } from "./src/storage.ts";

function snapshot(status: "running" | "done" | "error" | "cancelled", errorText?: string) {
  return {
    id: "sa-test",
    backend: "pi",
    title: "test",
    prompt: "test",
    cwd: "/tmp",
    status,
    createdAt: 1,
    errorText,
    meta: { backend: "pi", origin: "model" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  } as any;
}

test("persisted interruptions normalize to cancelled without hiding real failures", () => {
  assert.equal(normalizePersistedSnapshot(snapshot("running")).status, "cancelled");
  assert.equal(normalizePersistedSnapshot(snapshot("error", "Run was aborted")).status, "cancelled");
  assert.equal(normalizePersistedSnapshot(snapshot("error", "Forbidden")).status, "error");
  assert.equal(normalizePersistedSnapshot(snapshot("done")).status, "done");
});
