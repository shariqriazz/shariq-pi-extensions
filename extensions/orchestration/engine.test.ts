import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentCoordinator } from "../subagents/src/coordinator.ts";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import { OrchestrationEngine } from "./engine.ts";
import { defaultOrchestrationSettings } from "./settings.ts";

function snapshot(id: string): SubagentSnapshot {
  return {
    id,
    backend: "pi",
    title: id,
    prompt: "",
    cwd: "/tmp/project",
    status: "running",
    createdAt: Date.now(),
    meta: { backend: "pi", origin: "orchestration", concurrencyGroup: "test" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("dedicated orchestrator plans once and wakes after a worker wave", async () => {
  const snapshots = new Map<string, SubagentSnapshot>();
  const listeners = new Set<() => void>();
  const sent: Array<{ id: string; message: string }> = [];
  let nextId = 0;
  const coordinator: SubagentCoordinator = {
    async spawn() {
      const value = snapshot(`agent-${++nextId}`);
      snapshots.set(value.id, value);
      return value;
    },
    async send(id, message) {
      sent.push({ id, message });
      const value = snapshots.get(id)! as SubagentSnapshot & { status: string };
      value.status = "running";
      return value;
    },
    async cancel() {},
    async get(id) { return snapshots.get(id); },
    async list() { return [...snapshots.values()]; },
    async subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async apply() { return { changed: false, files: [] }; },
    async discard() {},
    async release() {},
  };
  const settings = defaultOrchestrationSettings();
  for (const role of Object.values(settings.roles)) role.model = "test/model";
  const pi = {
    async exec() { return { code: 1, stdout: "", stderr: "not git", killed: false }; },
  };
  const engine = new OrchestrationEngine(
    pi as never,
    coordinator,
    () => ({ cwd: "/tmp/project" }) as never,
    { changed() {}, notify() {} },
    () => settings,
    { load: () => [], save() {} },
  );
  await engine.start();
  const run = await engine.create("Map the project architecture");
  const orchestrator = snapshots.get(run.orchestratorAgentId!)! as SubagentSnapshot & {
    status: string;
    settledAt?: number;
    finalText: string;
  };
  orchestrator.status = "done";
  orchestrator.settledAt = Date.now();
  orchestrator.finalText = JSON.stringify({
    decision: "continue",
    summary: "Explore first.",
    tasks: [{ id: "explore", title: "Explore", description: "Inspect architecture", role: "explorer", dependencies: [], acceptanceCriteria: ["Report findings"] }],
  });
  for (const listener of listeners) listener();
  await eventually(() => run.status === "awaiting-approval");
  await engine.approve(run.id);
  const worker = snapshots.get(run.tasks[0].workerAgentId!)! as SubagentSnapshot & {
    status: string;
    settledAt?: number;
    finalText: string;
  };
  worker.status = "done";
  worker.settledAt = Date.now() + 1;
  worker.finalText = "Architecture evidence";
  for (const listener of listeners) listener();
  await eventually(() => sent.some((entry) => entry.id === run.orchestratorAgentId));
  assert.equal(run.tasks[0].status, "completed");
  assert.match(sent.at(-1)!.message, /worker wave settled/i);
  engine.stop();
});
