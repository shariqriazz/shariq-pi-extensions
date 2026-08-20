import type {
  OrchestratorDecision,
  OrchestrationTask,
  PlannedTask,
  ReviewDecision,
} from "./types.ts";

function objectFrom(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw new Error("Agent JSON result exceeds 1 MiB.");
  }
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Agent did not return a JSON object.");
  const value: unknown = JSON.parse(trimmed.slice(first, last + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent result must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, max = 64) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, max)
        .map((item) => item.slice(0, 4_000))
    : [];
}

function plannedTask(value: unknown): PlannedTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const roles = new Set(["explorer", "frontend", "backend", "general"]);
  if (
    typeof item.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) ||
    typeof item.title !== "string" ||
    typeof item.description !== "string" ||
    typeof item.role !== "string" ||
    !roles.has(item.role)
  ) return undefined;
  return {
    id: item.id.slice(0, 80),
    title: item.title.slice(0, 160),
    description: item.description.slice(0, 12_000),
    role: item.role as PlannedTask["role"],
    dependencies: strings(item.dependencies),
    acceptanceCriteria: strings(item.acceptanceCriteria),
  };
}

export function parseOrchestratorDecision(text: string): OrchestratorDecision {
  const raw = objectFrom(text);
  if (!new Set(["continue", "complete", "blocked"]).has(String(raw.decision))) {
    throw new Error("Orchestrator decision is invalid.");
  }
  if (typeof raw.summary !== "string") throw new Error("Orchestrator summary is missing.");
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.slice(0, 128).map(plannedTask).filter((task): task is PlannedTask => !!task)
    : [];
  return {
    decision: raw.decision as OrchestratorDecision["decision"],
    summary: raw.summary.slice(0, 16_000),
    tasks,
    blocker: typeof raw.blocker === "string" ? raw.blocker.slice(0, 8_000) : undefined,
  };
}

export function parseReviewDecision(text: string): ReviewDecision {
  const raw = objectFrom(text);
  if (typeof raw.passed !== "boolean" || typeof raw.summary !== "string") {
    throw new Error("Reviewer result is missing passed/summary.");
  }
  return {
    passed: raw.passed,
    summary: raw.summary.slice(0, 12_000),
    smallFixesApplied: strings(raw.smallFixesApplied),
    findings: strings(raw.findings),
    validation: strings(raw.validation),
  };
}

export function materializeTask(plan: PlannedTask): OrchestrationTask {
  return {
    ...plan,
    dependencies: plan.dependencies ?? [],
    acceptanceCriteria: plan.acceptanceCriteria ?? [],
    status: "pending",
    fixRounds: 0,
  };
}

export function validateTaskGraph(tasks: ReadonlyArray<OrchestrationTask>) {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("Task ids must be unique.");
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}.`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Task dependencies contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}
