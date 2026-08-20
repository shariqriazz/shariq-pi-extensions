import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

export type ForkTurns = "none" | "all" | number;

export function parseForkTurns(value: string | undefined): ForkTurns {
  const normalized = value?.trim().toLowerCase() || "none";
  if (normalized === "none") return "none";
  if (normalized === "all") return "all";
  const count = Number(normalized);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('fork_turns must be "none", "all", or a positive integer string.');
  }
  return count;
}

function sanitizeMessage(message: unknown): Message | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  if (role === "user") {
    const user = message as UserMessage;
    return { ...user, content: Array.isArray(user.content) ? user.content.filter((part) => part.type === "text" || part.type === "image") : user.content };
  }
  if (role === "assistant") {
    const assistant = message as AssistantMessage;
    const content = assistant.content.filter((part) => part.type === "text");
    if (content.length === 0) return undefined;
    return { ...assistant, content, stopReason: "stop", errorMessage: undefined };
  }
  return undefined;
}

/**
 * Fork only conversational user/final-text history. Tool calls, tool results,
 * and thinking are deliberately excluded so the child never inherits an
 * unresolved protocol exchange or private reasoning.
 */
export function forkConversation(messages: readonly unknown[], mode: ForkTurns): Message[] {
  if (mode === "none") return [];
  const sanitized = messages.map(sanitizeMessage).filter((message): message is Message => !!message);
  if (mode === "all") return sanitized;

  let usersSeen = 0;
  let start = sanitized.length;
  for (let index = sanitized.length - 1; index >= 0; index--) {
    if (sanitized[index]?.role !== "user") continue;
    usersSeen++;
    start = index;
    if (usersSeen >= mode) break;
  }
  return sanitized.slice(start);
}

export function buildTaskPrompt(message: string, instructions: string, persona?: string) {
  if (!instructions.trim()) return message;
  const label = persona ? `Profile instructions with persona "${persona}"` : "Profile instructions";
  return `<subagent_instructions>\n${label}:\n${instructions.trim()}\n</subagent_instructions>\n\nTask:\n${message}`;
}
