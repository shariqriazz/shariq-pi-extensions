/**
 * Pi-only subagents behind one Effect-managed runtime and one canonical tool
 * surface. In-process Pi child sessions inherit local tools/config, deliver
 * results asynchronously, and can be inspected or taken over through the
 * `/subagents` dashboard.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  sessionEntryToContextMessages,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { settlementDelivery } from "../shared/settlement-delivery.ts";
import {
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type PeerMessage,
  type SpawnTask,
  type SubagentOrigin,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
  WORKTREE_ISOLATION_DESCRIPTION,
} from "./src/prompt.ts";
import {
  CAPABILITY_MODES,
  ISOLATION_MODES,
  loadConfigDocument,
  loadSubagentConfig,
  resolveProfile,
  saveConfigDocument,
  type CapabilityMode,
  type ConfigScope,
  type IsolationMode,
} from "./src/config.ts";
import { buildTaskPrompt, forkConversation, parseForkTurns } from "./src/context.ts";
import {
  applyAgentWorktree,
  applyAgentWorktreeTo,
  createAgentWorktree,
  discardAgentWorktree,
  inspectAgentWorktree,
  integrateAgentWorktree,
  WORKTREE_ACTIONS,
  type WorktreeAction,
  type WorktreeInfo,
} from "./src/worktree.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import {
  openPeerMessageViewer,
  openSubagentPicker,
  openSubagentTakeover,
} from "./src/ui/takeover.ts";
import {
  isCoordinatorRequest,
  SUBAGENT_COORDINATOR_REQUEST,
  type SubagentCoordinator,
} from "./src/coordinator.ts";
import {
  allocateSubagentId,
  loadSubagentCatalog,
  upsertSubagentCatalog,
  type ArchivedSubagent,
} from "./src/catalog.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
const SUBAGENT_RECORD_TYPE = "pi-subagent-record";
const SUBAGENT_PEER_MESSAGE_TYPE = "pi-subagent-peer-message";
const BTW_ENTRY_TYPE = "pi-subagent-btw-result";
const BTW_TITLE_MAX_LENGTH = 60;

interface BtwEntryData {
  id: string;
  title: string;
  status: SubagentSnapshot["status"];
  answer: string;
  errorText?: string;
}

interface WaitAgentDetails {
  pendingQuestions: string[];
  results: Array<{
    id: string;
    title: string;
    status: SubagentSnapshot["status"];
  }>;
  pending: string[];
}

function waitAgentDetails(
  values: Partial<WaitAgentDetails> = {},
): WaitAgentDetails {
  return {
    pendingQuestions: values.pendingQuestions ?? [],
    results: values.results ?? [],
    pending: values.pending ?? [],
  };
}

export function deriveBtwTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim())?.trim().replace(/\s+/g, " ") ?? "";
  if (!firstLine) return "by the way";
  const codePoints = [...firstLine];
  return codePoints.length <= BTW_TITLE_MAX_LENGTH
    ? firstLine
    : `${codePoints.slice(0, BTW_TITLE_MAX_LENGTH - 1).join("")}…`;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    snap.meta.modelLabel ?? "?",
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const deliverSettlement = settlementDelivery(pi);
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const archived = new Map<string, ArchivedSubagent>();
  const peerHistory: PeerMessage[] = [];
  const pendingQuestions = new Map<
    string,
    {
      title: string;
      question: string;
      resolve: (reply: string) => void;
      reject: (error: Error) => void;
    }
  >();
  const pendingQuestionText = () =>
    [...pendingQuestions.entries()]
      .map(([id, pending]) => `- ${pending.title}: ${pending.question} (question_id: ${id})`)
      .join("\n");

  const parentBridge = (
    title: string,
    manager: SubagentManagerShape,
    senderId: string,
  ) => ({
    notify(message: string) {
      pi.sendMessage(
        {
          customType: "subagent-parent-message",
          content: `Pi subagent "${title}" sent an update:\n\n${message}`,
          display: true,
          details: { title, kind: "message" },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
    listPeers() {
      return manager.view.list().map((peer) => ({
        id: peer.id,
        title: peer.title,
        status: peer.status,
      }));
    },
    async messagePeer(id: string, message: string) {
      const target = manager.view.get(id);
      if (!target) throw new Error(`Unknown peer agent "${id}".`);
      const base = {
        id: randomUUID(),
        sentAt: Date.now(),
        sender: title,
        senderId,
        targetId: id,
        targetTitle: target.title,
        message: message.trim(),
      } as const;
      try {
        await runTool(
          getRuntime(),
          manager.send(id, `[Peer agent "${title}"] ${message.trim()}`),
        );
        const record: PeerMessage = { ...base, status: "delivered" };
        manager.view.recordPeerMessage(record);
        peerHistory.push(record);
        pi.appendEntry(SUBAGENT_PEER_MESSAGE_TYPE, record);
      } catch (error) {
        const record: PeerMessage = {
          ...base,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        manager.view.recordPeerMessage(record);
        peerHistory.push(record);
        pi.appendEntry(SUBAGENT_PEER_MESSAGE_TYPE, record);
        throw error;
      }
    },
    ask(question: string, signal?: AbortSignal) {
      const id = randomUUID();
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Parent question aborted."));
          return;
        }
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const onAbort = () => {
          pendingQuestions.delete(id);
          cleanup();
          reject(new Error("Parent question aborted."));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pendingQuestions.set(id, {
          title,
          question,
          resolve: (reply) => {
            cleanup();
            resolve(reply);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        });
        pi.sendMessage(
          {
            customType: "subagent-parent-message",
            content:
              `Pi subagent "${title}" is blocked and asks:\n\n${question}\n\n` +
              `Reply with reply_question(question_id: "${id}", reply: "...").`,
            display: true,
            details: { title, kind: "question", questionId: id },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      });
    },
  });

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        for (const message of peerHistory) manager.view.recordPeerMessage(message);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const persistSnapshot = (snap: SubagentSnapshot) => {
    const sessionFile = snap.meta.sessionFilePath;
    if (!sessionFile) return;
    const record: ArchivedSubagent = {
      id: snap.id,
      title: snap.title,
      cwd: snap.cwd,
      status: snap.status,
      sessionFile,
      model: snap.meta.modelLabel,
      agentType: snap.meta.agentType,
      persona: snap.meta.persona,
      capability: snap.meta.capability,
      isolation: snap.meta.isolation,
      worktree: snap.meta.worktree,
      updatedAt: Date.now(),
    };
    archived.set(record.id, record);
    upsertSubagentCatalog(record);
    pi.appendEntry(SUBAGENT_RECORD_TYPE, record);
  };

  interface SpawnOptions {
    message: string;
    taskName?: string;
    cwd?: string;
    model?: string;
    thinking?: (typeof REASONING_EFFORTS)[number];
    readonly?: boolean;
    agentType?: string;
    persona?: string;
    capability?: CapabilityMode;
    isolation?: IsolationMode;
    forkTurns?: string;
    resumeFrom?: string;
    origin?: SubagentOrigin;
    concurrencyGroup?: string;
    maxConcurrent?: number;
  }

  interface PreparedSpawn {
    task?: SpawnTask;
    resumed?: SubagentSnapshot;
    cleanup(): Promise<void>;
  }

  const preparePiAgent = async (
    manager: SubagentManagerShape,
    ctx: ExtensionContext,
    options: SpawnOptions,
  ): Promise<PreparedSpawn> => {
    const config = loadSubagentConfig(ctx.cwd, ctx.isProjectTrusted());
    const profile = resolveProfile(config, {
      agentType: options.agentType,
      persona: options.persona,
      capability: options.readonly ? "read-only" : options.capability,
      model: options.model,
      thinking: options.thinking,
      isolation: options.isolation,
    });
    const liveSource = options.resumeFrom ? manager.view.get(options.resumeFrom) : undefined;
    const archivedSource = options.resumeFrom ? archived.get(options.resumeFrom) : undefined;
    const title =
      options.taskName?.trim().slice(0, 160) ||
      liveSource?.title ||
      archivedSource?.title ||
      profile.agentType;
    if (liveSource?.status === "running") {
      throw new Error(`Cannot resume running subagent "${options.resumeFrom}"; use send_message instead.`);
    }
    if (liveSource) {
      await runTool(
        getRuntime(),
        manager.send(liveSource.id, buildTaskPrompt(options.message, profile.instructions, profile.persona)),
      );
      return { resumed: manager.view.get(liveSource.id)!, cleanup: async () => {} };
    }
    const resumeSessionFile = archivedSource?.sessionFile;
    if (options.resumeFrom && (!resumeSessionFile || !fs.existsSync(resumeSessionFile))) {
      throw new Error(`Unknown or unavailable resumable subagent "${options.resumeFrom}".`);
    }

    let cwd = path.resolve(ctx.cwd, options.cwd ?? ".");
    const resumedWorktree = archivedSource?.worktree;
    if (resumeSessionFile) cwd = resumedWorktree?.path ?? archivedSource?.cwd ?? cwd;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
    if (
      profile.isolation === "worktree" &&
      options.cwd &&
      !resumeSessionFile &&
      options.origin !== "orchestration"
    ) {
      throw new Error('cwd and isolation="worktree" are mutually exclusive.');
    }

    let worktree = resumedWorktree;
    let createdWorktree = false;
    if (profile.isolation === "worktree" && !worktree) {
      worktree = await createAgentWorktree(
        (command, args, execOptions) => pi.exec(command, args, execOptions),
        cwd,
        title,
      );
      cwd = worktree.path;
      createdWorktree = true;
    }
    const cleanup = async () => {
      if (createdWorktree && worktree) {
        await discardAgentWorktree(
          (command, args, execOptions) => pi.exec(command, args, execOptions),
          worktree,
        ).catch(() => undefined);
      }
    };
    const preferredId = resumeSessionFile ? options.resumeFrom! : allocateSubagentId();
    const inheritedMessages = resumeSessionFile
      ? []
      : forkConversation(
          ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages),
          parseForkTurns(options.forkTurns),
        );
    return {
      cleanup,
      task: {
        prompt: buildTaskPrompt(options.message, profile.instructions, profile.persona),
        title,
        origin: options.origin ?? "model",
        cwd,
        model: resumeSessionFile ? options.model : profile.model,
        reasoningEffort: resumeSessionFile ? options.thinking : profile.thinking,
        capability: profile.capability,
        agentType: profile.agentType,
        persona: profile.persona,
        isolation: profile.isolation,
        maxConcurrent: options.maxConcurrent ?? config.maxConcurrent,
        concurrencyGroup: options.concurrencyGroup,
        worktree,
        resumeSessionFile,
        preferredId,
        parent: {
          parentCwd: ctx.cwd,
          bridge: parentBridge(title, manager, preferredId),
          projectTrusted: resolveChildProjectTrust({
            parentCwd: ctx.cwd,
            childCwd: cwd,
            parentTrusted: ctx.isProjectTrusted(),
          }),
          inheritedModel: ctx.model ?? undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          inheritedMessages,
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          modelRegistry: ctx.modelRegistry,
        },
      },
    };
  };

  const spawnPiAgent = async (
    manager: SubagentManagerShape,
    ctx: ExtensionContext,
    options: SpawnOptions,
  ) => {
    const prepared = await preparePiAgent(manager, ctx, options);
    if (prepared.resumed) return prepared.resumed;
    try {
      const snap = await runTool(getRuntime(), manager.spawn("pi", prepared.task!));
      persistSnapshot(snap);
      return snap;
    } catch (error) {
      await prepared.cleanup();
      throw error;
    }
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { running, done, failed }),
    );
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    deliverSettlement({
      customType: "subagent-result",
      content: buildSubagentResultMessage({
        id: snap.id,
        title: snap.title,
        status: snap.status,
        errorText: snap.errorText,
        output: truncatedOutput(snap),
      }),
      display: true,
      details: { id: snap.id, title: snap.title, status: snap.status },
    });
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    persistSnapshot(snap);
    if (snap.meta.origin === "orchestration") return;
    if (snap.meta.origin === "btw") {
      pi.appendEntry<BtwEntryData>(BTW_ENTRY_TYPE, {
        id: snap.id,
        title: snap.title,
        status: snap.status,
        answer: truncatedOutput(snap),
        errorText: snap.errorText,
      });
      return;
    }
    if (consumed) return;
    // Hand the immutable settlement to Pi immediately. Pi queues it when the
    // parent is active and starts a new parent turn when idle.
    deliverResult({ ...snap, meta: { ...snap.meta } });
  };

  const coordinator: SubagentCoordinator = {
    async spawn(ctx, options) {
      const manager = await getManager();
      const snapshot = await spawnPiAgent(manager, ctx, {
        ...options,
        origin: "orchestration",
      });
      manager.view.retain(snapshot.id, true);
      return snapshot;
    },
    async send(id, message) {
      const manager = await getManager();
      await runTool(getRuntime(), manager.send(id, message));
      const snapshot = manager.view.get(id);
      if (!snapshot) throw new Error(`Subagent "${id}" is no longer tracked.`);
      return snapshot;
    },
    async cancel(ids) {
      const manager = await getManager();
      await runTool(getRuntime(), manager.cancel(ids));
    },
    async get(id) {
      return (await getManager()).view.get(id);
    },
    async list() {
      return (await getManager()).view.list();
    },
    async subscribe(listener) {
      return (await getManager()).view.subscribe(listener);
    },
    async apply(id, targetCwd) {
      const manager = await getManager();
      const snapshot = manager.view.get(id);
      if (!snapshot?.meta.worktree) throw new Error(`Subagent "${id}" has no worktree.`);
      if (snapshot.status === "running") throw new Error(`Subagent "${id}" is still running.`);
      const exec = (command: string, args: string[], options?: Parameters<typeof pi.exec>[2]) =>
        pi.exec(command, args, options);
      return targetCwd
        ? applyAgentWorktreeTo(exec, snapshot.meta.worktree, targetCwd)
        : applyAgentWorktree(exec, snapshot.meta.worktree);
    },
    async discard(id) {
      const manager = await getManager();
      const snapshot = manager.view.get(id);
      if (!snapshot?.meta.worktree) return;
      await discardAgentWorktree(
        (command, args, options) => pi.exec(command, args, options),
        snapshot.meta.worktree,
      );
      manager.view.clearWorktree(id);
      const updated = manager.view.get(id);
      if (updated) persistSnapshot(updated);
      manager.view.retain(id, false);
    },
    async release(id) {
      const manager = await getManager();
      manager.view.retain(id, false);
    },
  };
  const unsubscribeCoordinator = pi.events.on(
    SUBAGENT_COORDINATOR_REQUEST,
    (request) => {
      if (isCoordinatorRequest(request)) request.accept(coordinator);
    },
  );

  pi.on("session_start", (_event, ctx) => {
    archived.clear();
    peerHistory.length = 0;
    for (const record of loadSubagentCatalog().values()) archived.set(record.id, record);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === SUBAGENT_RECORD_TYPE) {
        const record = entry.data as ArchivedSubagent | undefined;
        if (record?.id && record.sessionFile) {
          const existing = archived.get(record.id);
          if (!existing || existing.updatedAt <= record.updatedAt) archived.set(record.id, record);
        }
      } else if (entry.customType === SUBAGENT_PEER_MESSAGE_TYPE) {
        const message = entry.data as PeerMessage | undefined;
        if (message?.id && message.targetId) peerHistory.push(message);
      }
    }
    if (peerHistory.length > 256) peerHistory.splice(0, peerHistory.length - 256);
    if (ctx.hasUI) ui = ctx.ui;
  });

  pi.on("session_shutdown", async () => {
    unsubscribeCoordinator();
    for (const pending of pendingQuestions.values()) {
      pending.reject(new Error("Parent Pi session shut down before replying."));
    }
    pendingQuestions.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer and closes all child
    // Pi session scopes.
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Pi Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: [
      ...SUBAGENT_SPAWN_PROMPT_GUIDELINES,
      "After spawn_agent starts a child, continue only independent parent work or end the turn immediately. Do not call wait_agent, list_agents, or check_agent merely to watch it run. Settlement stays private until it starts a custom-result turn at Pi's safe idle edge; when its attached summary invokes the parent, continue the original task without waiting for another user message.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      task_name: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      thinking: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
      readonly: Type.Optional(
        Type.Boolean({ description: "Compatibility alias for capability=read-only" }),
      ),
      agent_type: Type.Optional(
        Type.String({ description: "Agent profile: general-purpose, explore, plan, or a configured custom profile" }),
      ),
      persona: Type.Optional(
        Type.String({ description: "Configured behavioral persona overlay" }),
      ),
      capability: Type.Optional(
        StringEnum(CAPABILITY_MODES, { description: "Tool policy: read-only, read-write, execute, or all" }),
      ),
      isolation: Type.Optional(
        StringEnum(ISOLATION_MODES, { description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.isolation }),
      ),
      fork_turns: Type.Optional(
        Type.String({ description: 'Parent context to inherit: "none" (default), "all", or a positive number of recent user turns' }),
      ),
      resume_from: Type.Optional(
        Type.String({ description: "Completed subagent id to continue with its full transcript and tool state" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();
      const snap = await spawnPiAgent(manager, ctx, {
        message: params.message,
        taskName: params.task_name,
        cwd: params.cwd,
        model: params.model,
        thinking: params.thinking,
        readonly: params.readonly,
        agentType: params.agent_type,
        persona: params.persona,
        capability: params.capability,
        isolation: params.isolation,
        forkTurns: params.fork_turns,
        resumeFrom: params.resume_from,
      });

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd: snap.cwd,
              agentType: snap.meta.agentType,
              capability: snap.meta.capability,
              isolation: snap.meta.isolation,
              resumed: !!params.resume_from,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd: snap.cwd,
          model: snap.meta.modelLabel,
          agentType: snap.meta.agentType,
          persona: snap.meta.persona,
          capability: snap.meta.capability,
          isolation: snap.meta.isolation,
          worktree: snap.meta.worktree,
          resumedFrom: params.resume_from,
        },
      };
    },
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Collect Pi Subagent Results",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 64,
          description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      if (pendingQuestions.size > 0) {
        return {
          content: [{ type: "text", text: `A Pi subagent needs guidance:\n${pendingQuestionText()}` }],
          details: waitAgentDetails({
            pendingQuestions: [...pendingQuestions.keys()],
          }),
        };
      }
      const requested = params.ids?.length
        ? params.ids
        : manager.view.list().filter((snap) => snap.status === "running").map((snap) => snap.id);
      const ids = [...new Set(requested)];
      if (ids.length === 0) {
        return {
          content: [{ type: "text", text: "No running Pi subagents." }],
          details: waitAgentDetails(),
        };
      }
      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const snapshots = ids.map((id) => manager.view.get(id)!);
      const settled = snapshots.filter((snap) => snap.status !== "running");
      const pending = snapshots.filter((snap) => snap.status === "running");

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const snap of settled) {
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total result limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }
      if (pending.length > 0) {
        sections.push(
          `Still running in the background: ${pending.map((snap) => snap.id).join(", ")}. ` +
          "Their completion notices will arrive automatically; continue useful work or end the turn instead of polling.",
        );
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[result output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: waitAgentDetails({
          results: snapshots.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
          })),
          pending: pending.map((snap) => snap.id),
        }),
      };
    },
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Pi Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids));

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "check_agent",
    label: "Check Pi Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap) {
        const known = manager.view.list().map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "list_agent_profiles",
    label: "List Subagent Profiles",
    description: "List available subagent profiles, personas, capability defaults, and the active concurrency limit.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadSubagentConfig(ctx.cwd, ctx.isProjectTrusted());
      const profileLines = Object.entries(config.profiles).map(
        ([name, profile]) =>
          `profile ${name}: ${profile.description ?? "no description"}; capability=${profile.capability ?? "all"}; isolation=${profile.isolation ?? "none"}`,
      );
      const personaLines = Object.entries(config.personas).map(
        ([name, persona]) => `persona ${name}: ${persona.description ?? "no description"}`,
      );
      return {
        content: [{
          type: "text",
          text: [`maxConcurrent=${config.maxConcurrent}`, ...profileLines, ...personaLines].join("\n"),
        }],
        details: { maxConcurrent: config.maxConcurrent, profiles: config.profiles, personas: config.personas },
      };
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Pi Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list();
      const liveIds = new Set(subs.map((snap) => snap.id));
      const resumable = [...archived.values()].filter((record) => !liveIds.has(record.id));
      const lines = subs.map((snap) => describeSubagent(snap));
      lines.push(...resumable.map((record) => `${record.id} [archived:${record.status}] "${record.title}" (${record.model ?? "?"}, ${record.cwd})`));
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No subagents." }],
        details: {
          subagents: [
            ...subs.map((snap) => ({ id: snap.id, title: snap.title, status: snap.status })),
            ...resumable.map((record) => ({ id: record.id, title: record.title, status: `archived:${record.status}` })),
          ],
        },
      };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Message Pi Subagent",
    description: "Guide an active subagent or start its next turn when idle.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent id" }),
      message: Type.String({ description: "Guidance or follow-up" }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap) throw new Error(`Unknown Pi subagent id "${params.id}".`);
      await runTool(getRuntime(), manager.send(params.id, params.message));
      return {
        content: [{ type: "text", text: `Sent message to ${params.id} "${snap.title}".` }],
        details: { id: params.id, status: manager.view.get(params.id)?.status },
      };
    },
  });

  pi.registerTool({
    name: "apply_agent_changes",
    label: "Manage Isolated Agent Changes",
    description: "Inspect, patch, cherry-pick, merge, or permanently discard a completed isolated agent worktree. Cherry-pick and merge are preflighted in a temporary worktree before the source repository changes.",
    parameters: Type.Object({
      id: Type.String({ description: "Worktree-isolated subagent id" }),
      action: Type.Optional(StringEnum(WORKTREE_ACTIONS, {
        description: "inspect, patch (default), cherry-pick, merge, or discard",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      const record = archived.get(params.id);
      const worktree = snap?.meta.worktree ?? record?.worktree;
      if (!worktree) throw new Error(`Subagent "${params.id}" has no isolated worktree.`);
      const action: WorktreeAction = params.action ?? "patch";
      if (snap?.status === "running" && action !== "inspect") {
        throw new Error(`Subagent "${params.id}" is still running; wait or close it before ${action}.`);
      }
      const exec = (command: string, args: string[], execOptions?: Parameters<typeof pi.exec>[2]) =>
        pi.exec(command, args, execOptions);
      let result: Record<string, unknown>;
      if (action === "inspect") {
        result = { action, ...(await inspectAgentWorktree(exec, worktree)) };
      } else if (action === "patch") {
        result = await applyAgentWorktree(exec, worktree);
      } else if (action === "discard") {
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            "Discard isolated subagent worktree?",
            `This permanently deletes ${worktree.path} and branch ${worktree.branch}.`,
          );
          if (!confirmed) throw new Error("Worktree discard cancelled.");
        }
        await discardAgentWorktree(exec, worktree);
        result = { action, changed: false, discarded: true, files: [] };
        manager.view.clearWorktree(params.id);
        if (record) {
          const updated = { ...record, worktree: undefined, updatedAt: Date.now() };
          archived.set(params.id, updated);
          upsertSubagentCatalog(updated);
          pi.appendEntry(SUBAGENT_RECORD_TYPE, updated);
        }
      } else {
        result = await integrateAgentWorktree(exec, worktree, action, snap?.title ?? record?.title ?? params.id);
      }
      const files = Array.isArray(result.files) ? result.files as string[] : [];
      const text = action === "inspect"
        ? `${params.id}: ${files.length} changed file(s), ${(result.commits as string[] | undefined)?.length ?? 0} commit(s), dirty=${String(result.dirty)}`
        : action === "discard"
          ? `Discarded the isolated worktree for ${params.id}.`
          : result.changed
            ? `${action} applied ${files.length} file(s) from ${params.id}:\n${files.join("\n")}`
            : `${params.id} has no changes to ${action}.`;
      return { content: [{ type: "text", text }], details: { id: params.id, ...result, worktree } };
    },
  });

  pi.registerTool({
    name: "reply_question",
    label: "Reply to Pi Subagent",
    description: "Answer a subagent's blocking ask_parent question.",
    parameters: Type.Object({
      question_id: Type.Optional(Type.String({ description: "Question id; omit when exactly one is pending" })),
      reply: Type.String({ description: "Answer or guidance" }),
    }),
    async execute(_toolCallId, params) {
      const id = params.question_id ?? (pendingQuestions.size === 1 ? [...pendingQuestions.keys()][0] : undefined);
      if (!id) throw new Error(`Specify question_id; ${pendingQuestions.size} questions are pending.`);
      const pending = pendingQuestions.get(id);
      if (!pending) throw new Error(`Unknown or already answered question id "${id}".`);
      pendingQuestions.delete(id);
      pending.resolve(params.reply);
      return {
        content: [{ type: "text", text: `Replied to Pi subagent "${pending.title}".` }],
        details: { questionId: id, title: pending.title },
      };
    },
  });

  pi.registerTool({
    name: "task",
    label: "Start Pi Subagent Tasks",
    description: "Start independent subagent tasks together in the background and return their ids immediately. Completion notices automatically start the next parent turn, so the parent should end its current turn when no independent work remains instead of checking status.",
    promptGuidelines: [
      "After task starts children, continue only independent parent work or end the turn immediately. Do not call wait_agent, list_agents, or check_agent merely to watch them run. Settlements stay private until they start a custom-result turn at Pi's safe idle edge; when their attached summaries invoke the parent, continue the original task without waiting for another user message.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          message: Type.String({ description: "Standalone task prompt" }),
          task_name: Type.Optional(Type.String({ description: "Short name" })),
          cwd: Type.Optional(Type.String({ description: "Working directory" })),
          model: Type.Optional(Type.String({ description: "Model hint" })),
          thinking: Type.Optional(StringEnum(REASONING_EFFORTS)),
          readonly: Type.Optional(Type.Boolean({ description: "Compatibility alias for read-only" })),
          agent_type: Type.Optional(Type.String({ description: "Agent profile" })),
          persona: Type.Optional(Type.String({ description: "Persona overlay" })),
          capability: Type.Optional(StringEnum(CAPABILITY_MODES)),
          isolation: Type.Optional(StringEnum(ISOLATION_MODES, { description: WORKTREE_ISOLATION_DESCRIPTION })),
          fork_turns: Type.Optional(Type.String({ description: '"none", "all", or recent turn count' })),
        }),
        { minItems: 1, maxItems: 50 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();
      const config = loadSubagentConfig(ctx.cwd, ctx.isProjectTrusted());
      if (params.tasks.length > config.maxConcurrent) {
        throw new Error(
          `Requested ${params.tasks.length} tasks, but maxConcurrent is ${config.maxConcurrent}.`,
        );
      }
      const prepared: PreparedSpawn[] = [];
      try {
        for (const item of params.tasks) {
          prepared.push(await preparePiAgent(manager, ctx, {
            message: item.message,
            taskName: item.task_name,
            cwd: item.cwd,
            model: item.model,
            thinking: item.thinking,
            readonly: item.readonly,
            agentType: item.agent_type,
            persona: item.persona,
            capability: item.capability,
            isolation: item.isolation,
            forkTurns: item.fork_turns,
          }));
        }
      } catch (error) {
        await Promise.all(prepared.map((item) => item.cleanup()));
        throw error;
      }
      let spawned: ReadonlyArray<SubagentSnapshot>;
      try {
        spawned = await runTool(
          getRuntime(),
          manager.spawnBatch("pi", prepared.map((item) => item.task!)),
        );
      } catch (error) {
        await Promise.all(prepared.map((item) => item.cleanup()));
        throw error;
      }
      for (const snap of spawned) persistSnapshot(snap);
      const lines = spawned.map(
        (snap) => `- ${describeSubagent(snap)}`,
      );
      return {
        content: [{
          type: "text",
          text:
            `Started ${spawned.length} Pi subagent${spawned.length === 1 ? "" : "s"} in the background:\n` +
            `${lines.join("\n")}\n\n` +
            "Continue useful parent work or end the turn. Completion notices will arrive automatically.",
        }],
        details: {
          agents: spawned.map((snap) => ({ id: snap.id, title: snap.title, status: snap.status })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwEntryData>(
    BTW_ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return new Text(theme.fg("warning", "By-the-way result unavailable"), 0, 0);
      const failed = data.status === "error";
      const header =
        `${theme.fg(failed ? "error" : "success", "■")} ` +
        theme.fg("accent", theme.bold(`by the way · ${data.title}`)) +
        theme.fg("muted", ` · ${failed ? "failed" : "answered"} · ${data.id}`);
      const body = [data.errorText ? `Error: ${data.errorText}` : "", data.answer]
        .filter(Boolean)
        .join("\n\n");
      if (expanded) {
        const markdown = new Markdown(body, 0, 0, getMarkdownTheme());
        const title = new Text(header, 0, 0);
        return {
          render: (width: number) => [...title.render(width), ...markdown.render(width)],
          invalidate: () => {
            title.invalidate();
            markdown.invalidate();
          },
        };
      }
      const bodyLines = body.split("\n");
      let text = header;
      for (const line of bodyLines.slice(0, 8)) text += `\n${theme.fg("toolOutput", line)}`;
      if (bodyLines.length > 8) text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  pi.registerCommand("btw", {
    description: "Ask a read-only side question in a context-aware Pi subagent",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("By-the-way questions require the TUI", "error");
        return;
      }
      let question = args.trim();
      if (!question) {
        question = (await ctx.ui.input("By the way", "Ask a side question…"))?.trim() ?? "";
      }
      if (!question) return;
      const manager = await getManager();
      let snap: SubagentSnapshot;
      try {
        snap = await spawnPiAgent(manager, ctx, {
          message:
            "Answer this side question directly. Investigate only as far as needed, do not modify files, and distinguish verified evidence from inference.\n\n" +
            question,
          taskName: deriveBtwTitle(question),
          agentType: "explore",
          capability: "execute",
          isolation: "none",
          forkTurns: "4",
          origin: "btw",
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      await openSubagentTakeover(ctx, manager.view, snap.id);
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect agents, peer messages, profiles, or configuration",
    getArgumentCompletions: (prefix) =>
      ["agents", "peers", "profiles", "config"]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Subagent UI is only available in the TUI", "error");
        return;
      }
      const action = args.trim() || "agents";
      if (action === "config") {
        let scope: ConfigScope = "global";
        if (ctx.isProjectTrusted()) {
          const selected = await ctx.ui.select("Edit subagent configuration", ["global", "project"]);
          if (!selected) return;
          scope = selected as ConfigScope;
        }
        const edited = await ctx.ui.editor(
          `Edit ${scope} subagent configuration`,
          loadConfigDocument(scope, ctx.cwd),
        );
        if (edited === undefined) return;
        try {
          saveConfigDocument(scope, ctx.cwd, edited);
          ctx.ui.notify(`Saved ${scope} subagent configuration`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      const manager = await getManager();
      if (action === "peers") {
        await openPeerMessageViewer(ctx, manager.view);
        return;
      }
      if (action === "profiles") {
        const config = loadSubagentConfig(ctx.cwd, ctx.isProjectTrusted());
        const entries = [
          ...Object.entries(config.profiles).map(([name, value]) => ({
            label: `profile: ${name}`,
            text: JSON.stringify(value, null, 2),
          })),
          ...Object.entries(config.personas).map(([name, value]) => ({
            label: `persona: ${name}`,
            text: JSON.stringify(value, null, 2),
          })),
        ];
        const selected = await ctx.ui.select("Subagent profiles and personas", entries.map((entry) => entry.label));
        const entry = entries.find((candidate) => candidate.label === selected);
        if (entry) await ctx.ui.editor(`View ${entry.label} · edit via /subagents config`, entry.text);
        return;
      }
      if (action !== "agents") {
        ctx.ui.notify('Use /subagents agents, peers, profiles, or config', "error");
        return;
      }
      if (manager.view.size() === 0) {
        ctx.ui.notify("No subagents yet. The agent spawns them with spawn_agent.", "info");
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
