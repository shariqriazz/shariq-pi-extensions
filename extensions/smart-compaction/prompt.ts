import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const SMART_COMPACTION_SYSTEM_PROMPT = `You are a high-fidelity context continuity synthesizer for an autonomous coding agent.
Your task is to analyze the preceding conversation and produce a comprehensive, structured checkpoint summary.
The successor agent will rely SOLELY on your summary to resume complex engineering tasks without losing context, nuance, or mid-stream progress.

CRITICAL DIRECTIVES:
1. Preserve exact file paths, shell commands, and error messages verbatim.
2. Include actual code snippets for active work or uncommitted changes—never just describe what code was changed.
3. Explicitly maintain all user-stated negative constraints (e.g., "do not modify X", "never use Y").
4. Do NOT execute tools or continue the conversation. Respond ONLY with the requested structured summary.`;

export const SMART_COMPACTION_INITIAL_PROMPT = `Analyze the conversation in the <conversation> tags above and produce a structured context checkpoint summary.

Use this EXACT format and include all numbered sections:

## 1. Primary Goal & Nuanced Intent
- **Objective**: Detailed statement of what the user is trying to accomplish.
- **Constraints & Preferences**: All explicit user constraints, negative rules, styling conventions, and architectural boundaries (or "(none)").

## 2. Progress Ledger
### Done
- [x] [Completed task, file modification, or command]

### In Progress
- [ ] [Active task or mid-stream operation]

### Blocked / Open Issues
- [Any active errors, blockers, or pending decisions]

## 3. Code Changes & In-Progress Snippets
For every modified, created, or in-flight file:
- **\`path/to/file\`**: State why it was changed and provide verbatim code snippets of the latest edits or new functions so work can resume immediately without re-reading.

## 4. Errors, Root Causes & Fixes
- **Error**: [Verbatim error message or failed command output]
- **Root Cause**: [Exact reason for the failure]
- **Fix**: [How it was fixed or the approach currently being attempted]
(Or "None" if no errors occurred)

## 5. Key Decisions & Hypotheses
- **[Decision / Architecture]**: [Rationale, alternatives considered, and discarded approaches]

## 6. Resume Anchor & Immediate Next Action
- **Last State**: Precisely what was happening before this summary request.
- **Next Concrete Step**: The single immediate next action to take, directly aligned with the user's latest request.

Keep the prose economical and high-density. Do NOT pad with fluff.`;

export const SMART_COMPACTION_UPDATE_PROMPT = `The <conversation> tags above contain NEW conversation turns that occurred after the checkpoint in <previous-summary>.
Synthesize the new turns into the existing summary using a unified Delta-Merge.

DELTA-MERGING RULES:
1. PRESERVE all historical goals, constraints, and decisions from <previous-summary>.
2. UPDATE the Progress Ledger: check off items that have finished and add new in-flight tasks.
3. ACCUMULATE Code Changes: add new code snippets for newly modified files while retaining existing relevant snippets.
4. RECORD new errors, root causes, and resolutions encountered in the new turns.
5. UPDATE the Resume Anchor and Next Step to reflect the current active frontier.
6. PRESERVE exact file paths, commands, and code snippets verbatim.

Use this EXACT format:

## 1. Primary Goal & Nuanced Intent
- **Objective**: [Preserve initial goal, add new objectives if scope expanded]
- **Constraints & Preferences**: [Preserve existing constraints, add newly stated ones]

## 2. Progress Ledger
### Done
- [x] [Previously completed items AND newly completed items]

### In Progress
- [ ] [Current active tasks]

### Blocked / Open Issues
- [Active blockers or "None"]

## 3. Code Changes & In-Progress Snippets
[Accumulated modified/created files with verbatim code snippets of recent work]

## 4. Errors, Root Causes & Fixes
[Accumulated errors, root causes, and fixes from the full session]

## 5. Key Decisions & Hypotheses
[Accumulated architectural decisions and trade-offs]

## 6. Resume Anchor & Immediate Next Action
- **Last State**: [Exact state immediately before this checkpoint]
- **Next Concrete Step**: [The single immediate next action]`;

const MAX_TOOL_RESULT_CHARS = 2500;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const remaining = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${remaining} characters truncated for summary ...]`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function serializeConversationForCompaction(messages: AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextContent((msg as any).content);
      if (text) parts.push(`[User]:\n${text}`);
    } else if (msg.role === "assistant") {
      const content = (msg as any).content;
      const thinkingBlocks: string[] = [];
      const toolCallBlocks: string[] = [];
      const textBlocks: string[] = [];

      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            thinkingBlocks.push(block.thinking.trim());
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            textBlocks.push(block.text.trim());
          } else if (block.type === "toolCall") {
            const args = block.arguments as Record<string, unknown>;
            const formattedArgs = Object.entries(args ?? {})
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            toolCallBlocks.push(`${block.name}(${formattedArgs})`);
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        textBlocks.push(content.trim());
      }

      if (thinkingBlocks.length > 0) {
        const combinedThinking = thinkingBlocks.join("\n");
        parts.push(`[Assistant Thinking]:\n${truncateText(combinedThinking, 1500)}`);
      }
      if (textBlocks.length > 0) {
        parts.push(`[Assistant]:\n${textBlocks.join("\n")}`);
      }
      if (toolCallBlocks.length > 0) {
        parts.push(`[Assistant Tool Calls]:\n${toolCallBlocks.join("\n")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = extractTextContent((msg as any).content);
      if (text) {
        parts.push(`[Tool Result]:\n${truncateText(text, MAX_TOOL_RESULT_CHARS)}`);
      }
    } else if (msg.role === "custom") {
      const text = extractTextContent((msg as any).content);
      if (text) parts.push(`[System Event]:\n${text}`);
    } else if (msg.role === "bashExecution") {
      const cmd = (msg as any).command ?? "";
      const out = (msg as any).output ?? "";
      parts.push(`[Command Executed]:\n$ ${cmd}\n${truncateText(out, 1500)}`);
    } else if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
      const summary = (msg as any).summary ?? "";
      if (summary) parts.push(`[Prior Summary]:\n${summary}`);
    }
  }

  return parts.join("\n\n---\n\n");
}

export function formatFileOperationsXml(fileOps?: { read?: Iterable<string>; written?: Iterable<string>; edited?: Iterable<string> }): string {
  if (!fileOps) return "";
  const readSet = new Set(fileOps.read ?? []);
  const modifiedSet = new Set([...(fileOps.written ?? []), ...(fileOps.edited ?? [])]);
  const readOnly = [...readSet].filter((f) => !modifiedSet.has(f)).sort();
  const modified = [...modifiedSet].sort();

  const sections: string[] = [];
  if (readOnly.length > 0) {
    sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  }
  if (modified.length > 0) {
    sections.push(`<modified-files>\n${modified.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}
