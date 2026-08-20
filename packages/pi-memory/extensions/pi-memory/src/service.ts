import crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "./config.ts";
import { MemoryDatabase } from "./database.ts";
import { extractJob } from "./extraction.ts";
import { isEphemeralProject, resolveProject } from "./project.ts";
import { writeProjections } from "./projection.ts";
import { captureSession } from "./session.ts";
import type { MemoryCandidate, MemoryKind, MemoryRecord, MemoryScope, MemorySourceKind, ProjectIdentity, SearchResult } from "./types.ts";

export class MemoryService {
  readonly config: MemoryConfig;
  private databaseInstance: MemoryDatabase | undefined;
  private readonly owner = `${process.pid}:${crypto.randomUUID()}`;
  private running: Promise<void> | undefined;
  private abortController = new AbortController();
  private closed = false;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  get database(): MemoryDatabase {
    if (!this.databaseInstance) throw new Error("pi-memory database is not initialized");
    return this.databaseInstance;
  }

  initialize(cwd: string): ProjectIdentity {
    if (!this.databaseInstance) this.databaseInstance = new MemoryDatabase(this.config.databasePath);
    const project = resolveProject(cwd);
    this.database.upsertProject(project);
    this.database.removeFormerAgentReferences();
    writeProjections(this.database, this.config.root);
    return project;
  }

  project(cwd: string): ProjectIdentity {
    const project = resolveProject(cwd);
    this.database.upsertProject(project);
    return project;
  }

  enqueueCurrentSession(ctx: ExtensionContext, project: ProjectIdentity): boolean {
    if (isEphemeralProject(project)) return false;
    const capture = captureSession(
      ctx,
      project,
      this.database.getCaptureCheckpoint(ctx.sessionManager.getSessionId()),
      this.config.extractionMaxInputCharacters,
    );
    return capture ? this.database.enqueueCapture(capture) : false;
  }

  processPending(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, maxJobs = 1): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runJobs(ctx, maxJobs)
      .catch(() => {})
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async runJobs(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, maxJobs: number): Promise<void> {
    for (let processed = 0; processed < maxJobs && !this.abortController.signal.aborted; processed += 1) {
      const job = this.database.claimNextJob(this.owner, this.config.jobLeaseMs, this.config.maxJobAttempts);
      if (!job) return;
      const jobAbort = new AbortController();
      const signal = AbortSignal.any([this.abortController.signal, jobAbort.signal]);
      const heartbeat = setInterval(() => {
        if (!this.database.renewJobLease(job.id, this.owner, this.config.jobLeaseMs)) jobAbort.abort();
      }, Math.max(5_000, Math.floor(this.config.jobLeaseMs / 3)));
      heartbeat.unref();
      try {
        await extractJob(ctx, this.database, job, {
          model: { ...this.config.extractionModel },
          maxOutputTokens: this.config.extractionMaxOutputTokens,
          signal,
          authorizeApply: () => this.database.renewJobLease(job.id, this.owner, this.config.jobLeaseMs),
        });
        if (this.database.completeJob(job, this.owner)) writeProjections(this.database, this.config.root);
      } catch (error) {
        if (this.abortController.signal.aborted) {
          this.database.failJob(job, this.owner, "memory extraction cancelled during shutdown", this.config.maxJobAttempts);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.database.failJob(job, this.owner, message, this.config.maxJobAttempts);
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  search(query: string, projectId: string, limit = this.config.maxSearchResults): SearchResult[] {
    return this.database.search(query, projectId, limit);
  }

  save(input: {
    scope: MemoryScope;
    project: ProjectIdentity;
    kind: MemoryKind;
    title: string;
    content: string;
    tags?: string[];
    importance?: number;
    confidence?: number;
    sourceKind?: MemorySourceKind;
    sourceRef?: string;
  }): MemoryRecord {
    const candidate: Omit<MemoryCandidate, "operation" | "targetId"> = {
      scope: input.scope,
      kind: input.kind,
      title: input.title.trim().slice(0, 160),
      content: input.content.trim().slice(0, 4_000),
      tags: [...new Set(input.tags ?? [])].slice(0, 16),
      importance: Math.min(5, Math.max(1, Math.round(input.importance ?? 4))),
      confidence: Math.min(1, Math.max(0, input.confidence ?? 1)),
      evidenceEntryIds: [],
    };
    if (!candidate.title || !candidate.content) throw new Error("title and content are required");
    const memory = this.database.addMemory({
      candidate,
      projectId: input.scope === "project" ? input.project.id : null,
      sourceKind: input.sourceKind ?? "manual",
      sourceRef: input.sourceRef ?? "manual",
    });
    writeProjections(this.database, this.config.root);
    return memory;
  }

  correct(memoryId: string, input: {
    project: ProjectIdentity;
    title?: string;
    content?: string;
    tags?: string[];
    importance?: number;
    confidence?: number;
  }): MemoryRecord | undefined {
    const existing = this.database.getMemory(memoryId);
    if (!existing || existing.status !== "active") return undefined;
    const candidate: Omit<MemoryCandidate, "operation" | "targetId"> = {
      scope: existing.scope,
      kind: existing.kind,
      title: input.title?.trim().slice(0, 160) || existing.title,
      content: input.content?.trim().slice(0, 4_000) || existing.content,
      tags: input.tags ? [...new Set(input.tags)].slice(0, 16) : existing.tags,
      importance: Math.min(5, Math.max(1, Math.round(input.importance ?? existing.importance))),
      confidence: Math.min(1, Math.max(0, input.confidence ?? existing.confidence)),
      evidenceEntryIds: existing.sourceEntryIds,
    };
    const updated = this.database.updateMemory(memoryId, candidate, existing.projectId ?? input.project.id, "manual", "manual-correction");
    writeProjections(this.database, this.config.root);
    return updated;
  }

  forget(memoryId: string): boolean {
    const changed = this.database.forgetMemory(memoryId);
    if (changed) writeProjections(this.database, this.config.root);
    return changed;
  }

  review(projectId: string, limit = 30): MemoryRecord[] {
    const global = this.database.listActive("global", null, limit);
    const project = this.database.listActive("project", projectId, limit);
    return [...global, ...project]
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  rebuild(): void {
    this.database.rebuildSearchIndex();
    writeProjections(this.database, this.config.root);
  }

  status() {
    return {
      memories: this.database.countMemories(),
      jobs: this.database.countJobs(),
      projects: this.database.listProjects().length,
      root: this.config.root,
      database: this.config.databasePath,
      extractionModel: { ...this.config.extractionModel },
    };
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    await this.running?.catch(() => {});
    this.databaseInstance?.close();
    this.databaseInstance = undefined;
  }
}
