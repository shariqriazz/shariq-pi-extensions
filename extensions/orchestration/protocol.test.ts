import assert from "node:assert/strict";
import { test } from "node:test";
import {
  materializeTask,
  parseOrchestratorDecision,
  parseReviewDecision,
  validateTaskGraph,
} from "./protocol.ts";

test("parses a bounded orchestrator task graph", () => {
  const decision = parseOrchestratorDecision(JSON.stringify({
    decision: "continue",
    summary: "Build backend, then frontend.",
    tasks: [
      { id: "backend-api", title: "API", description: "Build API", role: "backend", dependencies: [], acceptanceCriteria: ["API works"] },
      { id: "frontend-ui", title: "UI", description: "Build UI", role: "frontend", dependencies: ["backend-api"], acceptanceCriteria: ["UI works"] },
    ],
  }));
  const tasks = decision.tasks!.map(materializeTask);
  validateTaskGraph(tasks);
  assert.equal(tasks[1].dependencies[0], "backend-api");
});

test("rejects cyclic task dependencies", () => {
  assert.throws(() => validateTaskGraph([
    materializeTask({ id: "a", title: "A", description: "A", role: "general", dependencies: ["b"] }),
    materializeTask({ id: "b", title: "B", description: "B", role: "general", dependencies: ["a"] }),
  ]), /cycle/);
});

test("parses reviewer fixes and findings", () => {
  const review = parseReviewDecision('```json\n{"passed":false,"summary":"needs work","smallFixesApplied":["format x.ts"],"findings":["fix API"]}\n```');
  assert.equal(review.passed, false);
  assert.deepEqual(review.smallFixesApplied, ["format x.ts"]);
  assert.deepEqual(review.findings, ["fix API"]);
});
