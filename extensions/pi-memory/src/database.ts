import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "./redaction.ts";
import type {
  CaptureJob,
  CapturedSession,
  MemoryCandidate,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySourceKind,
  ProjectIdentity,
  SearchResult,
} from "./types.ts";

const SCHEMA_VERSION = 5;

type Row = Record<string, unknown>;

function jsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function memoryFromRow(row: Row): MemoryRecord {
  return {
    id: Number(row.id),
    memoryId: String(row.memory_id),
    scope: String(row.scope) as MemoryScope,
    projectId: row.project_id === null ? null : String(row.project_id),
    kind: String(row.kind) as MemoryKind,
    title: String(row.title),
    content: String(row.content),
    tags: jsonStringArray(row.tags),
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    status: String(row.status) as MemoryRecord["status"],
    sourceKind: String(row.source_kind) as MemorySourceKind,
    sourceRef: String(row.source_ref),
    sourceEntryIds: jsonStringArray(row.source_entry_ids),
    fingerprint: String(row.fingerprint),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: row.last_accessed_at === null ? null : Number(row.last_accessed_at),
    accessCount: Number(row.access_count),
  };
}

export function memoryFingerprint(scope: MemoryScope, projectId: string | null, kind: MemoryKind, content: string): string {
  const normalized = content.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return crypto.createHash("sha256").update(`${scope}\0${projectId ?? ""}\0${kind}\0${normalized}`).digest("hex");
}

export class MemoryDatabase {
  readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    for (const suffix of ["-wal", "-shm"]) {
      const auxiliary = `${databasePath}${suffix}`;
      if (fs.existsSync(auxiliary)) fs.chmodSync(auxiliary, 0o600);
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        identity TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        directory_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
        project_id TEXT REFERENCES projects(id),
        kind TEXT NOT NULL CHECK(kind IN ('preference','decision','convention','fact','solution','warning','reference')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','deleted')),
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_entry_ids TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_scope_project_status ON memories(scope, project_id, status);
      CREATE INDEX IF NOT EXISTS memories_updated_at ON memories(updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_sources (
        id INTEGER PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_entry_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        UNIQUE(memory_id, source_kind, source_ref)
      );
      CREATE INDEX IF NOT EXISTS memory_sources_memory ON memory_sources(memory_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        title, content, tags,
        content='memories', content_rowid='id',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, content, tags ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO memory_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        job_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','complete','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        payload TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, next_attempt_at, lease_expires_at);
      CREATE TABLE IF NOT EXISTS session_checkpoints (
        session_id TEXT PRIMARY KEY,
        leaf_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_capture_watermarks (
        session_id TEXT PRIMARY KEY,
        leaf_id TEXT NOT NULL,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        updated_at INTEGER NOT NULL
      );
    `);
    this.detachBootstrapImports();
    this.db.exec("DROP TABLE IF EXISTS imports");
    this.db.prepare("INSERT INTO metadata(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
    this.db.exec(`
      INSERT OR IGNORE INTO memory_sources(memory_id, source_kind, source_ref, source_entry_ids, created_at)
      SELECT memory_id, source_kind, source_ref, source_entry_ids, created_at FROM memories
    `);
  }

  private detachBootstrapImports(): void {
    const detachedRef = (kind: string, reference: string) =>
      `pi-bootstrap://${crypto.createHash("sha256").update(`${kind}\0${reference}`).digest("hex")}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceRows = this.db.prepare(`
        SELECT id, source_kind, source_ref FROM memory_sources
        WHERE source_kind IN ('codex-import', 'grok-import')
      `).all() as Row[];
      const updateSource = this.db.prepare("UPDATE memory_sources SET source_kind='bootstrap-import', source_ref=? WHERE id=?");
      for (const row of sourceRows) updateSource.run(detachedRef(String(row.source_kind), String(row.source_ref)), Number(row.id));

      const memoryRows = this.db.prepare(`
        SELECT id, source_kind, source_ref FROM memories
        WHERE source_kind IN ('codex-import', 'grok-import')
      `).all() as Row[];
      const updateMemory = this.db.prepare("UPDATE memories SET source_kind='bootstrap-import', source_ref=? WHERE id=?");
      for (const row of memoryRows) updateMemory.run(detachedRef(String(row.source_kind), String(row.source_ref)), Number(row.id));

      const formerAgentProjects = (this.db.prepare("SELECT id, root_path FROM projects").all() as Row[])
        .filter((row) => [".codex", ".grok"].includes(path.basename(String(row.root_path))));
      const deleteProjectMemories = this.db.prepare("DELETE FROM memories WHERE project_id=?");
      const deleteProject = this.db.prepare("DELETE FROM projects WHERE id=?");
      for (const project of formerAgentProjects) {
        deleteProjectMemories.run(String(project.id));
        deleteProject.run(String(project.id));
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertProject(project: ProjectIdentity): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO projects(id, identity, root_path, display_name, directory_name, created_at, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET root_path=excluded.root_path, display_name=excluded.display_name,
        directory_name=excluded.directory_name, last_seen_at=excluded.last_seen_at
    `).run(project.id, project.identity, project.rootPath, project.displayName, project.directoryName, now, now);
  }

  getProject(id: string): ProjectIdentity | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      identity: String(row.identity),
      rootPath: String(row.root_path),
      displayName: String(row.display_name),
      directoryName: String(row.directory_name),
    };
  }

