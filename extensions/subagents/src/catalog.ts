import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CapabilityMode, IsolationMode } from "./config.ts";
import type { SubagentStatus } from "./domain.ts";
import type { WorktreeInfo } from "./worktree.ts";

export interface ArchivedSubagent {
  id: string;
  title: string;
  cwd: string;
  status: SubagentStatus;
  sessionFile: string;
  model?: string;
  agentType?: string;
  persona?: string;
  capability?: CapabilityMode;
  isolation?: IsolationMode;
  worktree?: WorktreeInfo;
  updatedAt: number;
  /** Set while running: the Pi process that owns the session file and worktree. */
  ownerPid?: number;
  ownerHost?: string;
}

interface CatalogFile {
  version: 1;
  agents: ArchivedSubagent[];
}

const MAX_CATALOG_AGENTS = 512;

export function allocateSubagentId() {
  // Preserve the legacy sa-N shape while remaining collision-resistant across
  // independent and ephemeral Pi processes.
  const random = BigInt(`0x${randomBytes(8).toString("hex")}`)
    .toString(10)
    .padStart(20, "0");
  return `sa-${Date.now()}${random}`;
}

export function subagentCatalogPath() {
  return path.join(getAgentDir(), "subagents", "catalog.json");
}

function validRecord(value: unknown): value is ArchivedSubagent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArchivedSubagent>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.cwd === "string" &&
    typeof record.sessionFile === "string" &&
    typeof record.updatedAt === "number" &&
    (record.status === "running" ||
      record.status === "done" ||
      record.status === "error" ||
      record.status === "cancelled")
  );
}

export function loadSubagentCatalog(): Map<string, ArchivedSubagent> {
  try {
    const parsed = JSON.parse(fs.readFileSync(subagentCatalogPath(), "utf8")) as Partial<CatalogFile>;
    const agents = Array.isArray(parsed.agents) ? parsed.agents.filter(validRecord) : [];
    return new Map(agents.map((record) => [record.id, record]));
  } catch {
    return new Map();
  }
}

export function saveSubagentCatalog(records: Iterable<ArchivedSubagent>) {
  const file = subagentCatalogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const agents = [...records]
    .filter(validRecord)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CATALOG_AGENTS);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, agents }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize the catalog read-modify-write across Pi processes with an atomic
 * lock directory. A lock older than LOCK_STALE_MS belongs to a crashed writer
 * and is reclaimed; if the lock stays busy, the update still proceeds rather
 * than dropping the record.
 */
function withCatalogLock<T>(operation: () => T): T {
  const lock = `${subagentCatalogPath()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // The holder released it between the two calls.
      }
      if (Date.now() > deadline) break;
      sleepSync(10);
    }
  }
  try {
    return operation();
  } finally {
    if (acquired) fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function upsertSubagentCatalog(record: ArchivedSubagent) {
  withCatalogLock(() => {
    const catalog = loadSubagentCatalog();
    const existing = catalog.get(record.id);
    if (!existing || existing.updatedAt <= record.updatedAt) catalog.set(record.id, record);
    saveSubagentCatalog(catalog.values());
  });
}

/** Ownership fields for a record this process is about to run. */
export function currentOwner() {
  return { ownerPid: process.pid, ownerHost: os.hostname() };
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True while another live Pi process owns this running child. A dead owner is a
 * crash leftover and is safe to take over. A different host cannot be checked,
 * so it counts as live.
 */
export function ownedByAnotherProcess(record: ArchivedSubagent | undefined) {
  if (!record || record.status !== "running" || !record.ownerPid) return false;
  if (record.ownerHost && record.ownerHost !== os.hostname()) return true;
  return record.ownerPid !== process.pid && processAlive(record.ownerPid);
}
