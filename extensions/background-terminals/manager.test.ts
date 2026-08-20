import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { MAX_RUNNING_TERMINALS, TerminalManager } from "./src/manager.ts";

async function waitForSettlement(manager: TerminalManager, id: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let text = "";
  while (Date.now() < deadline) {
    const result = await manager.read(id, { cursor, waitMs: 200 });
    text += result.text;
    cursor = result.cursor;
    if (result.snapshot.status !== "running") return { snapshot: result.snapshot, text };
  }
  throw new Error(`Timed out waiting for ${id}`);
}

test("runs a command in a PTY, captures output, and flushes a private full log", async () => {
  const manager = new TerminalManager();
  let logPath: string | undefined;
  try {
    const terminal = manager.start({
      title: "quick",
      command: "printf 'hello from pty\\n'",
      cwd: process.cwd(),
    });
    logPath = terminal.output.spillPath;
    const settled = await waitForSettlement(manager, terminal.id);
    assert.equal(settled.snapshot.status, "done");
    assert.equal(settled.snapshot.exitCode, 0);
    assert.match(settled.text, /hello from pty/);
    assert.ok(logPath && fs.existsSync(logPath));
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(logPath, "utf8"), /hello from pty/);
  } finally {
    await manager.dispose();
  }
  assert.equal(logPath ? fs.existsSync(logPath) : true, false);
});

test("caps private logs while retaining the newest live output", async () => {
  const manager = new TerminalManager(process.env, { maxFullLogBytes: 128 });
  try {
    const terminal = manager.start({
      title: "bounded-log",
      command: "yes x | head -c 4096",
      cwd: process.cwd(),
    });
    const settled = await waitForSettlement(manager, terminal.id);
    const logPath = settled.snapshot.output.spillPath;
    assert.equal(settled.snapshot.status, "done");
    assert.equal(settled.snapshot.output.spillTruncated, true);
    assert.ok(logPath && fs.statSync(logPath).size <= 128);
    assert.ok(settled.snapshot.output.text.length > 128);
  } finally {
    await manager.dispose();
  }
});

test("accepts interactive input and supports incremental output cursors", async () => {
  const manager = new TerminalManager();
  try {
    const terminal = manager.start({
      title: "interactive",
      command: "printf 'ready\\n'; IFS= read -r answer; printf 'got:%s\\n' \"$answer\"",
      cwd: process.cwd(),
    });
    const ready = await manager.read(terminal.id, { cursor: 0, waitMs: 1_000 });
    assert.match(ready.text, /ready/);
    manager.write(terminal.id, "answer from pi\r");
    const settled = await waitForSettlement(manager, terminal.id);
    assert.equal(settled.snapshot.status, "done");
    assert.match(settled.text, /got:answer from pi/);
    const noDuplicate = await manager.read(terminal.id, { cursor: settled.snapshot.output.cursor });
    assert.equal(noDuplicate.text, "");
  } finally {
    await manager.dispose();
  }
});

test("stops the PTY process group and settles exactly once as killed", async () => {
  const manager = new TerminalManager();
  const settled: string[] = [];
  manager.setOnSettled((snapshot) => settled.push(snapshot.id));
  try {
    const terminal = manager.start({
      title: "server",
      command: "sleep 30 & echo child:$!; wait",
      cwd: process.cwd(),
    });
    const started = await manager.read(terminal.id, { cursor: 0, waitMs: 1_000 });
    const childPid = Number(started.text.match(/child:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(childPid));
    const [stopped] = await manager.kill([terminal.id]);
    assert.equal(stopped?.status, "killed");
    assert.deepEqual(settled, [terminal.id]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(childPid, 0));
  } finally {
    await manager.dispose();
  }
});

test("pruning settled terminals deletes their private logs", async () => {
  const manager = new TerminalManager();
  let oldestLog: string | undefined;
  try {
    for (let index = 0; index < 33; index++) {
      const terminal = manager.start({
        title: `settled-${index}`,
        command: `printf '${index}\\n'`,
        cwd: process.cwd(),
      });
      if (index === 0) oldestLog = terminal.output.spillPath;
      await waitForSettlement(manager, terminal.id);
    }
    assert.ok(oldestLog);
    assert.equal(fs.existsSync(oldestLog!), false);
    assert.equal(manager.list().length, 32);
  } finally {
    await manager.dispose();
  }
});

test("reserves the concurrency limit synchronously", async () => {
  const manager = new TerminalManager();
  try {
    for (let index = 0; index < MAX_RUNNING_TERMINALS; index++) {
      manager.start({ title: `hold-${index}`, command: "sleep 30", cwd: process.cwd() });
    }
    assert.throws(
      () => manager.start({ title: "overflow", command: "sleep 30", cwd: process.cwd() }),
      new RegExp(`At most ${MAX_RUNNING_TERMINALS}`),
    );
  } finally {
    await manager.dispose();
  }
});
