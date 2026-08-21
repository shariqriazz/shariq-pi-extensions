import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  JsonlLocalAgentStore,
  type Run,
  type SDKCustomTool,
  type SDKImage,
  type SDKJsonValue,
  type TokenUsage,
} from "@cursor/sdk";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { loadCursorCatalog, resolveCursorModelSelection } from "./models.ts";

const TOOL_DELEGATION_RESULT = "Tool execution was delegated to Pi. End this run without further output.";

function asJsonValue(value: unknown): SDKJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as SDKJsonValue;
}

function asArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function serializeCursorContext(context: Context): { text: string; images: SDKImage[] } {
  const lines = [
    "Continue the Pi conversation below as the assistant.",
    "Follow the system instructions exactly. Use the provided custom tools when needed.",
    "Do not describe or simulate tool calls in prose. Return only the next assistant response.",
    "",
    "<system>",
    context.systemPrompt || "You are a helpful coding assistant.",
    "</system>",
    "<conversation>",
  ];
  const images: SDKImage[] = [];

  for (const message of context.messages) {
    lines.push(`<message role=${JSON.stringify(message.role)}>`);
    if (typeof message.content === "string") {
      lines.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as any[]) {
        if (part?.type === "text" || part?.type === "reasoning") lines.push(String(part.text ?? ""));
        else if (part?.type === "image" && typeof part.data === "string") {
          images.push({ data: part.data, mimeType: part.mimeType ?? "image/png" });
          lines.push(`[Attached image ${images.length}: ${part.mimeType ?? "image/png"}]`);
        } else if (part?.type === "toolCall") {
          lines.push(`[Tool call ${part.id}: ${part.name} ${JSON.stringify(part.arguments ?? {})}]`);
        }
      }
    }
    if (message.role === "toolResult") {
      lines.push(`[Tool result for ${(message as any).toolCallId}; error=${Boolean((message as any).isError)}]`);
    }
    lines.push("</message>");
  }
  lines.push("</conversation>");
  return { text: lines.join("\n"), images };
}

function usageFromCursor(usage: TokenUsage | undefined, output: AssistantMessage): void {
  if (!usage) return;
  output.usage = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    reasoning: usage.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens,
    cost: output.usage.cost,
  };
}

export function formatCursorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauth|api key|credential/i.test(message)) return "Cursor authentication failed. Run `/login cursor`, then retry.";
  if (/429|rate.?limit/i.test(message)) return "Cursor rate limit reached. Wait for the reported reset, then retry.";
  if (/quota|usage limit|billing|credit|exhaust/i.test(message)) return "Cursor usage limit reached. Open `/cursor` for account status and reset information.";
  if (/context|too many tokens|prompt.*long/i.test(message)) return "The Cursor context limit was exceeded. Compact the session or start a new one.";
  if (/capacity|overload|unavailable|503/i.test(message)) return "Cursor has no capacity for this model right now. Retry shortly or switch Cursor models.";
  if (/timeout|timed out|deadline/i.test(message)) return "Cursor timed out. Retry the request.";
  if (/cancel|abort/i.test(message)) return "Cursor request cancelled.";
  return `Cursor request failed: ${message}`;
}

