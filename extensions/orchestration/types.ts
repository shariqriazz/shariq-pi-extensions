import type { ReasoningEffort } from "../subagents/src/domain.ts";

export const ORCHESTRATION_ROLES = [
  "orchestrator",
  "explorer",
  "frontend",
  "backend",
  "general",
  "reviewer",
] as const;
export type OrchestrationRole = (typeof ORCHESTRATION_ROLES)[number];

export interface RoleSettings {
  model?: string;
  thinking: ReasoningEffort;
}

export interface OrchestrationSettings {
  version: 1;
  maxWorkersPerProject: 10;
  roles: Record<OrchestrationRole, RoleSettings>;
}

export type TaskStatus =
  | "pending"
  | "implementing"
  | "reviewing"
  | "integrating"
  | "completed"
  | "blocked"
  | "cancelled";

export interface OrchestrationTask {
  id: string;
  title: string;
  description: string;
  role: Exclude<OrchestrationRole, "orchestrator" | "reviewer">;
  dependencies: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  workerAgentId?: string;
  reviewerAgentId?: string;
  fixRounds: number;
  lastWorkerSettledAt?: number;
  lastReviewerSettledAt?: number;
  reviewSummary?: string;
  filesChanged?: string[];
  error?: string;
}

export type RunStatus =
  | "planning"
  | "awaiting-approval"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface OrchestrationRun {
  id: string;
  objective: string;
  cwd: string;
  projectKey: string;
  gitBacked: boolean;
  status: RunStatus;
  summary: string;
  tasks: OrchestrationTask[];
  orchestratorAgentId?: string;
  orchestratorHandledAt?: number;
  finalReviewerAgentId?: string;
  finalReviewerHandledAt?: number;
  finalReviewPassed?: boolean;
  finalReviewSummary?: string;
  lastCoordinatedTaskState?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  role: OrchestrationTask["role"];
  dependencies?: string[];
  acceptanceCriteria?: string[];
}

export interface OrchestratorDecision {
  decision: "continue" | "complete" | "blocked";
  summary: string;
  tasks?: PlannedTask[];
  blocker?: string;
}

export interface ReviewDecision {
  passed: boolean;
  summary: string;
  smallFixesApplied?: string[];
  findings?: string[];
  validation?: string[];
}
