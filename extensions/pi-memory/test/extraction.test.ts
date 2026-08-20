import assert from "node:assert/strict";
import test from "node:test";
import { validateCandidates } from "../src/extraction.ts";

test("validates extractor output against evidence and target allowlists", () => {
  const candidates = validateCandidates([
    {
      operation: "update", targetId: "allowed", scope: "global", kind: "preference",
      title: "Concise replies", content: "Prefer concise final responses.", tags: ["Replies", "replies"],
      importance: 9, confidence: 2, evidenceEntryIds: ["entry-1", "invented"],
    },
    {
      operation: "supersede", targetId: "invented", scope: "project", kind: "decision",
      title: "Invalid target", content: "Must be rejected.",
    },
    { operation: "add", scope: "project", kind: "unknown", title: "Bad kind", content: "reject" },
    { operation: "add", scope: "project", kind: "warning", title: "Former runtime", content: "Use a Codex thread command." },
  ], {
    evidenceIds: new Set(["entry-1"]),
    targetIds: new Set(["allowed"]),
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.targetId, "allowed");
  assert.equal(candidates[0]?.importance, 5);
  assert.equal(candidates[0]?.confidence, 1);
  assert.deepEqual(candidates[0]?.tags, ["replies"]);
  assert.deepEqual(candidates[0]?.evidenceEntryIds, ["entry-1"]);
});
