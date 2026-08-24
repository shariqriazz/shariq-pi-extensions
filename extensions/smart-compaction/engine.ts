import { uuidv7, type Api, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { SmartCompactionConfig } from "./config.ts";
import {
  formatFileOperationsXml,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_SYSTEM_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
  serializeConversationForCompaction,
} from "./prompt.ts";

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

export interface RunSmartCompactionOptions {
  event: SessionBeforeCompactEvent;
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">;
  config: SmartCompactionConfig;
}

export interface SmartCompactionOutput {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details?: Record<string, unknown>;
}

export async function runSmartCompaction(
  options: RunSmartCompactionOptions,
): Promise<SmartCompactionOutput> {
  const { event, ctx, config } = options;
  const { preparation, signal, customInstructions } = event;
  signal?.throwIfAborted();

  const { model, isInherited } = resolveCompactionModel(ctx, config.model);

  const messagesToSummarize = [
    ...(preparation.messagesToSummarize ?? []),
    ...(preparation.turnPrefixMessages ?? []),
  ];

  // Serialize messages for the context summary
  const conversationText = serializeConversationForCompaction(messagesToSummarize);

  const previousSummary = preparation.previousSummary?.trim();
  const baseInstruction = previousSummary ? SMART_COMPACTION_UPDATE_PROMPT : SMART_COMPACTION_INITIAL_PROMPT;

  let promptContent = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptContent += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptContent += baseInstruction;

  if (customInstructions?.trim()) {
    promptContent += `\n\n## Additional User Instructions:\n${customInstructions.trim()}`;
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

  const requestedMaxTokens = config.maxSummaryTokens ?? 16384;
  const maxTokens = model.maxTokens > 0 ? Math.min(requestedMaxTokens, model.maxTokens) : requestedMaxTokens;

  const completeOptions: Record<string, unknown> = {
    maxTokens,
    signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
  };

  if (model.reasoning && config.thinkingLevel && config.thinkingLevel !== "off") {
    completeOptions.reasoning = config.thinkingLevel;
  }

  const response = await ctx.modelRegistry.complete(model, context, completeOptions as any);
  signal?.throwIfAborted();

  const rawSummaryText = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!rawSummaryText) {
    throw new Error("Compaction model returned an empty summary.");
  }

  const fileOpsXml = formatFileOperationsXml(preparation.fileOps);
  const finalSummary = `${rawSummaryText}${fileOpsXml}`;

  return {
    summary: finalSummary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: response.usage,
    details: {
      customCompactor: "smart-compaction",
      model: `${model.provider}/${model.id}`,
      isInherited,
    },
  };
}
