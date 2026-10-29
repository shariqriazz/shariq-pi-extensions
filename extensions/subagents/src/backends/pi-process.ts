/**
 * Process runtime for Pi subagents: each child is a separate `pi --mode rpc`
 * process driven over Pi's documented JSONL RPC protocol. Children get the
 * full CLI setup, including Pi's built-in extensions (codemode, MCP, tool
 * search), and a crash stays in the child. The child-bridge extension enforces
 * capability inside the child and carries parent questions over RPC dialogs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentSession } from "../backend.ts";
import type { SpawnTask, SubagentEvent, SubagentMeta } from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import {
  BRIDGE_MARK,
  CHILD_BRIDGE_ENV,
  CHILD_CAPABILITY_ENV,
  CHILD_ENV,
  CHILD_TOOLS_ENV,
  type BridgeRequest,
} from "../child-bridge.ts";
import { boundedError, resolvePiModel, settledOutcome, translateSessionEvent } from "./pi.ts";

const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const STDERR_TAIL_CHARS = 4_000;
const CHILD_BRIDGE_PATH = fileURLToPath(new URL("../child-bridge.ts", import.meta.url));

/**
 * The command that starts this same Pi build. Under Node or Bun the entry
 * script (often a `pi` symlink to cli.js) follows the runtime; a compiled
 * binary is its own executable.
 */
export function piCommand(argv = process.argv, execPath = process.execPath): { file: string; args: string[] } {
  const script = argv[1];
  try {
    if (script) {
      const resolved = fs.realpathSync(script);
      if (resolved !== fs.realpathSync(execPath) && fs.statSync(resolved).isFile()) {
        return { file: execPath, args: [resolved] };
      }
    }
  } catch {
    // Fall through to the executable itself.
  }
  return { file: execPath, args: [] };
}

/** CLI arguments for one child; exported for tests. */
export function childArgs(task: SpawnTask, model: Model<any> | undefined, sessionFile: string | undefined): string[] {
  const args = ["--mode", "rpc"];
  if (sessionFile) args.push("--session", sessionFile);
  if (model) args.push("--provider", model.provider, "--model", model.id);
  const thinking = task.reasoningEffort ?? task.parent.inheritedThinkingLevel;
  if (thinking) args.push("--thinking", thinking);
  args.push(task.parent.projectTrusted ? "--approve" : "--no-approve");
  if (task.childOptions?.skills === false) args.push("--no-skills");
  if (task.childOptions?.contextFiles === false) args.push("--no-context-files");
  if (task.childOptions?.extensions === false) args.push("--no-extensions");
  args.push("-e", CHILD_BRIDGE_PATH);
  return args;
}

/** Seed a new child session with the forked parent context, as the in-process runtime does. */
function prepareSessionFile(task: SpawnTask): string | undefined {
  if (task.resumeSessionFile) return task.resumeSessionFile;
  const inherited = task.parent.inheritedMessages ?? [];
  if (inherited.length === 0) return undefined;
  const manager = SessionManager.create(task.cwd, undefined, { parentSession: task.parent.parentSessionFile });
  for (const message of inherited) manager.appendMessage(message);
  const file = manager.getSessionFile();
  return file && fs.existsSync(file) ? file : undefined;
}

type RpcRecord = { type?: string; id?: string; [key: string]: any };

