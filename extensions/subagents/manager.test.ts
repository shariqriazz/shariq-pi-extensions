/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * a scripted Pi stub backend. Production uses the real in-process Pi backend.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { makeStubBackend } from "./test-support/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "test-provider/test-model",
      contextWindow: 272_000,
      toolName: "bash",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "test",
    origin: "model",
    cwd: process.cwd(),
    capability: "all",
    agentType: "general-purpose",
    isolation: "none",
    maxConcurrent: 4,
    parent,
  };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "pi");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:pi\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("runtime disposal persists running agents as interrupted without delivering them", async () => {
  const runtime = createTestRuntime();
  const manager = await runtime.runPromise(SubagentManager);
  const settled: Array<{ status: string; consumed: boolean; error?: string }> = [];
  manager.view.setOnSettled((snap, consumed) => {
    settled.push({ status: snap.status, consumed, error: snap.errorText });
  });
  const snap = await runTool(runtime, manager.spawn("pi", task("Long running shutdown task")));
  assert.equal(snap.status, "running");

  await runtime.dispose();

  assert.deepEqual(settled, [{ status: "error", consumed: true, error: "Run was aborted" }]);
  assert.equal(snap.status, "error");
  assert.equal(snap.errorText, "Run was aborted");
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("Task 5"))),
      /Max 4 Pi subagents/,
    );
  });
});

test("concurrency groups enforce independent project pools", async () => {
  await withManager(async (manager, runtime) => {
    const grouped = (prompt: string, group: string): SpawnTask => ({
      ...task(prompt),
      maxConcurrent: 1,
      concurrencyGroup: group,
    });
    await runTool(runtime, manager.spawn("pi", grouped("Project A", "project-a")));
    await runTool(runtime, manager.spawn("pi", grouped("Project B", "project-b")));
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", grouped("Project A second", "project-a"))),
      /Max 1 Pi subagents/,
    );
  });
});

test("batch spawn returns running children without consuming their eventual results", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const spawned = await runTool(
      runtime,
      manager.spawnBatch("pi", [task("Task 1"), task("Task 2"), task("Task 3")]),
    );
    assert.equal(spawned.length, 3);
    assert.ok(spawned.every((snapshot) => snapshot.status === "running"));
    await assert.rejects(
      runTool(runtime, manager.spawnBatch("pi", [task("Task 4"), task("Task 5")])),
      /Cannot start 2 tasks atomically/,
    );
    assert.equal(manager.view.size(), 3);

    while (manager.view.list().some((snapshot) => snapshot.status === "running")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(settled.length, 3);
    assert.ok(settled.every((entry) => entry.consumed === false));
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("pi", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 Pi subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // An immediate wait must observe the reserved restart rather than returning
    // the previous turn before RunStarted reaches the event pump.
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
