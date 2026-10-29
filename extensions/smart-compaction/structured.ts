/**
 * Same-model structured tail for the compaction request.
 *
 * When the summarizer is the model that wrote the turns being summarized, the
 * newest of those turns are sent as the original messages, thinking blocks and
 * signatures included, so the model reads its own reasoning while it writes the
 * checkpoint. Older turns stay in the text transcript. Pi keeps a thinking block
 * only when the message's provider, API, and model match the request's model, so
 * the window stops at any turn from another model.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/** Ceiling for the structured messages and their tool definitions. */
export const STRUCTURED_MAX_BYTES = 2_500_000;
/** Ceiling for the whole estimated request, well under gateway body limits of about 4.5 MB. */
export const REQUEST_MAX_BYTES = 3_500_000;

/** Tool definition as Pi reports it through `pi.getAllTools()`. */
export interface ToolDefinitionSource {
  name: string;
  description: string;
  parameters: unknown;
}

export interface StructuredTail {
  /** First summarized message sent in structured form. */
  start: number;
  /** End of the structured window (exclusive); later summarized messages stay text. */
  end: number;
  messages: Message[];
  tools: Tool[];
  /** Estimated bytes of the structured messages and tool definitions. */
  bytes: number;
}

// Messages Pi converts to user, assistant, or tool-result messages. Anything else
// (system patches, branch or compaction summaries) stays in the text transcript.
const STRUCTURED_ROLES = new Set(["user", "assistant", "toolResult", "custom", "bashExecution"]);
// A window may start at any of these, never at a tool result whose call precedes it.
const START_ROLES = new Set(["user", "assistant", "custom", "bashExecution"]);

/** JSON size in bytes, or undefined when the value cannot be measured. */
export function byteSize(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}

function fromModel(message: any, model: Model<Api>): boolean {
  return message.provider === model.provider && message.api === model.api && message.model === model.id;
}

function toolCalls(message: any): Array<{ id: string; name: string }> {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((block: any) => block?.type === "toolCall" && typeof block.name === "string");
}

function hasSignedThinking(message: any): boolean {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (block: any) =>
        block?.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature,
    )
  );
}

/**
 * The newest summarized turns that can go to `model` in structured form, or
 * undefined when nothing qualifies: no signed thinking from this model in the
 * window, or a message that cannot be measured.
 */
export function selectStructuredTail(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  toolSources: readonly ToolDefinitionSource[] = [],
  maxBytes = STRUCTURED_MAX_BYTES,
): StructuredTail | undefined {
  // End at a complete turn: an assistant message whose tool calls are answered
  // only in the kept part stays text, so Pi does not invent a "No result provided".
  let end = messages.length;
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (toolCalls(messages[index]).length > 0) {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant >= 0) {
    const answered = new Set(
      messages
        .slice(lastAssistant + 1)
        .flatMap((message: any) => (message.role === "toolResult" ? [message.toolCallId] : [])),
    );
    if (toolCalls(messages[lastAssistant]).some((call) => !answered.has(call.id))) end = lastAssistant;
  }

  let start = end;
  let bytes = 0;
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index] as any;
    if (!STRUCTURED_ROLES.has(message?.role)) break;
    if (message.role === "assistant" && !fromModel(message, model)) break;
    const size = byteSize(message);
    if (size === undefined) return undefined;
    if (bytes + size > maxBytes) break;
    bytes += size;
    if (START_ROLES.has(message.role)) start = index;
  }
  if (start >= end) return undefined;

  const window = messages.slice(start, end);
  if (!window.some(hasSignedThinking)) return undefined;
  // Recount the final window: the walk may have measured tool results before its first start.
  const windowBytes = window.reduce((total, message) => total + (byteSize(message) ?? 0), 0);

  // Providers reject tool calls and results without matching definitions.
  const names = new Set(window.flatMap((message) => toolCalls(message).map((call) => call.name)));
  const sources = new Map(toolSources.map((source) => [source.name, source]));
  const tools: Tool[] = [...names].map((name) => {
    const source = sources.get(name);
    return {
      name,
      description: source?.description ?? "Tool used earlier in this session.",
      parameters: (source?.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
    };
  });
  const toolBytes = byteSize(tools);
  if (toolBytes === undefined || windowBytes + toolBytes > maxBytes) return undefined;

  // Window bytes were measured on the stored messages, which carry the same
  // content and signatures as the converted ones plus session-only fields.
  return { start, end, messages: convertToLlm(window as AgentMessage[]), tools, bytes: windowBytes + toolBytes };
}
