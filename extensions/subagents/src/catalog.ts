import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
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
}

interface CatalogFile {
  version: 1;
  agents: ArchivedSubagent[];
}

const MAX_CATALOG_AGENTS = 512;

export function allocateSubagentId() {
  // Preserve the legacy sa-N shape while remaining collision-resistant across
  // independent and ephemeral Pi processes.
  const random = BigInt(`0x${randomBytes(8).toString("hex")}`).toString(10).padStart(20, "0");
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
    (record.status === "running" || record.status === "done" || record.status === "error")
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

export function upsertSubagentCatalog(record: ArchivedSubagent) {
  const catalog = loadSubagentCatalog();
  const existing = catalog.get(record.id);
  if (!existing || existing.updatedAt <= record.updatedAt) catalog.set(record.id, record);
  saveSubagentCatalog(catalog.values());
}
