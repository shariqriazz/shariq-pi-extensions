export const MEMORY_KINDS = [
  "preference",
  "decision",
  "convention",
  "fact",
  "solution",
  "warning",
  "reference",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = "global" | "project";
export type MemoryStatus = "active" | "superseded" | "deleted";
export type MemorySourceKind = "pi-session" | "manual" | "bootstrap-import";

export interface ProjectIdentity {
  id: string;
  identity: string;
  rootPath: string;
  displayName: string;
  directoryName: string;
}

export interface MemoryRecord {
  id: number;
  memoryId: string;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  status: MemoryStatus;
  sourceKind: MemorySourceKind;
  sourceRef: string;
  sourceEntryIds: string[];
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  accessCount: number;
}

export interface MemoryCandidate {
  operation: "add" | "update" | "supersede" | "ignore";
  targetId?: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  evidenceEntryIds: string[];
}

export interface SearchResult extends MemoryRecord {
  score: number;
}

export interface CapturedSession {
  sessionId: string;
  sessionFile: string;
  project: ProjectIdentity;
  leafId: string;
  entryIds: string[];
  transcript: string;
  queryText: string;
  capturedAt: number;
}

export interface CaptureJob {
  id: number;
  jobKey: string;
  sessionId: string;
  projectId: string;
  status: "pending" | "running" | "complete" | "failed";
  attempts: number;
  payload: CapturedSession;
}
