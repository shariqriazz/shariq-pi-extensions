import {
  createAssistantMessageEventStream,
  stream,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import { factoryApiForModel } from "./models.ts";

export const FACTORY_SYSTEM_MARKER = "You are Droid, an AI software engineering agent built by Factory.";

const BLOCKED_PI_PROMPT_PHRASES: Array<[RegExp, string]> = [
  [
    /You are an expert coding assistant operating inside pi, a coding agent harness\./g,
    "You are an expert coding assistant running in Pi.",
  ],
];

function sanitizeText(text: string) {
  let sanitized = text;
  for (const [pattern, replacement] of BLOCKED_PI_PROMPT_PHRASES) sanitized = sanitized.replace(pattern, replacement);
  return sanitized;
}

function sanitizeContent(content: any): any {
  if (typeof content === "string") return sanitizeText(content);
  if (Array.isArray(content)) return content.map(sanitizeContent);
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return { ...content, text: sanitizeText(content.text) };
    return content;
  }
  return content;
}

export function sanitizeFactoryContext(context: any) {
  const messages = Array.isArray(context?.messages)
    ? context.messages.map((message: any) => {
        if (message?.role !== "system" && message?.role !== "developer") return message;
        return { ...message, content: sanitizeContent(message.content) };
      })
    : context?.messages;
  const sanitizedPrompt = typeof context?.systemPrompt === "string" ? sanitizeText(context.systemPrompt) : "";
  const systemPrompt = sanitizedPrompt.startsWith(FACTORY_SYSTEM_MARKER)
    ? sanitizedPrompt
    : `${FACTORY_SYSTEM_MARKER}${sanitizedPrompt ? `\n\n${sanitizedPrompt}` : ""}`;
  return { ...context, systemPrompt, messages };
}

function optionsWithDirectReasoningEffort(options: any) {
  const reasoning = options?.reasoning;
  return {
    ...options,
    reasoningEffort: reasoning && reasoning !== "off" ? reasoning : undefined,
  };
}

function messageText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function convertFactoryGeminiMessages(context: any): any[] {
  const contents: any[] = [];
  for (const message of context.messages ?? []) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
      const parts = blocks.flatMap((part: any) => {
        if (part?.type === "text" && typeof part.text === "string") return [{ text: part.text }];
        if (part?.type === "image" && typeof part.data === "string") {
          return [{ inlineData: { mimeType: part.mimeType ?? "image/png", data: part.data } }];
        }
        return [];
      });
      if (parts.length > 0) contents.push({ role: "user", parts });
      continue;
    }
    if (message.role === "assistant") {
      const parts = (message.content ?? []).flatMap((part: any) => {
        if (part?.type === "text" && typeof part.text === "string") return [{ text: part.text }];
        if (part?.type === "thinking" && typeof part.thinking === "string") return [{ text: part.thinking, thought: true }];
        if (part?.type === "toolCall") {
          return [{ functionCall: { id: part.id, name: part.name, args: part.arguments ?? {} }, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) }];
        }
        return [];
      });
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    if (message.role === "toolResult") {
      const responseText = messageText(message.content);
      const part = {
        functionResponse: {
          id: message.toolCallId,
          name: message.toolName,
          response: message.isError ? { error: responseText } : { output: responseText },
        },
      };
      const previous = contents.at(-1);
      if (previous?.role === "user" && previous.parts?.some((item: any) => item.functionResponse)) previous.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return contents;
}

function factoryGeminiTools(tools: any[] | undefined) {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];
}

async function forEachFactoryGeminiEvent(response: Response, visit: (event: any) => void) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    const parsed = JSON.parse(await response.text());
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) visit(event);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = done ? "" : lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data && data !== "[DONE]") visit(JSON.parse(data));
    }
    if (done) break;
  }
  const trailing = pending.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") visit(JSON.parse(data));
  }
}

let factoryGeminiToolCallCounter = 0;

