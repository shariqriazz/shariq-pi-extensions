import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { uuidv7, type Api, type Context, type Model, type Usage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { SmartCompactionConfig } from "./config.ts";
import {
  CHECKPOINT_RESUMPTION_PREAMBLE,
  formatFileOperationsXml,
  sanitizeTagContent,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_SYSTEM_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
  serializeConversationForCompaction,
} from "./prompt.ts";

// Extended 10-minute timeout for large context prefills (up to 1M+ tokens on Gemini/Claude)
export const COMPACTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface DirtyFileState {
  path: string;
  status: string;
}

export interface GitEngineeringState {
  available: boolean;
  files: DirtyFileState[];
  patch: string;
  lockfilesAndGeneratedAssets: string[];
}

export interface SmartCompactionDetails {
  schemaVersion: 3;
  customCompactor: "smart-compaction";
  configuredModel: string;
  resolvedModel: string;
  isInherited: boolean;
  touchedReadFiles: string[];
  touchedModifiedFiles: string[];
  activeDirtyFiles: string[];
  activeDirtyFileStates: DirtyFileState[];
  activeDirtyPatch: string;
  dirtyStateAvailable: boolean;
  activeBackgroundProcesses?: string[];
  lockfilesAndGeneratedAssets?: string[];
  cycleCount: number;
  timestamp: number;
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function resolveCompactionModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  configuredModelString?: string,
): { model: Model<Api>; isInherited: boolean; isFallback: boolean; fallbackReason?: string } {
  const trimmed = configuredModelString?.trim();
  if (!trimmed || trimmed === "inherit") {
    if (!ctx.model) {
      throw new Error("No active session model available to inherit for compaction.");
    }
    return { model: ctx.model, isInherited: true, isFallback: false };
  }

  // Parse "provider/model" or modelId
  let candidate: Model<Api> | undefined;
  if (trimmed.includes("/")) {
    const [provider, ...rest] = trimmed.split("/");
    candidate = ctx.modelRegistry.find(provider, rest.join("/"));
  } else {
    const available = ctx.modelRegistry.getAvailable();
    candidate = available.find((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
  }

  if (candidate) {
    return { model: candidate, isInherited: false, isFallback: false };
  }

  if (ctx.model) {
    return {
      model: ctx.model,
      isInherited: true,
      isFallback: true,
      fallbackReason: `Configured compaction model "${trimmed}" is unavailable in model registry.`,
    };
  }

  throw new Error(`Configured compaction model "${trimmed}" was not found in model registry.`);
}

export function extractPriorFileState(branchEntries?: any[]): {
  touchedReadFiles: Set<string>;
  touchedModifiedFiles: Set<string>;
  cycleCount: number;
} {
  const touchedReadFiles = new Set<string>();
  const touchedModifiedFiles = new Set<string>();
  let cycleCount = 0;

  if (!Array.isArray(branchEntries)) return { touchedReadFiles, touchedModifiedFiles, cycleCount };

  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry?.type === "compaction" && entry.details) {
      const details = entry.details as Partial<SmartCompactionDetails> & {
        readFiles?: string[];
        modifiedFiles?: string[];
        touchedReadFiles?: string[];
        touchedModifiedFiles?: string[];
      };
      const readList = details.touchedReadFiles ?? details.readFiles;
      if (Array.isArray(readList)) {
        for (const file of readList) touchedReadFiles.add(file);
      }
      const modifiedList = details.touchedModifiedFiles ?? details.modifiedFiles;
      if (Array.isArray(modifiedList)) {
        for (const file of modifiedList) touchedModifiedFiles.add(file);
      }
      if (typeof details.cycleCount === "number") {
        cycleCount = Math.max(cycleCount, details.cycleCount);
      }
    }
  }

  return { touchedReadFiles, touchedModifiedFiles, cycleCount };
}

const GENERATED_OR_LOCKFILE_PATTERNS = [
  /(?:^|\/)package-lock\.json$/i,
  /(?:^|\/)pnpm-lock\.yaml$/i,
  /(?:^|\/)yarn\.lock$/i,
  /(?:^|\/)Cargo\.lock$/i,
  /(?:^|\/)poetry\.lock$/i,
  /(?:^|\/)bun\.lockb?$/i,
  /(?:^|\/)composer\.lock$/i,
  /(?:^|\/)flake\.lock$/i,
  /(?:^|\/)mise\.lock$/i,
  /\.min\.(?:js|css|mjs)$/i,
  /\.map$/i,
  /\.wasm$/i,
  /(?:^|\/)(?:dist|build|out|\.next|\.nuxt|\.turbo|\.parcel-cache)\//i,
];

export function isGeneratedOrLockfile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return GENERATED_OR_LOCKFILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getActiveBackgroundProcesses(): string[] {
  try {
    const fn = (globalThis as any).__pi_get_active_terminals;
    if (typeof fn === "function") {
      const active = fn();
      if (Array.isArray(active)) {
        return active.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      }
    }
  } catch {
    // Best-effort inspection.
  }
  return [];
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const DIRTY_PATCH_CHARS = 16_000;
const UNTRACKED_FILE_CHARS = 4_000;

export function parseGitStatusPorcelainV1Z(output: string): DirtyFileState[] {
  const records = output.split("\0");
  const files: DirtyFileState[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    files.push({ path: filePath, status });
    // In porcelain v1 -z output, rename/copy records are followed by the source path.
    if (status.includes("R") || status.includes("C")) index++;
  }
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function truncatePatch(text: string): string {
  if (text.length <= DIRTY_PATCH_CHARS) return text;
  const half = Math.floor(DIRTY_PATCH_CHARS / 2);
  const omitted = text.length - (half * 2);
  return `${text.slice(0, half)}\n\n[... ${omitted} patch characters omitted ...]\n\n${text.slice(-half)}`;
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT,
    signal,
  });
  return result.stdout;
}

async function readUntrackedPreviews(
  root: string,
  files: DirtyFileState[],
): Promise<string> {
  const sections: string[] = [];
  let remaining = DIRTY_PATCH_CHARS;
  for (const file of files) {
    if (file.status !== "??" || isGeneratedOrLockfile(file.path) || remaining <= 0) continue;
    const absolute = path.resolve(root, file.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const metadata = await stat(absolute);
      if (!metadata.isFile()) continue;
      const buffer = await readFile(absolute);
      const header = `\n--- /dev/null\n+++ b/${file.path}\n`;
      if (buffer.includes(0)) {
        const binary = `${header}[binary untracked file: ${buffer.length} bytes]\n`;
        sections.push(binary.slice(0, remaining));
        remaining -= binary.length;
        continue;
      }
      const text = buffer.toString("utf8");
      const limit = Math.min(UNTRACKED_FILE_CHARS, remaining);
      const preview = text.length <= limit
        ? text
        : `${text.slice(0, Math.floor(limit / 2))}\n[... untracked content truncated ...]\n${text.slice(-Math.floor(limit / 2))}`;
      const section = `${header}${preview}\n`;
      sections.push(section.slice(0, remaining));
      remaining -= section.length;
    } catch {
      // A file can disappear between status and snapshot; its status remains useful.
    }
  }
  return sections.join("");
}

export async function getGitEngineeringState(cwd?: string, signal?: AbortSignal): Promise<GitEngineeringState> {
  if (!cwd) return { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };
  try {
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
    const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
    const files = parseGitStatusPorcelainV1Z(status);

    const codeFiles = files.filter((file) => !isGeneratedOrLockfile(file.path));
    const lockOrGeneratedFiles = files.filter((file) => isGeneratedOrLockfile(file.path)).map((file) => file.path);

    const trackedCodePaths = codeFiles.filter((file) => file.status !== "??").map((file) => file.path).slice(0, 250);
    const stagedArgs = ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=2"];
    const unstagedArgs = ["diff", "--no-ext-diff", "--no-color", "--unified=2"];
    if (trackedCodePaths.length > 0) {
      stagedArgs.push("--", ...trackedCodePaths);
      unstagedArgs.push("--", ...trackedCodePaths);
    } else {
      stagedArgs.push("--", ":(exclude,top)**");
      unstagedArgs.push("--", ":(exclude,top)**");
    }
    const [staged, unstaged, untracked] = await Promise.all([
      runGit(root, stagedArgs, signal),
      runGit(root, unstagedArgs, signal),
      readUntrackedPreviews(root, codeFiles),
    ]);
    const sections = [
      staged ? `## Staged changes\n${staged}` : "",
      unstaged ? `## Unstaged changes\n${unstaged}` : "",
      untracked ? `## Untracked files${untracked}` : "",
    ].filter(Boolean);
    return {
      available: true,
      files,
      patch: truncatePatch(sections.join("\n\n")),
      lockfilesAndGeneratedAssets: lockOrGeneratedFiles,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };
  }
}

const REQUIRED_SECTION_PATTERNS = [
  /## 1\.\s+Primary Goal/i,
  /## 2\.\s+Progress Ledger/i,
  /## 3\.\s+Code Changes/i,
  /## 4\.\s+Errors/i,
  /## 5\.\s+Key Decisions/i,
  /## 6\.\s+Resume Anchor/i,
];

export function validateSummaryOutput(response: AssistantMessage): string {
  if (response.stopReason !== "stop") {
    throw new Error(`Compaction model did not complete successfully (stopReason="${response.stopReason}").`);
  }

  // Reject accidental tool calls
  const hasToolCalls = response.content.some((part) => part.type === "toolCall");
  if (hasToolCalls) {
    throw new Error("Compaction model erroneously emitted tool calls instead of text summary.");
  }

  const rawSummaryText = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!rawSummaryText) {
    throw new Error("Compaction model returned an empty summary.");
  }

  // Verify all 6 required sections exist
  for (const pattern of REQUIRED_SECTION_PATTERNS) {
    if (!pattern.test(rawSummaryText)) {
      throw new Error(`Compaction summary is incomplete: missing required section matching ${pattern.source}`);
    }
  }

  return rawSummaryText;
}

