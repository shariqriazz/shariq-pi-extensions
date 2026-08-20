export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
export type GoalProgressStatus = "pending" | "in_progress" | "complete" | "blocked";
export type GoalSuppressionReason = "no_tool_progress" | "interrupted" | "error";

export type GoalProgressItem = {
  id: string;
  title: string;
  status: GoalProgressStatus;
  evidence?: string;
  updatedAt: number;
};

export type GoalContinuationSuppression = {
  reason: GoalSuppressionReason;
  message: string;
  at: number;
};

export type GoalState = {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  activeStartedAt: number | null;
  progress: GoalProgressItem[];
  blockedTurnStreak: number;
  blockedSignature: string | null;
  continuationSuppressed: GoalContinuationSuppression | null;
};

export type GoalSnapshot = {
  goal: GoalState | null;
};

export type GoalCreateParams = {
  objective: string;
  token_budget?: number;
};

export type GoalUpdateParams = {
  status: "complete" | "blocked";
};

export type GoalProgressParams = {
  items: Array<{
    id: string;
    title: string;
    status: GoalProgressStatus;
    evidence?: string;
  }>;
  remove_ids?: string[];
};
