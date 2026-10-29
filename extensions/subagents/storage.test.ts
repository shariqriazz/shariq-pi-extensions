import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentCatalog, ownedByAnotherProcess, upsertSubagentCatalog } from "./src/catalog.ts";

function withAgentDir(run: () => void) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-storage-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("catalog updates keep records from every writer and track live owners", () => {
  withAgentDir(() => {
    const record = (id: string, extra = {}) => ({
      id,
      title: id,
      cwd: "/tmp",
      status: "done" as const,
      sessionFile: `/tmp/${id}.jsonl`,
      updatedAt: Date.now(),
      ...extra,
    });
    upsertSubagentCatalog(record("sa-a"));
    upsertSubagentCatalog(record("sa-b"));
    assert.deepEqual([...loadSubagentCatalog().keys()].sort(), ["sa-a", "sa-b"]);

    assert.equal(
      ownedByAnotherProcess(record("sa-c", { status: "running", ownerPid: process.pid, ownerHost: hostname() })),
      false,
    );
    assert.equal(
      ownedByAnotherProcess(record("sa-d", { status: "running", ownerPid: process.ppid, ownerHost: hostname() })),
      true,
    );
    assert.equal(
      ownedByAnotherProcess(record("sa-e", { status: "running", ownerPid: 2 ** 30, ownerHost: hostname() })),
      false,
    );
    assert.equal(
      ownedByAnotherProcess(record("sa-f", { status: "done", ownerPid: process.ppid, ownerHost: hostname() })),
      false,
    );
  });
});
