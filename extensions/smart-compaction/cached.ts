import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildSessionProjection, convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";

export type Payload = Record<string, unknown>;

/** The last main-agent request: the messages it sent, system prompt included, and the provider payload built from them. */
export interface CapturedRequest {
  messages: AgentMessage[];
  payload: Payload;
  model: Model<Api>;
  at: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Records each main-agent request. `context_with_system` fires only for the
 * agent's own requests, right before their payload is built, so one-off
 * requests from extensions are never mistaken for the conversation.
 */
export function captureRequests(pi: ExtensionAPI): { last(): CapturedRequest | undefined; forget(): void } {
  let pending: AgentMessage[] | undefined;
  let captured: CapturedRequest | undefined;
  const forget = () => {
    pending = undefined;
    captured = undefined;
  };
  pi.on("context_with_system", (event) => {
    pending = [...event.messages];
  });
  pi.on("before_provider_request", (event, ctx) => {
    const messages = pending;
    pending = undefined;
    if (messages && ctx.model && isPlainObject(event.payload)) {
      captured = { messages, payload: event.payload, model: ctx.model, at: Date.now() };
    }
  });
  pi.on("model_select", forget);
  pi.on("session_tree", forget);
  return { last: () => captured, forget };
}

function lastIndexOf(messages: readonly AgentMessage[], message: AgentMessage): number {
  for (let index = messages.length - 1; index >= 0; index--) if (sameMessage(messages[index]!, message)) return index;
  return -1;
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
  const left = a as any;
  const right = b as any;
  if (left.role !== right.role || left.timestamp !== right.timestamp) return false;
  return left.role !== "toolResult" || left.toolCallId === right.toolCallId;
}

/**
 * Messages the branch gained after the captured request. Messages a context
 * handler added to that request alone are skipped when matching; a branch
 * that no longer holds the request's messages returns a reason instead.
 */
export function messagesSince(branchEntries: readonly SessionEntry[], request: CapturedRequest): AgentMessage[] | string {
  const current = buildSessionProjection([...branchEntries]).messages.filter((message) => message.role !== "system");
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]!;
    if (message.role === "system") continue;
    const at = lastIndexOf(current, message);
    if (at >= 0) return current.slice(at + 1);
  }
  return "the last request's messages are no longer on this branch";
}

