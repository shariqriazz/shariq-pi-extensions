import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapabilityMode, IsolationMode } from "./config.ts";
import type {
  ReasoningEffort,
  SubagentSnapshot,
} from "./domain.ts";

export const SUBAGENT_COORDINATOR_REQUEST =
  "shariq-pi-extensions:subagents:coordinator-request";

export interface CoordinatorSpawnOptions {
  message: string;
  taskName: string;
  cwd?: string;
  model?: string;
  thinking?: ReasoningEffort;
  capability: CapabilityMode;
  isolation: IsolationMode;
  agentType?: string;
  resumeFrom?: string;
  concurrencyGroup?: string;
  maxConcurrent?: number;
}

export interface SubagentCoordinator {
  spawn(
    ctx: ExtensionContext,
    options: CoordinatorSpawnOptions,
  ): Promise<SubagentSnapshot>;
  send(id: string, message: string): Promise<SubagentSnapshot>;
  cancel(ids: ReadonlyArray<string>): Promise<void>;
  get(id: string): Promise<SubagentSnapshot | undefined>;
  list(): Promise<ReadonlyArray<SubagentSnapshot>>;
  subscribe(listener: () => void): Promise<() => void>;
  apply(id: string, targetCwd?: string): Promise<{ changed: boolean; files: string[] }>;
  discard(id: string): Promise<void>;
  release(id: string): Promise<void>;
}

interface CoordinatorRequest {
  accept(coordinator: SubagentCoordinator): void;
}

export function requestSubagentCoordinator(
  events: EventBus,
): SubagentCoordinator | undefined {
  let coordinator: SubagentCoordinator | undefined;
  events.emit(SUBAGENT_COORDINATOR_REQUEST, {
    accept(value) {
      coordinator = value;
    },
  } satisfies CoordinatorRequest);
  return coordinator;
}

export function isCoordinatorRequest(
  value: unknown,
): value is CoordinatorRequest {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as CoordinatorRequest).accept === "function"
  );
}
