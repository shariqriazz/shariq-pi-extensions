/**
 * Domain model for subagents.
 *
 * Everything downstream of the Pi backend (manager, tools, UI) speaks only
 * these types. The backend translates Pi session events into the normalized
 * `SubagentEvent` union.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";
import type { CapabilityMode, IsolationMode } from "./config.ts";
import type { WorktreeInfo } from "./worktree.ts";

export type BackendName = "pi";
export type SubagentOrigin = "model" | "btw" | "orchestration";

/** Pi thinking levels. Omitted means inherit the parent level. */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "error";

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface PeerAgent {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
}

export interface ParentBridge {
  notify(message: string): void;
  ask(question: string, signal?: AbortSignal): Promise<string>;
  /** Flat peer coordination routed by the main-thread manager. */
  listPeers(): ReadonlyArray<PeerAgent>;
  messagePeer(id: string, message: string): Promise<void>;
}

export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
  /** In-process bridge used by child-only message_parent/ask_parent tools. */
  readonly bridge?: ParentBridge;
  /** Parent pi model, for the pi backend's "inherit" default. */
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: string;
  /** Parent model registry; required by the pi backend to resolve models. */
  readonly modelRegistry?: ModelRegistry;
  /** Sanitized parent conversation selected by fork_turns. */
  readonly inheritedMessages?: ReadonlyArray<Message>;
  readonly parentSessionFile?: string;
}

export interface SpawnTask {
  readonly prompt: string;
  readonly title: string;
  /** Who started the run; user-owned asides never wake the parent model. */
  readonly origin: SubagentOrigin;
  readonly cwd: string;
  /** Pi model hint: "provider/model-id" or a bare model id. Omitted = inherit. */
  readonly model?: string;
  /** Pi thinking level. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Coarse tool capability policy, resolved from profile/persona/override. */
  readonly capability: CapabilityMode;
  readonly agentType: string;
  readonly persona?: string;
  readonly isolation: IsolationMode;
  readonly maxConcurrent: number;
  /** Independent concurrency pool. Ordinary subagents use `default`; orchestration uses one pool per project. */
  readonly concurrencyGroup?: string;
  readonly worktree?: WorktreeInfo;
  /** Existing child session to continue with a new prompt. */
  readonly resumeSessionFile?: string;
  /** Preserve a logical id when restoring a child from the persistent catalog. */
  readonly preferredId?: string;
  readonly parent: ParentContext;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  readonly origin: SubagentOrigin;
  /** Display label, e.g. "openai-codex/gpt-5.6-sol". */
  readonly modelLabel?: string;
  /** Context window capacity for utilization display, when known. */
  readonly contextWindow?: number;
  /** Pi child session file. */
  readonly sessionFilePath?: string;
  /** Native Pi child-session id, when available. */
  readonly nativeSessionId?: string;
  readonly agentType?: string;
  readonly persona?: string;
  readonly capability?: CapabilityMode;
  readonly isolation?: IsolationMode;
  readonly worktree?: WorktreeInfo;
  readonly concurrencyGroup?: string;
  readonly resumedFrom?: string;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
  // lifecycle (a session can run multiple turns via send())
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  // transcript building blocks
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  // bookkeeping
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      readonly tokens?: number;
      readonly contextWindow?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface PeerMessage {
  readonly id: string;
  readonly sentAt: number;
  readonly sender: string;
  readonly senderId?: string;
  readonly targetId: string;
  readonly targetTitle: string;
  readonly message: string;
  readonly status: "delivered" | "failed";
  readonly error?: string;
}

export interface SubagentSnapshot {
  readonly id: string;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  readonly usage: { readonly tokens?: number; readonly contextWindow?: number };
  readonly transcript: ReadonlyArray<TranscriptItem>;
  /** Streaming assistant buffers, cleared when the finalized message lands. */
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  /** Final text of the most recent completed run (v1 `finalOutput`). */
  readonly finalText: string;
  /** Count of finalized assistant messages (for check_agent). */
  readonly turns: number;
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