export function streamFactoryGemini(model: any, context: any, options?: any) {
  const eventStream = createAssistantMessageEventStream();
  (async () => {
    const output: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    let currentBlock: any;
    const finishBlock = () => {
      if (!currentBlock) return;
      const contentIndex = output.content.indexOf(currentBlock);
      if (currentBlock.type === "thinking") {
        eventStream.push({ type: "thinking_end", contentIndex, content: currentBlock.thinking, partial: output });
      } else {
        eventStream.push({ type: "text_end", contentIndex, content: currentBlock.text, partial: output });
      }
      currentBlock = undefined;
    };
    try {
      let payload: any = {
        model: model.id,
        contents: convertFactoryGeminiMessages(context),
        ...(context.systemPrompt ? { systemInstruction: { parts: [{ text: context.systemPrompt }] } } : {}),
        ...(context.tools?.length ? { tools: factoryGeminiTools(context.tools) } : {}),
        generationConfig: {
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        },
      };
      const transformed = await options?.onPayload?.(payload, model);
      if (transformed !== undefined) payload = transformed;
      const baseUrl = String(model.baseUrl || "https://api.factory.ai/api/llm/g/v1").replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
        body: JSON.stringify(payload),
        signal: options?.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      eventStream.push({ type: "start", partial: output });
      await forEachFactoryGeminiEvent(response, (chunk) => {
        const candidate = chunk?.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === "string") {
            const blockType = part.thought === true ? "thinking" : "text";
            if (!currentBlock || currentBlock.type !== blockType) {
              finishBlock();
              currentBlock = blockType === "thinking"
                ? { type: "thinking", thinking: "", thinkingSignature: part.thoughtSignature }
                : { type: "text", text: "", textSignature: part.thoughtSignature };
              output.content.push(currentBlock);
              eventStream.push({ type: `${blockType}_start`, contentIndex: output.content.length - 1, partial: output });
            }
            if (blockType === "thinking") {
              currentBlock.thinking += part.text;
              currentBlock.thinkingSignature ||= part.thoughtSignature;
              eventStream.push({ type: "thinking_delta", contentIndex: output.content.length - 1, delta: part.text, partial: output });
            } else {
              currentBlock.text += part.text;
              currentBlock.textSignature ||= part.thoughtSignature;
              eventStream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta: part.text, partial: output });
            }
          }
          if (part.functionCall) {
            finishBlock();
            const toolCall = {
              type: "toolCall" as const,
              id: part.functionCall.id || `${part.functionCall.name}_${Date.now()}_${++factoryGeminiToolCallCounter}`,
              name: part.functionCall.name || "",
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            };
            output.content.push(toolCall);
            const contentIndex = output.content.length - 1;
            eventStream.push({ type: "toolcall_start", contentIndex, partial: output });
            eventStream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
            eventStream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
          }
        }
        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason;
          output.stopReason = candidate.finishReason === "MAX_TOKENS" ? "length" : candidate.finishReason === "STOP" ? "stop" : "error";
        }
        if (chunk?.usageMetadata) {
          const usage = chunk.usageMetadata;
          output.usage = {
            input: (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
            output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
            cacheRead: usage.cachedContentTokenCount ?? 0,
            cacheWrite: 0,
            reasoning: usage.thoughtsTokenCount ?? 0,
            totalTokens: usage.totalTokenCount ?? 0,
            cost: output.usage.cost,
          };
        }
      });
      finishBlock();
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (output.content.some((part: any) => part.type === "toolCall") && output.stopReason === "stop") output.stopReason = "toolUse";
      if (output.stopReason === "pending") throw new Error("Factory Gemini stream ended without a finish reason");
      if (output.stopReason === "error") throw new Error(`Provider stopped with: ${output.rawStopReason ?? "unknown"}`);
      eventStream.push({ type: "done", reason: output.stopReason, message: output });
      eventStream.end();
    } catch (error: any) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error?.message || String(error);
      eventStream.push({ type: "error", reason: output.stopReason, error: output });
      eventStream.end();
    }
  })();
  return eventStream;
}

export function streamSimpleFactoryResponses(model: any, context: any, options?: any) {
  const api = factoryApiForModel(model.id);
  const routedModel = { ...model, api };
  let sanitizedContext = sanitizeFactoryContext(context);
  if (api === "anthropic-messages") {
    // Factory's Anthropic surface currently rejects requests with a system prompt
    // for these OAuth-routed models. Keep user/developer conversation messages,
    // but omit Pi's system prompt.
    sanitizedContext = { ...sanitizedContext, systemPrompt: undefined };
  }
  switch (api) {
    case "anthropic-messages":
      return streamSimple(routedModel, sanitizedContext, options);
    case "google-generative-ai":
      return streamFactoryGemini(routedModel, sanitizedContext, options);
    case "openai-completions":
      return stream(routedModel, sanitizedContext, optionsWithDirectReasoningEffort(options));
    case "openai-responses":
    default:
      return streamSimple(routedModel, sanitizedContext, options);
  }
}