  listProjects(): ProjectIdentity[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY last_seen_at DESC").all() as Row[]).map((row) => ({
      id: String(row.id), identity: String(row.identity), rootPath: String(row.root_path),
      displayName: String(row.display_name), directoryName: String(row.directory_name),
    }));
  }

  addMemory(input: {
    candidate: Omit<MemoryCandidate, "operation" | "targetId">;
    projectId: string | null;
    sourceKind: MemorySourceKind;
    sourceRef: string;
  }): MemoryRecord {
    const candidate = {
      ...input.candidate,
      title: redactSecrets(input.candidate.title),
      content: redactSecrets(input.candidate.content),
      tags: input.candidate.tags.map(redactSecrets),
    };
    const projectId = candidate.scope === "project" ? input.projectId : null;
    if (candidate.scope === "project" && !projectId) throw new Error("project memory requires a project id");
    const fingerprint = memoryFingerprint(candidate.scope, projectId, candidate.kind, candidate.content);
    const now = Date.now();
    const memoryId = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO memories(memory_id, scope, project_id, kind, title, content, tags, importance,
        confidence, status, source_kind, source_ref, source_entry_ids, fingerprint, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        title=excluded.title,
        tags=excluded.tags,
        importance=MAX(memories.importance, excluded.importance),
        confidence=MAX(memories.confidence, excluded.confidence),
        source_entry_ids=excluded.source_entry_ids,
        updated_at=excluded.updated_at,
        status=CASE
          WHEN memories.status='deleted' AND excluded.source_kind<>'manual' THEN 'deleted'
          ELSE 'active'
        END
    `).run(
      memoryId, candidate.scope, projectId, candidate.kind, candidate.title, candidate.content,
      JSON.stringify(candidate.tags), candidate.importance, candidate.confidence, input.sourceKind,
      redactSecrets(input.sourceRef), JSON.stringify(candidate.evidenceEntryIds), fingerprint, now, now,
    );
    const row = this.db.prepare("SELECT * FROM memories WHERE fingerprint = ?").get(fingerprint) as Row;
    const memory = memoryFromRow(row);
    if (memory.status === "active") {
      this.addSource(memory.memoryId, input.sourceKind, input.sourceRef, candidate.evidenceEntryIds);
    }
    return memory;
  }

  updateMemory(memoryId: string, candidate: Omit<MemoryCandidate, "operation" | "targetId">, projectId: string | null, sourceKind: MemorySourceKind, sourceRef: string): MemoryRecord | undefined {
    const existing = this.getMemory(memoryId);
    if (!existing || existing.status !== "active") return undefined;
    candidate = {
      ...candidate,
      title: redactSecrets(candidate.title),
      content: redactSecrets(candidate.content),
      tags: candidate.tags.map(redactSecrets),
    };
    const scopedProject = candidate.scope === "project" ? projectId : null;
    if (candidate.scope === "project" && !scopedProject) return undefined;
    const fingerprint = memoryFingerprint(candidate.scope, scopedProject, candidate.kind, candidate.content);
    try {
      this.db.prepare(`
        UPDATE memories SET scope=?, project_id=?, kind=?, title=?, content=?, tags=?, importance=?, confidence=?,
          source_ref=?, source_entry_ids=?, fingerprint=?, updated_at=? WHERE memory_id=? AND status='active'
      `).run(candidate.scope, scopedProject, candidate.kind, candidate.title, candidate.content,
        JSON.stringify(candidate.tags), candidate.importance, candidate.confidence, redactSecrets(sourceRef),
        JSON.stringify(candidate.evidenceEntryIds), fingerprint, Date.now(), memoryId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        const collision = this.findByFingerprint(fingerprint);
        throw new Error(
          collision
            ? `Correction would duplicate active memory ${collision.memoryId}.`
            : "Correction would duplicate another memory.",
        );
      }
      throw error;
    }
    const updated = this.getMemory(memoryId);
    if (updated) this.addSource(updated.memoryId, sourceKind, sourceRef, candidate.evidenceEntryIds);
    return updated;
  }

  private addSource(memoryId: string, sourceKind: MemorySourceKind, sourceRef: string, entryIds: string[]): void {
    this.db.prepare(`
      INSERT INTO memory_sources(memory_id, source_kind, source_ref, source_entry_ids, created_at)
      VALUES(?, ?, ?, ?, ?) ON CONFLICT(memory_id, source_kind, source_ref) DO UPDATE SET
        source_entry_ids=excluded.source_entry_ids
    `).run(memoryId, sourceKind, redactSecrets(sourceRef), JSON.stringify(entryIds), Date.now());
  }

  listSources(memoryId: string): Array<{ sourceKind: string; sourceRef: string; sourceEntryIds: string[]; createdAt: number }> {
    const rows = this.db.prepare("SELECT * FROM memory_sources WHERE memory_id=? ORDER BY created_at ASC").all(memoryId) as Row[];
    return rows.map((row) => ({
      sourceKind: String(row.source_kind),
      sourceRef: String(row.source_ref),
      sourceEntryIds: jsonStringArray(row.source_entry_ids),
      createdAt: Number(row.created_at),
    }));
  }

  supersedeMemory(memoryId: string, replacement: Omit<MemoryCandidate, "operation" | "targetId">, projectId: string | null, sourceKind: MemorySourceKind, sourceRef: string): MemoryRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const created = this.addMemory({ candidate: replacement, projectId, sourceKind, sourceRef });
      this.db.prepare("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE memory_id=? AND memory_id<>?")
        .run(created.memoryId, Date.now(), memoryId, created.memoryId);
      this.db.exec("COMMIT");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId) as Row | undefined;
    return row ? memoryFromRow(row) : undefined;
  }

  findByFingerprint(fingerprint: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE fingerprint = ?").get(fingerprint) as Row | undefined;
    return row ? memoryFromRow(row) : undefined;
  }

  removeFormerAgentReferences(): number {
    return Number(this.db.prepare(`
      UPDATE memories SET status='deleted', updated_at=?
      WHERE status='active' AND (
        instr(lower(title), 'codex')>0 OR instr(lower(content), 'codex')>0 OR
        instr(lower(title), 'grok')>0 OR instr(lower(content), 'grok')>0
      )
    `).run(Date.now()).changes);
  }

  forgetMemory(memoryId: string): boolean {
    return this.db.prepare("UPDATE memories SET status='deleted', updated_at=? WHERE memory_id=? AND status='active'")
      .run(Date.now(), memoryId).changes > 0;
  }

  listActive(scope?: MemoryScope, projectId?: string | null, limit = 500): MemoryRecord[] {
    let sql = "SELECT * FROM memories WHERE status='active'";
    const params: Array<string | number | null> = [];
    if (scope) { sql += " AND scope=?"; params.push(scope); }
    if (projectId !== undefined) { sql += " AND project_id IS ?"; params.push(projectId); }
    sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as Row[]).map(memoryFromRow);
  }

  search(query: string, projectId: string, limit: number): SearchResult[] {
    const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [])]
      .filter((token) => token.length > 1)
      .slice(0, 24);
    const now = Date.now();
    const rows: Array<Row & { lexical_score?: unknown }> = [];
    if (tokens.length > 0) {
      const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
      rows.push(...this.db.prepare(`
        SELECT m.*, bm25(memory_fts, 5.0, 1.0, 2.0) AS lexical_score
        FROM memory_fts JOIN memories m ON m.id = memory_fts.rowid
        WHERE memory_fts MATCH ? AND m.status='active' AND (m.scope='global' OR m.project_id=?)
        ORDER BY lexical_score ASC LIMIT ?
      `).all(ftsQuery, projectId, limit * 3) as Array<Row & { lexical_score?: unknown }>);
    }

    const lexicalScores = new Map<number, number>();
    if (rows.length > 0) {
      const ranks = rows.map((row) => Number(row.lexical_score));
      const best = Math.min(...ranks);
      const worst = Math.max(...ranks);
      const range = worst - best;
      for (const row of rows) {
        const rank = Number(row.lexical_score);
        lexicalScores.set(Number(row.id), range <= Number.EPSILON ? 1 : (worst - rank) / range);
      }
    }

    const pinned = this.db.prepare(`
      SELECT m.*, 0.0 AS lexical_score FROM memories m
      WHERE m.status='active' AND m.importance=5 AND (m.scope='global' OR m.project_id=?)
      ORDER BY m.updated_at DESC LIMIT ?
    `).all(projectId, limit) as Array<Row & { lexical_score?: unknown }>;
    const byId = new Map<number, Row & { lexical_score?: unknown }>();
    for (const row of [...rows, ...pinned]) if (!byId.has(Number(row.id))) byId.set(Number(row.id), row);

    const queryTerms = new Set(tokens);
    const scored = [...byId.values()].map((row) => {
      const memory = memoryFromRow(row);
      const lexical = lexicalScores.get(memory.id) ?? 0.22;
      const haystack = `${memory.title} ${memory.tags.join(" ")} ${memory.content}`.toLowerCase();
      const overlap = tokens.length === 0 ? 0 : tokens.filter((term) => haystack.includes(term)).length / tokens.length;
      const importance = memory.importance / 5;
      const confidence = memory.confidence;
      const projectBoost = memory.scope === "project" ? 1.12 : 1;
      const accessBoost = 1 + Math.log1p(memory.accessCount) * 0.025;
      const ageDays = Math.max(0, now - memory.updatedAt) / 86_400_000;
      const freshness = memory.kind === "fact" || memory.kind === "reference" ? Math.exp(-Math.log(2) * ageDays / 365) : 1;
      const score = (0.48 * lexical + 0.22 * overlap + 0.16 * importance + 0.14 * confidence)
        * projectBoost * accessBoost * (0.85 + 0.15 * freshness);
      const terms = new Set(haystack.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? []);
      return { ...memory, score, _terms: terms, _queryTerms: queryTerms };
    }).sort((a, b) => b.score - a.score);

    const selected: typeof scored = [];
    for (const candidate of scored) {
      if (selected.length >= limit) break;
      const redundant = selected.some((prior) => {
        let intersection = 0;
        for (const term of candidate._terms) if (prior._terms.has(term)) intersection += 1;
        const union = candidate._terms.size + prior._terms.size - intersection;
        return union > 0 && intersection / union > 0.82;
      });
      if (!redundant || candidate.importance === 5) selected.push(candidate);
    }
    return selected.map(({ _terms: _ignoredTerms, _queryTerms: _ignoredQuery, ...result }) => result);
  }

  recordAccess(memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    const statement = this.db.prepare("UPDATE memories SET access_count=access_count+1, last_accessed_at=? WHERE memory_id=?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      for (const memoryId of memoryIds) statement.run(now, memoryId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rebuildSearchIndex(): void {
    this.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  countMemories(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status='active'").get() as Row;
    return Number(row.count);
  }

  countJobs(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all() as Row[];
    return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
  }

  enqueueCapture(capture: CapturedSession): boolean {
    const jobKey = crypto.createHash("sha256").update(`${capture.sessionId}\0${capture.leafId}`).digest("hex");
    const now = Date.now();
    const sanitizedCapture: CapturedSession = {
      ...capture,
      transcript: redactSecrets(capture.transcript),
      queryText: redactSecrets(capture.queryText),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare(`
        INSERT INTO jobs(job_key, session_id, project_id, status, payload, created_at, updated_at)
        VALUES(?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(job_key) DO NOTHING
      `).run(jobKey, capture.sessionId, capture.project.id, JSON.stringify(sanitizedCapture), now, now);
      const job = this.db.prepare("SELECT id FROM jobs WHERE job_key=?").get(jobKey) as Row;
      this.db.prepare(`
        INSERT INTO session_capture_watermarks(session_id, leaf_id, job_id, updated_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET leaf_id=excluded.leaf_id, job_id=excluded.job_id, updated_at=excluded.updated_at
      `).run(capture.sessionId, capture.leafId, Number(job.id), now);
      this.db.exec("COMMIT");
      return inserted.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextJob(owner: string, leaseMs: number, maxAttempts: number): CaptureJob | undefined {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT candidate.* FROM jobs candidate
        WHERE candidate.attempts < ? AND candidate.next_attempt_at <= ? AND (
          candidate.status='pending' OR (candidate.status='running' AND COALESCE(candidate.lease_expires_at, 0) < ?)
        ) AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.session_id=candidate.session_id AND active.id<>candidate.id
            AND active.status='running' AND COALESCE(active.lease_expires_at, 0) >= ?
        )
        ORDER BY candidate.created_at ASC LIMIT 1
      `).get(maxAttempts, now, now, now) as Row | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const updated = this.db.prepare(`
        UPDATE jobs SET status='running', attempts=attempts+1, lease_owner=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND (status='pending' OR COALESCE(lease_expires_at, 0) < ?)
      `).run(owner, now + leaseMs, now, Number(row.id), now);
      if (updated.changes === 0) { this.db.exec("COMMIT"); return undefined; }
      const claimed = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(Number(row.id)) as Row;
      this.db.exec("COMMIT");
      return {
        id: Number(claimed.id), jobKey: String(claimed.job_key), sessionId: String(claimed.session_id),
        projectId: String(claimed.project_id), status: String(claimed.status) as CaptureJob["status"],
        attempts: Number(claimed.attempts), payload: JSON.parse(String(claimed.payload)) as CapturedSession,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewJobLease(jobId: number, owner: string, leaseMs: number): boolean {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE jobs SET lease_expires_at=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND COALESCE(lease_expires_at, 0)>=?
    `).run(now + leaseMs, now, jobId, owner, now).changes > 0;
  }

  completeJob(job: CaptureJob, owner: string): boolean {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const completed = this.db.prepare("UPDATE jobs SET status='complete', lease_owner=NULL, lease_expires_at=NULL, error=NULL, updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND COALESCE(lease_expires_at, 0)>=?")
        .run(now, job.id, owner, now);
      if (completed.changes === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        INSERT INTO session_checkpoints(session_id, leaf_id, processed_at) VALUES(?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET leaf_id=excluded.leaf_id, processed_at=excluded.processed_at
          WHERE excluded.processed_at >= session_checkpoints.processed_at
      `).run(job.sessionId, job.payload.leafId, job.payload.capturedAt);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failJob(job: CaptureJob, owner: string, error: string, maxAttempts: number): boolean {
    const now = Date.now();
    const terminal = job.attempts >= maxAttempts;
    const backoff = Math.min(60 * 60 * 1_000, 30_000 * 2 ** Math.max(0, job.attempts - 1));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const failed = this.db.prepare(`
        UPDATE jobs SET status=?, next_attempt_at=?, lease_owner=NULL, lease_expires_at=NULL, error=?, updated_at=?
        WHERE id=? AND status='running' AND lease_owner=? AND COALESCE(lease_expires_at, 0)>=?
      `).run(terminal ? "failed" : "pending", now + backoff, error.slice(0, 2_000), now, job.id, owner, now);
      if (terminal && failed.changes > 0) {
        this.db.prepare("DELETE FROM jobs WHERE session_id=? AND status='pending' AND created_at>=?")
          .run(job.sessionId, job.payload.capturedAt);
        this.db.prepare("DELETE FROM session_capture_watermarks WHERE session_id=?").run(job.sessionId);
      }
      this.db.exec("COMMIT");
      return failed.changes > 0;
    } catch (failure) {
      this.db.exec("ROLLBACK");
      throw failure;
    }
  }

  getCaptureCheckpoint(sessionId: string): string | undefined {
    const watermark = this.db.prepare("SELECT leaf_id FROM session_capture_watermarks WHERE session_id=?").get(sessionId) as Row | undefined;
    if (watermark) return String(watermark.leaf_id);
    return this.getCheckpoint(sessionId);
  }

  getCheckpoint(sessionId: string): string | undefined {
    const row = this.db.prepare("SELECT leaf_id FROM session_checkpoints WHERE session_id=?").get(sessionId) as Row | undefined;
    return row ? String(row.leaf_id) : undefined;
  }

}
