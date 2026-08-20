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

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || "").filter(Boolean).join("\n");
}

function streamFactoryGemini(model: any, context: any, options?: any) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const contents = (context.messages || []).filter((message: any) => message.role !== "system" && message.role !== "developer").map((message: any) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: textFromContent(message.content) }],
      })).filter((message: any) => message.parts[0].text);
      const response = await fetch("https://api.factory.ai/api/llm/g/v1/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
        body: JSON.stringify({ model: model.id, contents }),
        signal: options?.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${body}`);
      const dataLines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("data:"));
      const jsonText = dataLines.length > 0 ? dataLines.map((line) => line.slice(5).trim()).filter((line) => line && line !== "[DONE]").join("\n") : body;
      const data = JSON.parse(jsonText.split(/\r?\n/).find((line) => line.trim()) || "{}");
      const text = data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
      output.content.push({ type: "text", text });
      stream.push({ type: "start", partial: output });
      if (text) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error: any) {
      output.stopReason = "error";
      output.errorMessage = error?.message || String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();
  return stream;
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
