/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import { randomUUID } from "node:crypto";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  PeerMessage,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  latestText,
  SendError,
  SpawnError,
} from "./domain.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  session: SubagentSession;
  scope: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  maxConcurrent: number;
  concurrencyGroup: string;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /** Flat peer-message audit log for the coordination UI. */
  peerMessages(): ReadonlyArray<PeerMessage>;
  recordPeerMessage(message: PeerMessage): void;
  clearWorktree(id: string): void;
  retain(id: string, retained: boolean): void;
  /**
   * Register the settle hook. `consumed` is true when an active
   * wait_agent/close_agent is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentManagerShape {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /** Atomically reserve capacity for a complete fan-out before starting it. */
  spawnBatch(
    backend: BackendName,
    tasks: ReadonlyArray<SpawnTask>,
  ): Effect.Effect<
    ReadonlyArray<SubagentSnapshot>,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<void, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  const waitInterest = new Map<string, number>();
  const rollingBack = new Set<string>();
  const retained = new Set<string>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  const peerMessages: PeerMessage[] = [];
  let counter = 0;
  const reservedByGroup = new Map<string, number>();
  const reservedIn = (group: string) => reservedByGroup.get(group) ?? 0;
  const reserve = (group: string, count: number) =>
    reservedByGroup.set(group, reservedIn(group) + count);
  const release = (group: string, count: number) => {
    const next = reservedIn(group) - count;
    if (next > 0) reservedByGroup.set(group, next);
    else reservedByGroup.delete(group);
  };
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = (group: string) =>
    [...entries.values()].filter(
      (entry) =>
        entry.concurrencyGroup === group &&
        (entry.snapshot.status === "running" || entry.restarting === true),
    ).length;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" &&
          !waitInterest.has(e.snapshot.id) &&
          !retained.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome, persistOnly = false) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText;
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = outcome.partialText ?? "";
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = outcome.partialText ?? "";
        break;
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    const consumed = (waitInterest.get(s.id) ?? 0) > 0;
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed && !rollingBack.has(s.id)) onSettled?.(s, consumed || persistOnly);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        s.transcript.push({ kind: "user", text: event.text });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? { ...live, text: live.text + event.delta }
            : { ...live, thinking: live.thinking + event.delta };
        break;
      }
      case "AssistantMessage":
        s.transcript.push({ kind: "assistant", parts: event.parts });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview ?? current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        s.transcript.push({
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  const spawnInternal = (
    backendName: BackendName,
    task: SpawnTask,
    preReserved = false,
  ) =>
    Effect.gen(function* () {
      // Reserve synchronously (before the first yield inside doSpawn) so
      // parallel tool calls cannot race past the global cap.
      if (!preReserved) {
        yield* Effect.suspend(
          (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
            if (disposed) {
              return new SpawnError({
                message: "Subagent manager is shutting down.",
              });
            }
            const group = task.concurrencyGroup ?? "default";
            if (runningCount(group) + reservedIn(group) >= task.maxConcurrent) {
              return new ConcurrencyLimitError({
                message: `Max ${task.maxConcurrent} Pi subagents can run concurrently. Let one finish or close one before spawning another. Use /subagents config to change maxConcurrent.`,
              });
            }
            reserve(group, 1);
            return Effect.void;
          },
        );
      }

      const doSpawn = Effect.gen(function* () {
        const backend: SubagentBackend | undefined = registry.get(backendName);
        if (!backend) {
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        }
        const available = yield* backend.available;
        if (!available) {
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
          });
        }

        const scope = yield* Scope.make();
        const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        if (disposed) {
          yield* Scope.close(scope, Exit.void);
          return yield* new SpawnError({
            message: "Subagent manager shut down while spawning.",
          });
        }

        const id =
          task.preferredId && !entries.has(task.preferredId)
            ? task.preferredId
            : `sa-${++counter}-${randomUUID().slice(0, 6)}`;
        const meta = yield* session.meta;
        const entry: Entry = {
          snapshot: {
            id,
            backend: backendName,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            status: "running",
            createdAt: Date.now(),
            meta,
            usage: { contextWindow: meta.contextWindow },
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: "",
            turns: 0,
          },
          session,
          scope,
          liveToolMap: new Map(),
          maxConcurrent: task.maxConcurrent,
          concurrencyGroup: task.concurrencyGroup ?? "default",
        };
        entries.set(id, entry);

        // Pump: fold the event stream into the snapshot. Tied to the entry
        // scope, so closing the scope stops it. If the stream ends while the
        // subagent still looks running, the backend died out from under us.
        const pump = Stream.runForEach(session.events, (event) =>
          Effect.sync(() => foldEvent(entry, event)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entry.snapshot.status === "running") {
                settle(entry, {
                  _tag: "Failed",
                  errorText: "Backend event stream ended unexpectedly",
                });
              }
            }),
          ),
        );
        entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);

        notify(id);
        return entry.snapshot as SubagentSnapshot;
      });

      return yield* (preReserved
        ? doSpawn
        : doSpawn.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                release(task.concurrencyGroup ?? "default", 1);
                notify();
              }),
            ),
          ));
    });

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    spawnInternal(backendName, task);

  const spawnBatch = (backendName: BackendName, tasks: ReadonlyArray<SpawnTask>) =>
    Effect.gen(function* () {
      if (tasks.length === 0) return [];
      const limit = Math.min(...tasks.map((task) => task.maxConcurrent));
      const groups = new Set(tasks.map((task) => task.concurrencyGroup ?? "default"));
      if (groups.size !== 1) {
        return yield* new SpawnError({ message: "A batch must use one concurrency group." });
      }
      const group = [...groups][0]!;
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({ message: "Subagent manager is shutting down." });
          }
          if (runningCount(group) + reservedIn(group) + tasks.length > limit) {
            return new ConcurrencyLimitError({
              message: `Cannot start ${tasks.length} tasks atomically: ${runningCount(group)} running and ${reservedIn(group)} reserved with maxConcurrent ${limit}.`,
            });
          }
          reserve(group, tasks.length);
          return Effect.void;
        },
      );
      const started: SubagentSnapshot[] = [];
      return yield* Effect.forEach(
        tasks,
        (task) =>
          spawnInternal(backendName, task, true).pipe(
            Effect.tap((snapshot) => Effect.sync(() => started.push(snapshot))),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            for (const snapshot of started) rollingBack.add(snapshot.id);
            yield* Effect.forEach(
              started,
              (snapshot) => {
                const entry = entries.get(snapshot.id);
                if (!entry) return Effect.void;
                entries.delete(snapshot.id);
                return entry.session.interrupt.pipe(
                  Effect.timeout(STOP_TIMEOUT_MS),
                  Effect.ignore,
                  Effect.andThen(closeEntryScope(entry)),
                  Effect.timeout(STOP_TIMEOUT_MS),
                  Effect.ignore,
                );
              },
              { concurrency: "unbounded" },
            );
            for (const snapshot of started) rollingBack.delete(snapshot.id);
            yield* Effect.sync(() => notify());
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            release(group, tasks.length);
            notify();
          }),
        ),
      );
    });

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const entry = entries.get(id);
            return entry?.snapshot.status === "running" || entry?.restarting === true;
          });
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  /** Interrupt one running entry, force-closing its scope after 5s. */
  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (entry.snapshot.status !== "running") return;
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        yield* Effect.sync(() => {
          settle(entry, { _tag: "Interrupted" });
          entry.snapshot.errorText =
            "Abort deadline exceeded; session was force-disposed";
          notify(entry.snapshot.id);
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled.
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry => entry?.snapshot.status === "running",
        );
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, {
          concurrency: "unbounded",
        });
        while (running.some((entry) => entry.snapshot.status === "running")) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (entry.snapshot.status !== "running") {
        if (runningCount(entry.concurrencyGroup) + reservedIn(entry.concurrencyGroup) >= entry.maxConcurrent) {
          return new SendError({
            message: `Max ${entry.maxConcurrent} Pi subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        }
        // Occupy the slot synchronously: the RunStarted that flips status
        // arrives via the async pump, and two concurrent restarts must not
        // both pass the check in that window. Cleared by RunStarted/settle,
        // or here when the backend rejects the send.
        entry.restarting = true;
        return entry.session.send(text).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              entry.restarting = false;
            }),
          ),
        );
      }
      return entry.session.send(text);
    });

  const disposeAll = Effect.gen(function* () {
    const all = [...entries.values()];
    for (const entry of all) {
      if (entry.snapshot.status === "running") {
        settle(entry, { _tag: "Interrupted", partialText: latestText(entry.snapshot) }, true);
      }
    }
    disposed = true;
    entries.clear();
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Pruning cleanups are detached; bound them like everything else so a
    // stuck backend finalizer cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    peerMessages: () => peerMessages,
    recordPeerMessage: (message) => {
      peerMessages.push(message);
      if (peerMessages.length > 256) peerMessages.splice(0, peerMessages.length - 256);
      notify(message.targetId);
    },
    clearWorktree: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      entry.snapshot.meta = { ...entry.snapshot.meta, worktree: undefined };
      notify(id);
    },
    retain: (id, keep) => {
      if (keep) retained.add(id);
      else retained.delete(id);
      pruneSettled();
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    spawnBatch,
    waitFor,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
