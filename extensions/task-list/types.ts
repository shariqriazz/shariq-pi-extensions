export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "cancelled",
] as const;

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskItem = {
  id: string;
  content: string;
  status: TaskStatus;
  priority: TaskPriority;
  note?: string;
  updatedAt: number;
};

export type TaskListState = {
  revision: number;
  tasks: TaskItem[];
  explanation?: string;
  updatedAt: number;
};

export type TaskListSnapshot = {
  state: TaskListState;
};

export type TaskListInput = {
  tasks?: Array<{
    id: string;
    content: string;
    status: TaskStatus;
    priority?: TaskPriority;
    note?: string;
  }>;
  explanation?: string;
};

export type TaskListDetails = {
  action: "read" | "update";
  state: TaskListState;
  counts: TaskCounts;
};

export type TaskCounts = {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  cancelled: number;
};