export function computeCompactionTokenCeiling(
  model: Model<Api>,
  config: SmartCompactionConfig,
  reserveTokens = 16384,
): number {
  if (reserveTokens <= 0) {
    throw new Error("Reserve tokens budget must be positive.");
  }
  const modelMax = model.maxTokens > 0 ? model.maxTokens : 32768;

  // If the user explicitly configured a maxSummaryTokens override, respect it within model's capacity
  if (typeof config.maxSummaryTokens === "number" && config.maxSummaryTokens > 0) {
    return Math.min(config.maxSummaryTokens, modelMax);
  }

  // Dynamic model-native output capacity:
  // Take full output capacity directly from the model (e.g., 32k, 64k, 128k+)
  return modelMax;
}

export function isFatalCompactionError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("aborted") || msg.includes("cancelled")) return true;
  if (msg.includes("invalid_request") && (msg.includes("reasoning") || msg.includes("effort") || msg.includes("budget"))) {
    return false;
  }
  return (
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid_api_key") ||
    msg.includes("authentication") ||
    msg.includes("403") ||
    msg.includes("forbidden") ||
    msg.includes("402") ||
    msg.includes("insufficient_quota") ||
    msg.includes("billing")
  );
}

export function combineCompactionUsage(first?: Usage, second?: Usage): Usage | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    input: (first.input || 0) + (second.input || 0),
    output: (first.output || 0) + (second.output || 0),
    cacheRead: (first.cacheRead || 0) + (second.cacheRead || 0),
    cacheWrite: (first.cacheWrite || 0) + (second.cacheWrite || 0),
    cacheWrite1h: ((first as any)?.cacheWrite1h || 0) + ((second as any)?.cacheWrite1h || 0),
    reasoning: ((first as any)?.reasoning || 0) + ((second as any)?.reasoning || 0),
    totalTokens: (first.totalTokens || 0) + (second.totalTokens || 0),
    cost: {
      input: ((first.cost as any)?.input || 0) + ((second.cost as any)?.input || 0),
      output: ((first.cost as any)?.output || 0) + ((second.cost as any)?.output || 0),
      cacheRead: ((first.cost as any)?.cacheRead || 0) + ((second.cost as any)?.cacheRead || 0),
      cacheWrite: ((first.cost as any)?.cacheWrite || 0) + ((second.cost as any)?.cacheWrite || 0),
      total: ((first.cost as any)?.total || 0) + ((second.cost as any)?.total || 0),
    },
  };
}

