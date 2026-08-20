import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedSession, ProjectIdentity } from "./types.ts";
import { redactSecrets, sanitizeToolArguments } from "./redaction.ts";

type EntryLike = {
  id?: unknown;
  type?: unknown;
  summary?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
};

type ContentBlock = {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  arguments?: unknown;
};

const MEMORY_ELIGIBLE_TOOLS = new Set([
  "read", "write", "edit", "bash", "grep", "find", "ls",
  "start_terminal", "read_terminal", "write_terminal", "stop_terminal",
  "spawn_agent", "task", "wait_agent", "check_agent", "send_message", "reply_question",
]);

export function isMemoryEligibleTool(toolName: string): boolean {
  return MEMORY_ELIGIBLE_TOOLS.has(toolName);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is ContentBlock => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

function serializeEntry(entry: EntryLike): string | undefined {
  const id = typeof entry.id === "string" ? entry.id : "unknown";
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return `[${id}] Compaction summary:\n${redactSecrets(entry.summary).slice(0, 8_000)}`;
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return `[${id}] Branch summary:\n${redactSecrets(entry.summary).slice(0, 8_000)}`;
  }
  if (entry.type !== "message" || !entry.message) return undefined;

  const role = entry.message.role;
  if (role === "user") {
    const text = redactSecrets(textContent(entry.message.content)).trim();
    return text ? `[${id}] User:\n${text}` : undefined;
  }
  if (role === "assistant") {
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
    const parts: string[] = [];
    const text = redactSecrets(textContent(blocks)).trim();
    if (text) parts.push(text);
    for (const rawBlock of blocks) {
      if (typeof rawBlock !== "object" || rawBlock === null) continue;
      const block = rawBlock as ContentBlock;
      if (block.type === "toolCall" && typeof block.name === "string" && isMemoryEligibleTool(block.name)) {
        parts.push(`Tool call ${block.name}: ${sanitizeToolArguments(block.name, block.arguments)}`);
      }
    }
    return parts.length > 0 ? `[${id}] Assistant:\n${parts.join("\n")}` : undefined;
  }
  if (role === "toolResult") {
    const toolName = typeof entry.message.toolName === "string" ? entry.message.toolName : "unknown";
    if (!isMemoryEligibleTool(toolName)) return undefined;
    const text = redactSecrets(textContent(entry.message.content)).trim().slice(0, 3_000);
    if (!text) return undefined;
    return `[${id}] Tool result ${toolName}${entry.message.isError ? " (error)" : ""}:\n${text}`;
  }
  return undefined;
}

export function captureSession(
  ctx: Pick<ExtensionContext, "sessionManager">,
  project: ProjectIdentity,
  checkpointLeafId: string | undefined,
  maxCharacters: number,
): CapturedSession | undefined {
  const branch = ctx.sessionManager.getBranch() as EntryLike[];
  const leaf = branch.at(-1);
  const leafId = typeof leaf?.id === "string" ? leaf.id : undefined;
  if (!leafId || leafId === checkpointLeafId) return undefined;

  const checkpointIndex = checkpointLeafId ? branch.findIndex((entry) => entry.id === checkpointLeafId) : -1;
  const firstNewIndex = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
  const contextStart = Math.max(0, firstNewIndex - 4);
  const selected = branch.slice(contextStart);
  const newSerialized = branch.slice(firstNewIndex)
    .map((entry) => ({ entry, text: serializeEntry(entry) }))
    .filter((item): item is { entry: EntryLike & { id: string }; text: string } => typeof item.entry.id === "string" && Boolean(item.text));
  if (newSerialized.length === 0) return undefined;
  const entryIds = newSerialized.map((item) => item.entry.id);

  const serialized = selected.map(serializeEntry).filter((value): value is string => Boolean(value));
  if (serialized.length === 0) return undefined;
  let transcript = serialized.join("\n\n");
  if (transcript.length > maxCharacters) transcript = `[older content omitted]\n\n${transcript.slice(-maxCharacters)}`;

  const queryText = redactSecrets(branch.slice(firstNewIndex)
    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
    .map((entry) => textContent(entry.message?.content))
    .join("\n"))
    .slice(0, 8_000);

  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? "ephemeral",
    project,
    leafId,
    entryIds,
    transcript,
    queryText,
    capturedAt: Date.now(),
  };
}