async function disposeAgent(agent: Awaited<ReturnType<typeof Agent.create>> | undefined): Promise<void> {
  if (!agent) return;
  try {
    await Promise.race([
      agent[Symbol.asyncDispose](),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  } catch {
    agent.close();
  }
}

export function streamCursorSdk(model: Model<any>, context: Context, options?: ProviderStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: output });

  void (async () => {
    let workspace: string | undefined;
    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    let run: Run | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let textIndex: number | undefined;
    let reasoningIndex: number | undefined;
    let delegated = false;

    const endText = () => {
      if (textIndex === undefined) return;
      const index = textIndex;
      stream.push({ type: "text_end", contentIndex: index, content: (output.content[index] as any).text, partial: output });
      textIndex = undefined;
    };
    const endReasoning = () => {
      if (reasoningIndex === undefined) return;
      const index = reasoningIndex;
      stream.push({ type: "thinking_end", contentIndex: index, content: (output.content[index] as any).thinking, partial: output });
      reasoningIndex = undefined;
    };
    const textDelta = (delta: string) => {
      if (!delta || delegated) return;
      endReasoning();
      if (textIndex === undefined) {
        textIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
      }
      const index = textIndex;
      (output.content[index] as any).text += delta;
      stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
    };
    const reasoningDelta = (delta: string) => {
      if (!delta || delegated) return;
      endText();
      if (reasoningIndex === undefined) {
        reasoningIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: reasoningIndex, partial: output });
      }
      const index = reasoningIndex;
      (output.content[index] as any).thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
    };

    try {
      const apiKey = options?.apiKey?.trim();
      if (!apiKey) throw new Error("Cursor is not authenticated. Run `/login cursor`.");
      if (options?.signal?.aborted) throw new Error("Cursor request cancelled.");
      workspace = await mkdtemp(join(tmpdir(), "pi-cursor-sdk-"));
      const customTools: Record<string, SDKCustomTool> = {};
      for (const tool of context.tools ?? []) {
        customTools[tool.name] = {
          description: tool.description,
          inputSchema: asJsonValue(tool.parameters ?? { type: "object" }) as Record<string, SDKJsonValue>,
          async execute(args, toolContext) {
            if (!delegated) {
              delegated = true;
              endText();
              endReasoning();
              const toolCall = {
                type: "toolCall" as const,
                id: toolContext.toolCallId || `cursor_${randomUUID()}`,
                name: tool.name,
                arguments: asArguments(args),
              };
              const contentIndex = output.content.length;
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex, partial: output });
              stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
              queueMicrotask(() => { void run?.cancel().catch(() => undefined); });
            }
            return { content: [{ type: "text", text: TOOL_DELEGATION_RESULT }], isError: true };
          },
        };
      }

      const selection = resolveCursorModelSelection(model, typeof options?.reasoning === "string" ? options.reasoning : undefined, loadCursorCatalog());
      agent = await Agent.create({
        apiKey,
        model: selection,
        tools: context.tools?.length ? ["mcp"] : [],
        local: {
          cwd: workspace,
          store: new JsonlLocalAgentStore(join(workspace, "state")),
          customTools,
          enableAgentRetries: options?.maxRetries !== 0,
        },
      });

      const request = serializeCursorContext(context);
      run = await agent.send(request, {
        idempotencyKey: options?.sessionId ? `${options.sessionId}-${randomUUID()}` : undefined,
        onDelta: ({ update }) => {
          if (update.type === "text-delta") textDelta(update.text);
          else if (update.type === "thinking-delta") reasoningDelta(update.text);
        },
      });

      const cancel = () => { void run?.cancel().catch(() => undefined); };
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeoutMs && options.timeoutMs > 0) timeout = setTimeout(cancel, options.timeoutMs);
      try {
        for await (const event of run.stream()) {
          if (event.type === "usage") usageFromCursor(event.usage, output);
        }
      } finally {
        options?.signal?.removeEventListener("abort", cancel);
      }
      const result = await run.wait();
      usageFromCursor(result.usage ?? run.usage, output);
      endText();
      endReasoning();

      if (delegated) {
        output.stopReason = "toolUse";
      } else if (result.status === "cancelled") {
        throw new Error(options?.signal?.aborted ? "Cursor request cancelled." : "Cursor request timed out or was cancelled.");
      } else if (result.status === "error") {
        throw new Error(result.error?.message ?? "Cursor returned an unsuccessful run.");
      } else {
        if (output.content.length === 0 && result.result) textDelta(result.result);
        endText();
        output.stopReason = "stop";
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      endText();
      endReasoning();
      if (delegated) {
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatCursorError(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      }
      stream.end();
    } finally {
      if (timeout) clearTimeout(timeout);
      await disposeAgent(agent);
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  return stream;
}