export interface RunSmartCompactionOptions {
  event: SessionBeforeCompactEvent;
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel" | "cwd">;
  config: SmartCompactionConfig;
}

export interface SmartCompactionOutput {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details?: SmartCompactionDetails;
}

export async function runSmartCompaction(
  options: RunSmartCompactionOptions,
): Promise<SmartCompactionOutput> {
  const { event, ctx, config } = options;
  const { preparation, branchEntries, signal, customInstructions } = event;
  signal?.throwIfAborted();

  const { model: primaryModel, isInherited: primaryIsInherited } = resolveCompactionModel(ctx, config.model);
  const sessionModel = ctx.model;

  const messagesToSummarize = [
    ...(preparation.messagesToSummarize ?? []),
    ...(preparation.turnPrefixMessages ?? []),
  ];

  const conversationText = serializeConversationForCompaction(messagesToSummarize);
  const previousSummary = preparation.previousSummary?.trim();
  const baseInstruction = previousSummary ? SMART_COMPACTION_UPDATE_PROMPT : SMART_COMPACTION_INITIAL_PROMPT;

  let promptContent = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptContent += `<previous-summary>\n${sanitizeTagContent(previousSummary)}\n</previous-summary>\n\n`;
  }
  promptContent += baseInstruction;

  if (customInstructions?.trim()) {
    promptContent += `\n\n## Additional User Instructions:\n${sanitizeTagContent(customInstructions.trim())}`;
  }

  const context: Context = {
    systemPrompt: SMART_COMPACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: promptContent }],
        timestamp: Date.now(),
      },
    ],
  };

  type AttemptPlan = {
    model: Model<Api>;
    reasoning?: "off" | "low" | "medium" | "high" | "max";
    isInherited: boolean;
    stageLabel: string;
  };

  const desiredThinking = config.thinkingLevel === "inherit" || !config.thinkingLevel
    ? ctx.thinkingLevel
    : config.thinkingLevel;

  const plans: AttemptPlan[] = [
    {
      model: primaryModel,
      reasoning: primaryModel.reasoning && desiredThinking && desiredThinking !== "off" ? (desiredThinking as any) : undefined,
      isInherited: primaryIsInherited,
      stageLabel: "primary model with reasoning",
    },
    {
      model: primaryModel,
      reasoning: "off",
      isInherited: primaryIsInherited,
      stageLabel: "primary model without reasoning",
    },
  ];

  if (sessionModel && modelKey(sessionModel) !== modelKey(primaryModel)) {
    plans.push({
      model: sessionModel,
      reasoning: "off",
      isInherited: true,
      stageLabel: "session model fallback",
    });
  }

  let lastError: Error | undefined;
  let finalSummaryText = "";
  let accumulatedUsage: Usage | undefined;
  let activeModel = primaryModel;
  let activeIsInherited = primaryIsInherited;

  const reserveTokens = preparation.settings?.reserveTokens ?? 16384;

  for (const plan of plans) {
    signal?.throwIfAborted();
    activeModel = plan.model;
    activeIsInherited = plan.isInherited;

    const tokenCeiling = computeCompactionTokenCeiling(plan.model, config, reserveTokens);

    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(
        new Error(`Compaction stage "${plan.stageLabel}" timed out after 10 minutes.`),
      );
    }, COMPACTION_TIMEOUT_MS);

    const stageSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    const completeOptions: Record<string, unknown> = {
      maxTokens: tokenCeiling,
      signal: stageSignal,
      cacheRetention: "none",
      sessionId: uuidv7(),
    };

    if (plan.reasoning && plan.reasoning !== "off") {
      completeOptions.reasoning = plan.reasoning;
    }

    try {
      const response = await ctx.modelRegistry.complete(plan.model, context, completeOptions as any);
      stageSignal.throwIfAborted();
      if (response.usage) {
        accumulatedUsage = combineCompactionUsage(accumulatedUsage, response.usage);
      }
      finalSummaryText = validateSummaryOutput(response);
      lastError = undefined;
      break; // Success!
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isFatalCompactionError(err)) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  if (lastError || !finalSummaryText) {
    throw lastError ?? new Error("All smart compaction retry stages failed.");
  }

  // Deterministic file operation accumulation across cycles
  const prior = extractPriorFileState(branchEntries);
  const currentOps = preparation.fileOps;

  const combinedModified = new Set([
    ...prior.touchedModifiedFiles,
    ...(currentOps?.written ?? []),
    ...(currentOps?.edited ?? []),
  ]);

  const combinedRead = new Set([
    ...prior.touchedReadFiles,
    ...(currentOps?.read ?? []),
  ]);

  const readFilesList = [...combinedRead].filter((file) => !combinedModified.has(file)).sort();
  const touchedModifiedFilesList = [...combinedModified].sort();
  const gitState = await getGitEngineeringState(ctx.cwd, signal);
  const activeDirtyFilesList = gitState.files.map((file) => file.path);
  const activeBackgroundProcesses = getActiveBackgroundProcesses();

  const fileOpsXml = formatFileOperationsXml({
    readFiles: readFilesList,
    touchedModifiedFiles: touchedModifiedFilesList,
    activeDirtyFiles: activeDirtyFilesList,
    dirtyPatch: gitState.patch,
    dirtyStateAvailable: gitState.available,
    activeBackgroundProcesses,
    lockfilesAndGeneratedAssets: gitState.lockfilesAndGeneratedAssets,
  });

  const finalSummary = `${CHECKPOINT_RESUMPTION_PREAMBLE}${finalSummaryText}${fileOpsXml}`;
  const cycleCount = prior.cycleCount + 1;

  const details: SmartCompactionDetails = {
    schemaVersion: 3,
    customCompactor: "smart-compaction",
    configuredModel: config.model || "inherit",
    resolvedModel: modelKey(activeModel),
    isInherited: activeIsInherited,
    touchedReadFiles: readFilesList,
    touchedModifiedFiles: touchedModifiedFilesList,
    activeDirtyFiles: activeDirtyFilesList,
    activeDirtyFileStates: gitState.files,
    activeDirtyPatch: gitState.patch,
    dirtyStateAvailable: gitState.available,
    activeBackgroundProcesses: activeBackgroundProcesses.length > 0 ? activeBackgroundProcesses : undefined,
    lockfilesAndGeneratedAssets: gitState.lockfilesAndGeneratedAssets.length > 0 ? gitState.lockfilesAndGeneratedAssets : undefined,
    cycleCount,
    timestamp: Date.now(),
  };

  return {
    summary: finalSummary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: accumulatedUsage,
    details,
  };
}
