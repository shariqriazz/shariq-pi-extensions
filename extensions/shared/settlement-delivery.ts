import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SettlementMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
interface DeliverSettlement {
  /** Queue a result; `key` lets the sender withdraw it before it is delivered. */
  (message: SettlementMessage, key?: string): void;
  /** Drop a queued, undelivered result, for example one the model already read through a tool. */
  withdraw(key: string): void;
  /**
   * Keep the run from settling until `done` resolves, so the work's result reaches the model in the
   * same run. A new user message cancels every hold.
   */
  hold(key: string, done: Promise<void>): void;
}

type SessionKey = object;

interface Coordinator {
  parentActive: boolean;
  shuttingDown: boolean;
  pending: Array<{ message: SettlementMessage; key?: string }>;
  holds: Map<string, Promise<void>>;
  flush(): void;
}

const HOLD_POLL_MS = 250;

// Pi loads every extension entrypoint through its own module instance, so the
// per-session coordinators live on a process-wide registry. Otherwise each
// extension would flush its own queue and start its own turn.
const REGISTRY_KEY = Symbol.for("shariq-pi-extensions/settlement-delivery/v1");
const coordinators: WeakMap<SessionKey, Coordinator> =
  ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as WeakMap<SessionKey, Coordinator> | undefined) ??
  (((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = new WeakMap<SessionKey, Coordinator>()) as WeakMap<
    SessionKey,
    Coordinator
  >);

function createCoordinator(pi: ExtensionAPI): Coordinator {
  const coordinator: Coordinator = {
    parentActive: false,
    shuttingDown: false,
    pending: [],
    holds: new Map(),
    flush() {
      if (coordinator.parentActive || coordinator.shuttingDown || coordinator.pending.length === 0) return;
      const batch = coordinator.pending.splice(0);
      for (const { message } of batch.slice(0, -1)) {
        pi.sendMessage(message, { triggerTurn: false });
      }
      pi.sendMessage(batch.at(-1)!.message, { triggerTurn: true });
    },
  };
  return coordinator;
}

/**
 * Coordinate asynchronous results across every suite extension in one Pi
 * session. Results that settle during a parent run stay in a private local
 * queue; Pi never renders them as queued user/follow-up input. At
 * agent_before_settle they are appended together and continue the same run, so
 * hosts never see the session settle with a result waiting. Results that cannot
 * continue the run, or arrive while idle, start exactly one turn at the idle edge.
 */
export function settlementDelivery(pi: ExtensionAPI): DeliverSettlement {
  let coordinator: Coordinator | undefined;
  let sessionKey: SessionKey | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionKey = (ctx.sessionManager ?? ctx) as SessionKey;
    coordinator = coordinators.get(sessionKey);
    if (!coordinator) {
      coordinator = createCoordinator(pi);
      coordinators.set(sessionKey, coordinator);
    }
    coordinator.parentActive = false;
    coordinator.shuttingDown = false;
  });
  pi.on("agent_start", () => {
    if (coordinator) coordinator.parentActive = true;
  });
  // Paseo and other hosts treat agent_settled as "done", so held results must start their turn
  // before it: from agent_before_settle, inside the same run.
  pi.on("agent_before_settle", async (event, ctx) => {
    const active = coordinator;
    if (!active || active.shuttingDown || event.outcome === "aborted") return;
    while (active.holds.size > 0 && !active.shuttingDown) {
      if (ctx.hasPendingMessages()) {
        active.holds.clear();
        break;
      }
      await Promise.race([...active.holds.values(), new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS))]);
    }
    if (active.shuttingDown || active.pending.length === 0) return;
    const batch = active.pending.splice(0);
    return {
      entries: [
        ...event.entries,
        ...batch.map(({ message }) => ({
          type: "custom_message" as const,
          customType: message.customType,
          content: message.content,
          display: message.display ?? true,
          details: message.details,
        })),
      ],
      continue: true,
    };
  });
  pi.on("agent_settled", () => {
    if (!coordinator) return;
    coordinator.parentActive = false;
    coordinator.flush();
  });
  pi.on("session_shutdown", () => {
    if (coordinator) {
      coordinator.shuttingDown = true;
      coordinator.parentActive = false;
      coordinator.pending.length = 0;
      coordinator.holds.clear();
    }
    if (sessionKey) coordinators.delete(sessionKey);
    coordinator = undefined;
    sessionKey = undefined;
  });

  const deliver = ((message: SettlementMessage, key?: string) => {
    // session_start precedes model-owned terminal/subagent work. Fail closed if
    // a malformed host calls delivery before initialization instead of showing
    // asynchronous output as user-authored input.
    if (!coordinator || coordinator.shuttingDown) return;
    coordinator.pending.push({ message, key });
    coordinator.flush();
  }) as DeliverSettlement;
  // A result the model already saw through a tool during the run would otherwise
  // start a turn of its own at the idle edge, only to be dismissed as old.
  deliver.withdraw = (key) => {
    if (!coordinator) return;
    coordinator.pending = coordinator.pending.filter((entry) => entry.key !== key);
  };
  deliver.hold = (key, done) => {
    const active = coordinator;
    if (!active || active.shuttingDown) return;
    active.holds.set(key, done);
    void done.finally(() => {
      if (active.holds.get(key) === done) active.holds.delete(key);
    });
  };
  return deliver;
}
