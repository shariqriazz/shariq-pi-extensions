import { uuidv7, type Api, type Context, type Model, type Usage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { SmartCompactionConfig } from "./config.ts";
import {
  formatFileOperationsXml,
  sanitizeTagContent,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_SYSTEM_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
  serializeConversationForCompaction,
} from "./prompt.ts";

export interface SmartCompactionDetails {
  schemaVersion: 2;
  customCompactor: "smart-compaction";
  model: string;
  isInherited: boolean;
  readFiles: string[];
  modifiedFiles: string[];
  cycleCount: number;
  timestamp: number;
}

export function resolveCompactionModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  configuredModelString?: string,
): { model: Model<Api>; isInherited: boolean } {
  const trimmed = configuredModelString?.trim();
  if (!trimmed || trimmed === "inherit") {
    if (!ctx.model) {
      throw new Error("No active session model available to inherit for compaction.");
    }
    return { model: ctx.model, isInherited: true };
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
    return { model: candidate, isInherited: false };
  }

  if (ctx.model) {
    return { model: ctx.model, isInherited: true };
  }

  throw new Error(`Configured compaction model "${trimmed}" was not found in model registry.`);
}

export function extractPriorFileState(branchEntries?: any[]): {
  readFiles: Set<string>;
  modifiedFiles: Set<string>;
  cycleCount: number;
} {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  let cycleCount = 0;

  if (!Array.isArray(branchEntries)) return { readFiles, modifiedFiles, cycleCount };

  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry?.type === "compaction" && entry.details) {
      const details = entry.details as Partial<SmartCompactionDetails> & { readFiles?: string[]; modifiedFiles?: string[] };
      if (Array.isArray(details.readFiles)) {
        for (const file of details.readFiles) readFiles.add(file);
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const file of details.modifiedFiles) modifiedFiles.add(file);
      }
      if (typeof details.cycleCount === "number") {
        cycleCount = Math.max(cycleCount, details.cycleCount);
      }
    }
  }

  return { readFiles, modifiedFiles, cycleCount };
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
  if (response.stopReason === "length") {
    throw new Error("Compaction summary was truncated due to output length limit (stopReason=length).");
  }
  if (response.stopReason === "error") {
    throw new Error("Compaction model reported stopReason=error.");
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
  const configuredMax = typeof config.maxSummaryTokens === "number" && config.maxSummaryTokens > 0
    ? config.maxSummaryTokens
    : 8192;

  const reserveDerived = Math.max(4096, Math.floor(0.8 * reserveTokens));
  const modelLimit = model.maxTokens > 0 ? model.maxTokens : configuredMax;

  return Math.min(configuredMax, reserveDerived, modelLimit);
}

export interface RunSmartCompactionOptions {
  event: SessionBeforeCompactEvent;
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">;
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

  // Multi-Stage Retry Ladder:
  // Stage 1: Primary configured model with requested reasoning
  // Stage 2: Primary configured model with reasoning OFF
  // Stage 3: Session model with reasoning OFF (if different)
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

  if (sessionModel && sessionModel.id !== primaryModel.id) {
    plans.push({
      model: sessionModel,
      reasoning: "off",
      isInherited: true,
      stageLabel: "session model fallback",
    });
  }

  let lastError: Error | undefined;
  let finalSummaryText = "";
  let finalUsage: Usage | undefined;
  let activeModel = primaryModel;
  let activeIsInherited = primaryIsInherited;

  const reserveTokens = preparation.settings?.reserveTokens ?? 16384;

  for (const plan of plans) {
    signal?.throwIfAborted();
    activeModel = plan.model;
    activeIsInherited = plan.isInherited;

    const tokenCeiling = computeCompactionTokenCeiling(plan.model, config, reserveTokens);
    const completeOptions: Record<string, unknown> = {
      maxTokens: tokenCeiling,
      signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
    };

    if (plan.reasoning && plan.reasoning !== "off") {
      completeOptions.reasoning = plan.reasoning;
    }

    try {
      const response = await ctx.modelRegistry.complete(plan.model, context, completeOptions as any);
      signal?.throwIfAborted();
      finalSummaryText = validateSummaryOutput(response);
      finalUsage = response.usage;
      lastError = undefined;
      break; // Success!
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      // Continue to next stage in retry ladder
    }
  }

  if (lastError || !finalSummaryText) {
    throw lastError ?? new Error("All smart compaction retry stages failed.");
  }

  // Deterministic file operation accumulation across cycles
  const prior = extractPriorFileState(branchEntries);
  const currentOps = preparation.fileOps;

  const combinedModified = new Set([
    ...prior.modifiedFiles,
    ...(currentOps?.written ?? []),
    ...(currentOps?.edited ?? []),
  ]);

  const combinedRead = new Set([
    ...prior.readFiles,
    ...(currentOps?.read ?? []),
  ]);

  const readFilesList = [...combinedRead].filter((f) => !combinedModified.has(f)).sort();
  const modifiedFilesList = [...combinedModified].sort();

  const fileOpsXml = formatFileOperationsXml({
    read: readFilesList,
    written: modifiedFilesList,
  });

  const finalSummary = `${finalSummaryText}${fileOpsXml}`;
  const cycleCount = prior.cycleCount + 1;

  const details: SmartCompactionDetails = {
    schemaVersion: 2,
    customCompactor: "smart-compaction",
    model: `${activeModel.provider}/${activeModel.id}`,
    isInherited: activeIsInherited,
    readFiles: readFilesList,
    modifiedFiles: modifiedFilesList,
    cycleCount,
    timestamp: Date.now(),
  };

  return {
    summary: finalSummary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: finalUsage,
    details,
  };
}