export const makeProcessSession = (task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    const model = yield* Effect.try({
      try: () =>
        registry ? resolvePiModel(registry, task.model, task.parent.inheritedModel) : task.parent.inheritedModel,
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const sessionFile = yield* Effect.try({
      try: () => prepareSessionFile(task),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const state = {
      closed: false,
      exited: false,
      streaming: false,
      settled: false,
      runError: undefined as string | undefined,
      runStartIndex: 0,
      messages: [] as unknown[],
      sessionFile,
      sessionId: undefined as string | undefined,
      stderr: "",
      nextId: 0,
    };
    const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();

    const command = piCommand();
    const child: ChildProcess = spawn(command.file, [...command.args, ...childArgs(task, model, sessionFile)], {
      cwd: task.cwd,
      env: {
        ...process.env,
        [CHILD_ENV]: "1",
        [CHILD_CAPABILITY_ENV]: task.capability,
        ...(task.childOptions?.tools ? { [CHILD_TOOLS_ENV]: JSON.stringify(task.childOptions.tools) } : {}),
        ...(task.parent.bridge ? { [CHILD_BRIDGE_ENV]: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const failAll = (error: Error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    const exitError = () =>
      new Error(
        `The subagent process exited.${state.stderr.trim() ? ` ${state.stderr.trim().slice(-STDERR_TAIL_CHARS)}` : ""}`,
      );

    const write = (record: RpcRecord) => {
      if (state.exited || !child.stdin?.writable) throw exitError();
      child.stdin.write(`${JSON.stringify(record)}\n`);
    };
    const request = (record: RpcRecord) =>
      new Promise<unknown>((resolve, reject) => {
        const id = `req-${++state.nextId}`;
        pending.set(id, { resolve, reject });
        try {
          write({ ...record, id });
        } catch (error) {
          pending.delete(id);
          reject(error as Error);
        }
      });

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      emit({ _tag: "RunSettled", outcome: settledOutcome(state.messages, state.runStartIndex, state.runError) });
    };

    const currentMeta = (): SubagentMeta => {
      const last = [...state.messages]
        .reverse()
        .find((message) => (message as { role?: string })?.role === "assistant") as AssistantMessage | undefined;
      const label = last ? `${last.provider}/${last.model}` : model ? `${model.provider}/${model.id}` : undefined;
      return {
        backend: "pi",
        origin: task.origin,
        modelLabel: label,
        contextWindow: model?.contextWindow,
        sessionFilePath: state.sessionFile,
        nativeSessionId: state.sessionId,
        agentType: task.agentType,
        persona: task.persona,
        capability: task.capability,
        isolation: task.isolation,
        worktree: task.worktree,
        concurrencyGroup: task.concurrencyGroup,
        resumedFrom: task.resumeSessionFile,
      };
    };

    // Answer bridge dialogs; dismiss every other dialog, since no person is watching the child.
    const answerUi = async (record: RpcRecord) => {
      const reply = (body: Record<string, unknown>) => {
        try {
          write({ type: "extension_ui_response", id: record.id, ...body });
        } catch {
          // The child exited; nothing is waiting for the answer.
        }
      };
      const marked = (text: unknown) =>
        typeof text === "string" && text.startsWith(BRIDGE_MARK)
          ? (JSON.parse(text.slice(BRIDGE_MARK.length)) as BridgeRequest)
          : undefined;
      if (record.method === "notify") {
        const body = marked(record.message);
        if (body?.kind === "notify") task.parent.bridge?.notify(body.message);
        return;
      }
      if (!["select", "confirm", "input", "editor"].includes(record.method)) return;
      const body = record.method === "input" ? marked(record.title) : undefined;
      const bridge = task.parent.bridge;
      if (!body || !bridge) return reply({ cancelled: true });
      try {
        if (body.kind === "ask") reply({ value: await bridge.ask(body.question) });
        else if (body.kind === "peers") reply({ value: JSON.stringify(bridge.listPeers()) });
        else if (body.kind === "peer") {
          await bridge.messagePeer(body.id, body.message);
          reply({ value: "ok" });
        } else reply({ cancelled: true });
      } catch (error) {
        reply({ value: `error: ${boundedError(error)}` });
      }
    };

    const handleRecord = (record: RpcRecord) => {
      if (record.type === "response") {
        const entry = record.id ? pending.get(record.id) : undefined;
        if (!entry) return;
        pending.delete(record.id!);
        if (record.success === false) entry.reject(new Error(String(record.error ?? "RPC command failed")));
        else entry.resolve(record.data);
        return;
      }
      if (record.type === "extension_ui_request") {
        void answerUi(record);
        return;
      }
      if (state.closed) return;
      switch (record.type) {
        case "agent_start":
          state.streaming = true;
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "message_end":
          state.messages.push(record.message);
          translateSessionEvent(record as { type: string }, emit);
          if ((record.message as { role?: string })?.role === "assistant") {
            const usage = (record.message as AssistantMessage).usage;
            emit({ _tag: "UsageChanged", tokens: usage?.totalTokens, contextWindow: model?.contextWindow });
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          break;
        case "agent_settled":
          state.streaming = false;
          settle();
          break;
        default:
          translateSessionEvent(record as { type: string }, emit);
      }
    };

    // Strict JSONL: split only on LF, never on Unicode line separators.
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try {
            handleRecord(JSON.parse(line) as RpcRecord);
          } catch {
            // Ignore a malformed record rather than losing the session.
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      state.stderr = (state.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    const exited = new Promise<void>((resolve) => {
      const onExit = () => {
        if (state.exited) return;
        state.exited = true;
        failAll(exitError());
        if (!state.closed && !state.settled) {
          state.runError ??= exitError().message;
          state.streaming = false;
          settle();
        }
        resolve();
      };
      child.once("exit", onExit);
      child.once("error", (error) => {
        state.stderr += `\n${error.message}`;
        onExit();
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        // Closing stdin asks Pi for an orderly shutdown; escalate if it lingers.
        child.stdin?.end();
        const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
        await Promise.race([exited, timeout(SHUTDOWN_TIMEOUT_MS)]);
        if (!state.exited) {
          child.kill("SIGTERM");
          await Promise.race([exited, timeout(1_000)]);
          if (!state.exited) child.kill("SIGKILL");
        }
        failAll(new Error("Subagent session is closed."));
        Queue.endUnsafe(events);
      }),
    );

    // Wait until the child answers before handing the session to the manager.
    const ready = yield* Effect.tryPromise({
      try: () =>
        Promise.race([
          request({ type: "get_state" }),
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("The subagent process did not start in time.")),
              STARTUP_TIMEOUT_MS,
            ).unref?.(),
          ),
        ]) as Promise<{ sessionFile?: string; sessionId?: string }>,
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    state.sessionFile = ready.sessionFile ?? state.sessionFile;
    state.sessionId = ready.sessionId;

    const startRun = (text: string) => {
      state.runError = undefined;
      state.settled = false;
      state.runStartIndex = state.messages.length;
      emit({ _tag: "RunStarted" });
      request({ type: "prompt", message: text }).then(
        (data) => {
          // A handled prompt (for example an extension command) starts no run.
          if ((data as { disposition?: string } | undefined)?.disposition === "handled" && !state.streaming) settle();
        },
        (error) => {
          state.runError = boundedError(error);
          if (!state.streaming) settle();
        },
      );
    };

    emit({ _tag: "MetaChanged", meta: currentMeta() });
    startRun(task.prompt);

    return {
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed || state.exited) return new SendError({ message: "Subagent session is closed." });
          if (state.streaming) {
            return Effect.tryPromise({
              try: () => request({ type: "steer", message: text }),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || state.exited) return;
        await request({ type: "clear_queue" }).catch(() => undefined);
        await request({ type: "abort" }).catch(() => undefined);
        while (!state.closed && !state.exited && state.streaming) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        }
      }),
    } satisfies SubagentSession;
  });
