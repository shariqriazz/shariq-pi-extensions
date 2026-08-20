import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentCoordinator } from "../subagents/src/coordinator.ts";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import {
  finalReviewPrompt,
  initialOrchestratorPrompt,
  orchestratorContinuationPrompt,
  taskReviewPrompt,
  workerFixPrompt,
  workerPrompt,
} from "./prompts.ts";
import {
  materializeTask,
  parseOrchestratorDecision,
  parseReviewDecision,
  validateTaskGraph,
} from "./protocol.ts";
import { loadOrchestrationSettings } from "./settings.ts";
import { loadRuns, saveRun } from "./storage.ts";
import type {
  OrchestrationRole,
  OrchestrationRun,
  OrchestrationTask,
  ReviewDecision,
  OrchestrationSettings,
} from "./types.ts";

const MAX_FIX_ROUNDS = 2;
const WRITER_ROLES = new Set<OrchestrationRole>(["frontend", "backend", "general"]);

export interface EngineStorage {
  load(): OrchestrationRun[];
  save(run: OrchestrationRun): void;
}

export interface EngineHooks {
  changed(): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export class OrchestrationEngine {
  private readonly runs = new Map<string, OrchestrationRun>();
  private readonly pi: ExtensionAPI;
  private readonly coordinator: SubagentCoordinator;
  private readonly context: () => ExtensionContext;
  private readonly hooks: EngineHooks;
  private readonly settings: () => OrchestrationSettings;
  private readonly storage: EngineStorage;
  private reconciling = false;
  private reconcileAgain = false;
  private unsubscribe?: () => void;

  constructor(
    pi: ExtensionAPI,
    coordinator: SubagentCoordinator,
    context: () => ExtensionContext,
    hooks: EngineHooks,
    settings: () => OrchestrationSettings = loadOrchestrationSettings,
    storage: EngineStorage = { load: loadRuns, save: saveRun },
  ) {
    this.pi = pi;
    this.coordinator = coordinator;
    this.context = context;
    this.hooks = hooks;
    this.settings = settings;
    this.storage = storage;
    for (const run of storage.load()) this.runs.set(run.id, run);
  }

  async start() {
    this.unsubscribe = await this.coordinator.subscribe(() => void this.reconcile());
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string) {
    return this.runs.get(id);
  }

  private persist(run: OrchestrationRun) {
    run.updatedAt = Date.now();
    this.storage.save(run);
    this.hooks.changed();
  }

  private role(role: OrchestrationRole) {
    const value = this.settings().roles[role];
    if (!value.model) throw new Error(`Configure the ${role} model in /orchestration settings first.`);
    return value;
  }

  private async projectInfo(cwd: string) {
    const resolved = path.resolve(cwd);
    const root = await this.pi.exec("git", ["-C", resolved, "rev-parse", "--show-toplevel"]);
    if (root.code !== 0) {
      return {
        cwd: resolved,
        projectKey: createHash("sha256").update(resolved).digest("hex").slice(0, 16),
        git: false,
      };
    }
    const gitRoot = root.stdout.trim();
    const status = await this.pi.exec("git", ["-C", gitRoot, "status", "--porcelain", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error("Could not inspect the source repository.");
    if (status.stdout.trim()) {
      throw new Error("Writing orchestration requires a clean source checkout. Commit or stash existing changes first.");
    }
    return {
      cwd: gitRoot,
      projectKey: createHash("sha256").update(gitRoot).digest("hex").slice(0, 16),
      git: true,
    };
  }

  async create(objective: string, cwd = this.context().cwd) {
    const text = objective.trim();
    if (!text) throw new Error("Orchestration objective cannot be empty.");
    if ([...text].length > 20_000) throw new Error("Orchestration objective exceeds 20,000 characters.");
    const project = await this.projectInfo(cwd);
    const id = `orc_${randomUUID().slice(0, 12)}`;
    const run: OrchestrationRun = {
      id,
      objective: text,
      cwd: project.cwd,
      projectKey: project.projectKey,
      gitBacked: project.git,
      status: "planning",
      summary: "The dedicated orchestrator is preparing the plan.",
      tasks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.runs.set(id, run);
    this.persist(run);
    const orchestrator = this.role("orchestrator");
    try {
      const snapshot = await this.coordinator.spawn(this.context(), {
        message: initialOrchestratorPrompt(text),
        taskName: `orchestrator ${id}`,
        cwd: project.cwd,
        model: orchestrator.model,
        thinking: orchestrator.thinking,
        capability: "execute",
        isolation: project.git ? "worktree" : "none",
        agentType: "plan",
        concurrencyGroup: `orchestrator:${id}`,
        maxConcurrent: 1,
      });
      run.orchestratorAgentId = snapshot.id;
      this.persist(run);
      return run;
    } catch (error) {
      run.status = "blocked";
      run.error = error instanceof Error ? error.message : String(error);
      this.persist(run);
      throw error;
    }
  }

  async feedback(id: string, feedback: string) {
    const run = this.required(id);
    if (run.status !== "awaiting-approval" || !run.orchestratorAgentId) {
      throw new Error("Plan feedback is available only while awaiting approval.");
    }
    run.status = "planning";
    this.persist(run);
    await this.coordinator.send(
      run.orchestratorAgentId,
      `Revise the plan using this user feedback, then return the same JSON decision contract.\n\nFeedback:\n${feedback}\n\nCurrent plan:\n${JSON.stringify(run.tasks, null, 2)}`,
    );
  }

  async approve(id: string) {
    const run = this.required(id);
    if (run.status !== "awaiting-approval") throw new Error("This run is not awaiting plan approval.");
    run.status = "running";
    run.error = undefined;
    this.persist(run);
    await this.schedule(run);
  }

  async pause(id: string) {
    const run = this.required(id);
    run.status = "paused";
    const active = this.agentIds(run);
    if (active.length) {
      await this.coordinator.cancel(active);
      await Promise.all(active.map((id) => this.coordinator.release(id)));
    }
    this.persist(run);
  }

  async resume(id: string) {
    const run = this.required(id);
    if (!["paused", "interrupted", "blocked"].includes(run.status)) {
      throw new Error("Only paused, interrupted, or blocked runs can resume.");
    }
    for (const task of run.tasks) {
      if (["implementing", "reviewing", "integrating"].includes(task.status)) {
        task.status = "pending";
        task.reviewerAgentId = undefined;
      }
    }
    const orchestrator = run.orchestratorAgentId
      ? await this.coordinator.get(run.orchestratorAgentId)
      : undefined;
    if (run.orchestratorAgentId && !orchestrator) {
      const role = this.role("orchestrator");
      const resumed = await this.coordinator.spawn(this.context(), {
        message: orchestratorContinuationPrompt(run, "Recover this orchestration after Pi restarted."),
        taskName: `orchestrator ${run.id}`,
        cwd: run.cwd,
        model: role.model,
        thinking: role.thinking,
        capability: "execute",
        isolation: run.gitBacked ? "worktree" : "none",
        agentType: "plan",
        resumeFrom: run.orchestratorAgentId,
        concurrencyGroup: `orchestrator:${run.id}`,
        maxConcurrent: 1,
      });
      run.orchestratorAgentId = resumed.id;
    }
    run.status = run.tasks.length ? "running" : "planning";
    run.error = undefined;
    this.persist(run);
    if (run.status === "planning" && run.orchestratorAgentId) {
      await this.coordinator.send(
        run.orchestratorAgentId,
        orchestratorContinuationPrompt(run, "Resume after interruption."),
      );
    } else {
      await this.schedule(run);
    }
  }

  async cancel(id: string) {
    const run = this.required(id);
    const active = this.agentIds(run);
    if (active.length) {
      await this.coordinator.cancel(active);
      await Promise.all(active.map((agentId) => this.coordinator.release(agentId)));
    }
    run.status = "cancelled";
    for (const task of run.tasks) {
      if (!new Set(["completed", "cancelled"]).has(task.status)) task.status = "cancelled";
    }
    this.persist(run);
  }

  private required(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown orchestration ${id}.`);
    return run;
  }

  private agentIds(run: OrchestrationRun) {
    return [
      run.orchestratorAgentId,
      run.finalReviewerAgentId,
      ...run.tasks.flatMap((task) => [task.workerAgentId, task.reviewerAgentId]),
    ].filter((id): id is string => !!id);
  }

  private async reconcile() {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcileAgain = false;
        for (const run of this.list()) await this.reconcileRun(run);
      } while (this.reconcileAgain);
    } finally {
      this.reconciling = false;
    }
  }

  private async snapshot(id?: string) {
    return id ? this.coordinator.get(id) : undefined;
  }

  private async reconcileRun(run: OrchestrationRun) {
    if (["completed", "cancelled", "paused", "interrupted"].includes(run.status)) return;
    const orchestrator = await this.snapshot(run.orchestratorAgentId);
    if (
      orchestrator &&
      orchestrator.status !== "running" &&
      (orchestrator.settledAt ?? 0) > (run.orchestratorHandledAt ?? 0)
    ) {
      run.orchestratorHandledAt = orchestrator.settledAt;
      await this.handleOrchestrator(run, orchestrator);
      return;
    }
    if (run.status !== "running") return;

    for (const task of run.tasks) {
      if (task.status === "implementing") {
        const worker = await this.snapshot(task.workerAgentId);
        if (worker && worker.status !== "running" && (worker.settledAt ?? 0) > (task.lastWorkerSettledAt ?? 0)) {
          task.lastWorkerSettledAt = worker.settledAt;
          await this.handleWorker(run, task, worker);
          return;
        }
      } else if (task.status === "reviewing") {
        const reviewer = await this.snapshot(task.reviewerAgentId);
        if (reviewer && reviewer.status !== "running" && (reviewer.settledAt ?? 0) > (task.lastReviewerSettledAt ?? 0)) {
          task.lastReviewerSettledAt = reviewer.settledAt;
          await this.handleReviewer(run, task, reviewer);
          return;
        }
      }
    }

    const finalReviewer = await this.snapshot(run.finalReviewerAgentId);
    if (
      finalReviewer &&
      finalReviewer.status !== "running" &&
      (finalReviewer.settledAt ?? 0) > (run.finalReviewerHandledAt ?? 0)
    ) {
      run.finalReviewerHandledAt = finalReviewer.settledAt;
      await this.handleFinalReview(run, finalReviewer);
      return;
    }
    await this.schedule(run);
  }

  private async handleOrchestrator(run: OrchestrationRun, snapshot: SubagentSnapshot) {
    if (snapshot.status === "error") return this.block(run, snapshot.errorText ?? "Orchestrator failed.");
    try {
      const decision = parseOrchestratorDecision(snapshot.finalText);
      run.summary = decision.summary;
      if (decision.decision === "blocked") return this.block(run, decision.blocker ?? decision.summary);
      const taskCountBefore = run.tasks.length;
      if (run.status === "planning") {
        run.tasks = (decision.tasks ?? []).map(materializeTask);
      } else {
        const existing = new Set(run.tasks.map((task) => task.id));
        for (const task of decision.tasks ?? []) {
          if (!existing.has(task.id)) {
            run.tasks.push(materializeTask(task));
            existing.add(task.id);
          }
        }
      }
      validateTaskGraph(run.tasks);
      if (decision.decision === "complete" && run.finalReviewPassed) {
        await this.complete(run);
        return;
      }
      if (run.status === "planning") {
        if (!run.tasks.length) return this.block(run, "The orchestrator returned no executable tasks.");
        run.status = "awaiting-approval";
        this.persist(run);
        this.hooks.notify(`Orchestration ${run.id} plan is ready. Open /orchestration to review it.`);
        return;
      }
      if (
        decision.decision === "continue" &&
        run.finalReviewPassed === false &&
        run.tasks.length === taskCountBefore
      ) {
        return this.block(run, "Final review failed, but the orchestrator did not create corrective work.");
      }
      run.status = "running";
      run.finalReviewerAgentId = undefined;
      run.finalReviewerHandledAt = undefined;
      this.persist(run);
      await this.schedule(run);
    } catch (error) {
      this.block(run, `Invalid orchestrator result: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleWorker(run: OrchestrationRun, task: OrchestrationTask, worker: SubagentSnapshot) {
    if (worker.status === "error") {
      task.error = worker.errorText ?? "Worker failed.";
      if (task.fixRounds >= MAX_FIX_ROUNDS || !task.workerAgentId) {
        task.status = "blocked";
        return this.block(run, `Worker ${task.id} failed after ${MAX_FIX_ROUNDS} recovery rounds: ${task.error}`);
      }
      task.fixRounds++;
      task.status = "implementing";
      this.persist(run);
      await this.coordinator.send(
        task.workerAgentId,
        `Your previous run failed: ${task.error}\n\nRecover in the same task worktree, inspect the current state, complete the original assignment, and rerun targeted validation. Do not commit or push.`,
      );
      return;
    }
    if (task.role === "explorer") {
      task.status = "completed";
      task.reviewSummary = worker.finalText.slice(0, 12_000);
      await this.coordinator.release(worker.id);
      this.persist(run);
      await this.schedule(run);
      return;
    }
    task.status = "reviewing";
    task.reviewerAgentId = undefined;
    this.persist(run);
    await this.spawnTaskReviewer(run, task, worker);
  }

  private async handleReviewer(run: OrchestrationRun, task: OrchestrationTask, reviewer: SubagentSnapshot) {
    if (reviewer.status === "error") return this.block(run, reviewer.errorText ?? `Reviewer failed for ${task.id}.`);
    let review: ReviewDecision;
    try {
      review = parseReviewDecision(reviewer.finalText);
    } catch (error) {
      return this.block(run, `Invalid review for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    task.reviewSummary = review.summary;
    await this.coordinator.release(reviewer.id);
    if (!review.passed) {
      if (task.fixRounds >= MAX_FIX_ROUNDS) {
        task.status = "blocked";
        task.error = `Review still failed after ${MAX_FIX_ROUNDS} fix rounds: ${review.summary}`;
        return this.block(run, task.error);
      }
      task.fixRounds++;
      task.status = "implementing";
      task.reviewerAgentId = undefined;
      this.persist(run);
      if (!task.workerAgentId) return this.block(run, `Missing original worker for ${task.id}.`);
      await this.coordinator.send(task.workerAgentId, workerFixPrompt(task, review));
      return;
    }
    await this.integrateTask(run, task);
  }

  private async integrationPath(run: OrchestrationRun) {
    const orchestrator = await this.snapshot(run.orchestratorAgentId);
    return orchestrator?.meta.worktree?.path;
  }

  private async integrateTask(run: OrchestrationRun, task: OrchestrationTask) {
    task.status = "integrating";
    this.persist(run);
    try {
      if (!task.workerAgentId) throw new Error("Missing worker agent id.");
      const target = await this.integrationPath(run);
      if (target) {
        const result = await this.coordinator.apply(task.workerAgentId, target);
        task.filesChanged = result.files;
        if (result.changed) {
          const add = await this.pi.exec("git", ["-C", target, "add", "-A", "--", "."]);
          if (add.code !== 0) throw new Error(add.stderr || "Could not stage internal integration changes.");
          const commit = await this.pi.exec("git", [
            "-C", target,
            "-c", "user.name=Pi Orchestration",
            "-c", "user.email=pi-orchestration@localhost",
            "commit", "-m", `Integrate orchestration task ${task.id}`,
          ]);
          if (commit.code !== 0) throw new Error(commit.stderr || "Could not create internal integration commit.");
        }
        await this.coordinator.discard(task.workerAgentId);
      }
      task.status = "completed";
      task.error = undefined;
      this.persist(run);
      await this.schedule(run);
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error);
      if (task.fixRounds < MAX_FIX_ROUNDS && task.workerAgentId) {
        task.fixRounds++;
        task.status = "implementing";
        const orchestrator = await this.snapshot(run.orchestratorAgentId);
        const branch = orchestrator?.meta.worktree?.branch;
        this.persist(run);
        await this.coordinator.send(
          task.workerAgentId,
          `Integration found a conflict: ${task.error}\n\nUpdate this same task worktree against the current orchestration integration${branch ? ` branch ${branch}` : " workspace"}, resolve only the task-related conflicts, preserve reviewed changes, rerun validation, and return an updated handoff. Do not commit or push.`,
        );
        return;
      }
      task.status = "blocked";
      this.block(run, `Integration failed for ${task.id}: ${task.error}`);
    }
  }

  private async schedule(run: OrchestrationRun) {
    if (run.status !== "running") return;
    const blockedDependency = run.tasks.find(
      (task) => task.status === "pending" && task.dependencies.some((id) => run.tasks.find((item) => item.id === id)?.status === "blocked"),
    );
    if (blockedDependency) return this.block(run, `Task ${blockedDependency.id} depends on blocked work.`);

    const active = run.tasks.filter(
      (task) =>
        task.status === "implementing" ||
        task.status === "integrating" ||
        (task.status === "reviewing" && !!task.reviewerAgentId),
    ).length;
    const completedState = run.tasks
      .filter((task) => task.status === "completed")
      .map((task) => `${task.id}:${task.reviewSummary ?? "done"}`)
      .sort()
      .join("|");
    if (
      active === 0 &&
      completedState &&
      completedState !== run.lastCoordinatedTaskState
    ) {
      run.lastCoordinatedTaskState = completedState;
      this.persist(run);
      await this.wakeOrchestrator(run, "A worker wave settled. Review the completed task evidence and coordinate the next step.");
      return;
    }
    let slots = Math.max(0, 10 - active);
    const gitBacked = !!(await this.integrationPath(run));
    for (const task of run.tasks) {
      if (slots <= 0) break;
      if (task.status !== "reviewing" || task.reviewerAgentId || !task.workerAgentId) continue;
      const worker = await this.snapshot(task.workerAgentId);
      if (!worker) continue;
      const started = await this.spawnTaskReviewer(run, task, worker);
      if (started) slots--;
    }
    const activeWriter = this.list().some(
      (candidate) =>
        candidate.projectKey === run.projectKey &&
        candidate.tasks.some(
          (task) =>
            WRITER_ROLES.has(task.role) &&
            ["implementing", "reviewing", "integrating"].includes(task.status),
        ),
    );
    for (const task of run.tasks) {
      if (slots <= 0) break;
      if (task.status !== "pending") continue;
      if (!task.dependencies.every((id) => run.tasks.find((item) => item.id === id)?.status === "completed")) continue;
      if (!gitBacked && WRITER_ROLES.has(task.role) && activeWriter) continue;
      const started = await this.spawnTask(run, task, gitBacked);
      if (!started) break;
      slots--;
      if (!gitBacked && WRITER_ROLES.has(task.role)) break;
    }

    const unfinished = run.tasks.some((task) => task.status !== "completed" && task.status !== "cancelled");
    const nowActive = run.tasks.some((task) => ["implementing", "reviewing", "integrating"].includes(task.status));
    if (!unfinished && !nowActive && !run.finalReviewerAgentId) {
      await this.spawnFinalReview(run, gitBacked);
    }
  }

  private async spawnTaskReviewer(
    run: OrchestrationRun,
    task: OrchestrationTask,
    worker: SubagentSnapshot,
  ) {
    const role = this.role("reviewer");
    const worktree = worker.meta.worktree?.path;
    const integration = await this.integrationPath(run);
    if (integration && !worktree) {
      this.block(run, `Writer ${task.id} has no isolated worktree.`);
      return false;
    }
    try {
      const reviewer = await this.coordinator.spawn(this.context(), {
        message: taskReviewPrompt(run, task),
        taskName: `review ${task.id}`,
        cwd: worktree ?? run.cwd,
        model: role.model,
        thinking: role.thinking,
        capability: "all",
        isolation: "none",
        agentType: "general-purpose",
        concurrencyGroup: `orchestration:${run.projectKey}`,
        maxConcurrent: 10,
      });
      task.reviewerAgentId = reviewer.id;
      this.persist(run);
      return true;
    } catch (error) {
      if (/concurrent|capacity/i.test(error instanceof Error ? error.message : String(error))) return false;
      this.block(run, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async spawnTask(run: OrchestrationRun, task: OrchestrationTask, gitBacked: boolean) {
    const role = this.role(task.role);
    const base = (await this.integrationPath(run)) ?? run.cwd;
    const writer = WRITER_ROLES.has(task.role);
    try {
      const snapshot = await this.coordinator.spawn(this.context(), {
        message: workerPrompt(run, task),
        taskName: `${task.role} ${task.id}`,
        cwd: base,
        model: role.model,
        thinking: role.thinking,
        capability: task.role === "explorer" ? "execute" : "all",
        isolation: writer && gitBacked ? "worktree" : "none",
        agentType: task.role === "explorer" ? "explore" : "general-purpose",
        resumeFrom: task.workerAgentId,
        concurrencyGroup: `orchestration:${run.projectKey}`,
        maxConcurrent: 10,
      });
      task.workerAgentId = snapshot.id;
      task.status = "implementing";
      this.persist(run);
      return true;
    } catch (error) {
      if (/concurrent|capacity/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  private async spawnFinalReview(run: OrchestrationRun, gitBacked: boolean) {
    const role = this.role("reviewer");
    const cwd = (await this.integrationPath(run)) ?? run.cwd;
    try {
      const snapshot = await this.coordinator.spawn(this.context(), {
        message: finalReviewPrompt(run),
        taskName: `final review ${run.id}`,
        cwd,
        model: role.model,
        thinking: role.thinking,
        capability: "execute",
        isolation: "none",
        agentType: "explore",
        concurrencyGroup: `orchestration:${run.projectKey}`,
        maxConcurrent: 10,
      });
      run.finalReviewerAgentId = snapshot.id;
      run.finalReviewPassed = undefined;
      this.persist(run);
    } catch (error) {
      if (!/concurrent|capacity/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }

  private async handleFinalReview(run: OrchestrationRun, snapshot: SubagentSnapshot) {
    if (snapshot.status === "error") return this.block(run, snapshot.errorText ?? "Final review failed.");
    try {
      const review = parseReviewDecision(snapshot.finalText);
      run.finalReviewPassed = review.passed;
      run.finalReviewSummary = review.summary;
      await this.coordinator.release(snapshot.id);
      this.persist(run);
      await this.wakeOrchestrator(
        run,
        review.passed
          ? `Final holistic review passed: ${review.summary}`
          : `Final holistic review failed. Findings: ${(review.findings ?? []).join("; ")}`,
      );
    } catch (error) {
      this.block(run, `Invalid final review: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async wakeOrchestrator(run: OrchestrationRun, event: string) {
    if (!run.orchestratorAgentId) return this.block(run, "Dedicated orchestrator session is unavailable.");
    run.status = "running";
    this.persist(run);
    await this.coordinator.send(
      run.orchestratorAgentId,
      orchestratorContinuationPrompt(run, event),
    );
  }

  private async complete(run: OrchestrationRun) {
    try {
      const integration = await this.integrationPath(run);
      if (integration && run.orchestratorAgentId) {
        const status = await this.pi.exec("git", ["-C", run.cwd, "status", "--porcelain", "--untracked-files=all"]);
        if (status.code !== 0 || status.stdout.trim()) {
          throw new Error("The source checkout changed during orchestration; final integration requires it to remain clean.");
        }
        await this.coordinator.apply(run.orchestratorAgentId);
        await this.coordinator.discard(run.orchestratorAgentId);
      } else if (run.orchestratorAgentId) {
        await this.coordinator.release(run.orchestratorAgentId);
      }
      run.status = "completed";
      run.completedAt = Date.now();
      run.error = undefined;
      this.persist(run);
      this.hooks.notify(`Orchestration ${run.id} completed and integrated.`, "info");
    } catch (error) {
      this.block(run, `Final integration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private block(run: OrchestrationRun, message: string) {
    run.status = "blocked";
    run.error = message;
    this.persist(run);
    this.hooks.notify(`Orchestration ${run.id} needs attention: ${message}`, "warning");
  }
}
