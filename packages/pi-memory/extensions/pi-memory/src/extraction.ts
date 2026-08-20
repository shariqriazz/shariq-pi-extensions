import { uuidv7, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryModelConfig } from "./config.ts";
import type { MemoryDatabase } from "./database.ts";
import type { CaptureJob, MemoryCandidate, MemoryKind, MemoryRecord } from "./types.ts";
import { MEMORY_KINDS } from "./types.ts";

const KIND_SET = new Set<string>(MEMORY_KINDS);
const FORMER_AGENT_REFERENCE = /\b(?:codex|grok)\b|\.(?:codex|grok)(?:\/|\\)/i;

function responseText(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function parseJsonArray(text: string): unknown[] {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("memory extractor returned no JSON array");
  const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("memory extractor output was not an array");
  return parsed;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function validateCandidates(raw: unknown[], options: {
  evidenceIds: ReadonlySet<string>;
  targetIds: ReadonlySet<string>;
}): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    const operation = ["add", "update", "supersede", "ignore"].includes(String(value.operation))
      ? String(value.operation) as MemoryCandidate["operation"] : "add";
    const scope = value.scope === "global" ? "global" : value.scope === "project" ? "project" : undefined;
    const kind = KIND_SET.has(String(value.kind)) ? String(value.kind) as MemoryKind : undefined;
    const title = typeof value.title === "string" ? value.title.trim().slice(0, 160) : "";
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 4_000) : "";
    if (!scope || !kind || !title || !content || FORMER_AGENT_REFERENCE.test(`${title}\n${content}`)) continue;
    const targetId = typeof value.targetId === "string" && options.targetIds.has(value.targetId) ? value.targetId : undefined;
    if ((operation === "update" || operation === "supersede") && !targetId) continue;
    const tags = Array.isArray(value.tags)
      ? [...new Set(value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 16)
      : [];
    const evidenceEntryIds = Array.isArray(value.evidenceEntryIds)
      ? value.evidenceEntryIds.filter((id): id is string => typeof id === "string" && options.evidenceIds.has(id)).slice(0, 20)
      : [];
    candidates.push({
      operation,
      ...(targetId ? { targetId } : {}),
      scope,
      kind,
      title,
      content,
      tags,
      importance: Math.round(finiteNumber(value.importance, 3, 1, 5)),
      confidence: finiteNumber(value.confidence, 0.75, 0, 1),
      evidenceEntryIds,
    });
  }
  return candidates.slice(0, 24);
}

function relatedMemoryText(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "(none)";
  return memories.map((memory) => [
    `ID: ${memory.memoryId}`,
    `Scope: ${memory.scope}${memory.projectId ? ` (${memory.projectId})` : ""}`,
    `Kind: ${memory.kind}`,
    `Title: ${memory.title}`,
    `Content: ${memory.content}`,
  ].join("\n")).join("\n\n---\n\n");
}

function resolveModel(ctx: Pick<ExtensionContext, "modelRegistry">, configured: MemoryModelConfig): Model<Api> | undefined {
  return ctx.modelRegistry.find(configured.provider, configured.model);
}

export async function extractJob(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  database: MemoryDatabase,
  job: CaptureJob,
  options: { model: MemoryModelConfig; maxOutputTokens: number; signal?: AbortSignal; authorizeApply: () => boolean },
): Promise<number> {
  const model = resolveModel(ctx, options.model);
  if (!model) throw new Error(`${options.model.provider}/${options.model.model} is unavailable for memory extraction`);

  const related = database.search(job.payload.queryText || job.payload.transcript.slice(-8_000), job.projectId, 16);
  const allowedTargets = new Set(related.map((memory) => memory.memoryId));
  const evidenceIds = new Set(job.payload.entryIds);
  const prompt = `You extract durable memory from work performed inside Pi.

Return ONLY a JSON array. Never include markdown fences or commentary.

A durable memory must help in a future session. Keep:
- explicit user preferences and standing constraints;
- project conventions and architecture decisions;
- verified facts that remain useful beyond this turn;
- reusable solutions, warnings, and failure lessons.

Do NOT keep:
- secrets, credentials, tokens, cookies, private keys, or sensitive raw values;
- transient task status, todos, progress narration, or one-off command output;
- guesses, assistant proposals the user did not accept, duplicated facts, or information contradicted later;
- raw transcript, hidden reasoning, or generic advice;
- former-agent names, paths, commands, thread mechanics, runtime behavior, or migration details that do not apply to Pi.

When a harness-independent lesson remains useful, express it in Pi-native or general terms without naming the former agent. If that would make the statement inaccurate, omit it.

Scope rules:
- global: stable cross-project user preferences only;
- project: facts, conventions, decisions, and solutions specific to this project.

Compare against RELATED MEMORIES. Use:
- add: genuinely new durable memory;
- update: same durable memory should be clarified in place;
- supersede: a newer decision or correction replaces the target;
- ignore: omit it from the returned array instead.
Only target an exact ID listed below. Prefer one atomic fact per item.

Each array item must be:
{"operation":"add|update|supersede","targetId":"required for update/supersede","scope":"global|project","kind":"preference|decision|convention|fact|solution|warning|reference","title":"short label","content":"self-contained durable statement","tags":["search","terms"],"importance":1,"confidence":0.0,"evidenceEntryIds":["entry id"]}
Importance is 1-5. Confidence is 0-1. Evidence IDs must come from the transcript labels.

PROJECT
ID: ${job.payload.project.id}
Name: ${job.payload.project.displayName}
Root: ${job.payload.project.rootPath}
Identity: ${job.payload.project.identity}

RELATED MEMORIES
${relatedMemoryText(related)}

PI SESSION DELTA
${job.payload.transcript}`;

  const response = await ctx.modelRegistry.complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    {
      maxTokens: options.maxOutputTokens,
      reasoning: options.model.reasoning,
      signal: options.signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
    },
  );
  const candidates = validateCandidates(parseJsonArray(responseText(response.content)), {
    evidenceIds,
    targetIds: allowedTargets,
  });

  if (!options.authorizeApply()) throw new Error("memory job lease was lost before apply");

  let applied = 0;
  for (const candidate of candidates) {
    if (candidate.operation === "ignore") continue;
    const { operation: _operation, targetId: _targetId, ...data } = candidate;
    const target = candidate.targetId ? database.getMemory(candidate.targetId) : undefined;
    if (target) {
      data.scope = target.scope;
      data.kind = target.kind;
    }
    if (candidate.operation === "update" && candidate.targetId && target) {
      if (database.updateMemory(candidate.targetId, data, target.projectId, "pi-session", job.payload.sessionFile)) applied += 1;
    } else if (candidate.operation === "supersede" && candidate.targetId && target) {
      if (database.supersedeMemory(candidate.targetId, data, target.projectId, "pi-session", job.payload.sessionFile)) applied += 1;
    } else {
      database.addMemory({ candidate: data, projectId: job.projectId, sourceKind: "pi-session", sourceRef: job.payload.sessionFile });
      applied += 1;
    }
  }
  return applied;
}