function preview(message: ReturnType<typeof convertToLlm>[number]): string | undefined {
  const content = (message as any).content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content) && (message.role === "user" || message.role === "assistant")) {
    text = content
      .flatMap((block: any) =>
        block?.type === "text" ? [block.text] : block?.type === "toolCall" ? [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`] : [],
      )
      .join("\n");
  }
  text = text?.trim();
  if (!text) return undefined;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** The opening of the first kept message as the model reads it, which marks where the checkpoint must stop. */
export interface KeptStart {
  text: string;
  /** Which kept message opening with `text` it is, counting back from the end (1 for the last). */
  fromEnd: number;
  /** Messages the request carries from the kept start on. */
  count: number;
}

export function keptStart(branchEntries: readonly SessionEntry[], firstKeptEntryId: string, sent: readonly AgentMessage[]): KeptStart | undefined {
  const projected = buildSessionProjection([...branchEntries]).entries;
  const start = projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
  if (start < 0) return undefined;
  let at = -1;
  for (const entry of projected.slice(start)) {
    if (entry.sourceEntry.type === "compaction") continue;
    for (const message of entry.messages) {
      at = lastIndexOf(sent, message);
      if (at >= 0) break;
    }
    if (at >= 0) break;
  }
  if (at < 0) return undefined;
  const previews = convertToLlm(sent.slice(at)).map(preview);
  const text = previews[0];
  if (!text) return undefined;
  return { text, fromEnd: previews.filter((value) => value === text).length, count: previews.length };
}

const OPEN = "<";
const KEPT_OPEN = `${OPEN}kept-start>`;
const KEPT_CLOSE = `${OPEN}/kept-start>`;
const FACTS_OPEN = `${OPEN}protected-facts>`;
const FACTS_CLOSE = `${OPEN}/protected-facts>`;
const PREVIOUS_TAG = `${OPEN}previous-summary>`;

/** Replaces a summary prompt's first paragraph, which describes a transcript the cached request does not have. */
function withLeadIn(prompt: string, leadIn: string): string {
  const end = prompt.indexOf("\n\n");
  return end < 0 ? `${leadIn}\n\n${prompt}` : `${leadIn}${prompt.slice(end)}`;
}

/**
 * The instruction that closes the cached summary request: stop at the kept
 * start, then the usual directives, protected facts, and checkpoint format.
 */
export function cachedInstruction(options: {
  kept: KeptStart;
  systemPrompt: string;
  initialPrompt: string;
  updatePrompt: string;
  hasPreviousCheckpoint: boolean;
  facts: readonly string[];
  customInstructions?: string;
  sanitize: (text: string) => string;
}): string {
  const { kept } = options;
  const repeated = kept.fromEnd > 1
    ? ` Several kept messages begin with this text; it is number ${kept.fromEnd} of them, counting back from the end.`
    : "";
  const toolCalls = kept.text.includes("[tool call: ") ? " Tool calls are written as [tool call: name arguments]." : "";
  const prompt = options.hasPreviousCheckpoint
    ? withLeadIn(
      options.updatePrompt,
      `The conversation above opens with an earlier checkpoint; it is the ${PREVIOUS_TAG} in the rules below. Merge the turns after it, up to the kept start, into that checkpoint using an intelligent Delta-Merge.`,
    )
    : withLeadIn(options.initialPrompt, "Produce a structured context checkpoint of the conversation above, up to the kept start.");
  const sections = [
    `Stop working on the task and do not call any tools. Write a context checkpoint of the conversation above for the agent that will continue this work. It will read your checkpoint followed by the last ${kept.count} messages of this conversation, which stay in context verbatim.`,
    `The kept messages start with the message that begins with the text in ${KEPT_OPEN} below.${repeated}${toolCalls}\n\n${KEPT_OPEN}\n${options.sanitize(kept.text)}\n${KEPT_CLOSE}`,
    "Cover only the conversation before that message, as if it ended right there. Work from that message on, including its tool calls, their results, and later replies, has not happened as far as the checkpoint knows: leave it out, or record it as the next step only if it was already planned.",
    options.systemPrompt,
    ...(options.facts.length > 0
      ? [`${FACTS_OPEN}\n${options.facts.map(options.sanitize).join("\n")}\n${FACTS_CLOSE}`]
      : []),
    prompt,
    ...(options.customInstructions?.trim()
      ? [`## Additional User Instructions:\n${options.sanitize(options.customInstructions.trim())}`]
      : []),
  ];
  return sections.join("\n\n");
}

const OUTPUT_LIMIT_FIELDS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"]);

function stable(value: unknown): string {
  // Cache breakpoints move to the newest message on every request; they are not cached content.
  return JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)) ?? "undefined";
}

/** Where two serialized values first differ, with a little of each from there. */
function differs(what: string, before: string, after: string): string {
  let at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  const from = Math.max(0, at - 20);
  return `${what} differs (last request: ${before.slice(from, at + 80)}; now: ${after.slice(from, at + 80)})`;
}

function isTrailingEffort(item: unknown): boolean {
  return isPlainObject(item) && (item.role === "system" || item.type === "configuration_update");
}

/**
 * The rebuilt payload, completed with top-level fields only the captured request
 * had (added by extensions earlier in the request chain), when it repeats the
 * captured request exactly up to its new items; otherwise where it differs.
 */
export function extendCapturedPayload(captured: Payload, rebuilt: unknown): Payload | string {
  if (!isPlainObject(rebuilt)) return "the provider payload is not an object";
  const key = ["input", "messages"].find((field) => Array.isArray(captured[field]));
  if (!key) return "the last request has no message list";
  const payload: Payload = { ...rebuilt };
  for (const field of Object.keys(captured)) if (!(field in payload)) payload[field] = captured[field];
  for (const field of new Set([...Object.keys(captured), ...Object.keys(payload)])) {
    if (field === key || OUTPUT_LIMIT_FIELDS.has(field)) continue;
    const [before, after] = [stable(captured[field]), stable(payload[field])];
    if (before !== after) return differs(`request field "${field}"`, before, after);
  }
  const before = captured[key] as unknown[];
  const after = payload[key];
  if (!Array.isArray(after)) return `the request has no "${key}" list`;
  let end = before.length;
  // The active effort rides after the cache breakpoint and moves behind new turns.
  while (end > 0 && isTrailingEffort(before[end - 1])) end--;
  if (after.length <= end) return "the request is not longer than the last one";
  for (let index = 0; index < end; index++) {
    const [was, now] = [stable(before[index]), stable(after[index])];
    if (was !== now) return differs(`message ${index}`, was, now);
  }
  return payload;
}
