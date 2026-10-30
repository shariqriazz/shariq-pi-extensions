import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SettlementMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
interface DeliverSettlement {
  /** Queue a result; `key` lets the sender withdraw it before it is delivered. */
  (message: SettlementMessage, key?: string): void;
  /** Drop a queued, undelivered result, for example one the model already read through a tool. */
  withdraw(key: string): void;
}

type SessionKey = object;

interface Coordinator {
  parentActive: boolean;
  shuttingDown: boolean;
  pending: Array<{ message: SettlementMessage; key?: string }>;
  flush(): void;
}

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
 * queue until agent_settled; Pi never renders them as queued user/follow-up
 * input. At the safe idle edge, earlier results are appended and the final
 * custom result starts exactly one model turn with the whole batch in context.
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
  return deliver;
}
