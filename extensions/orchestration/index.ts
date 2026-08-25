import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clearActivitySource, setActivitySource } from "../shared/activity-dock.ts";
import { toolCallCard, toolResultCard } from "../shared/tool-card.ts";
import { oneLine } from "../shared/tui-dashboard.ts";
import {
  requestSubagentCoordinator,
  type SubagentCoordinator,
} from "../subagents/src/coordinator.ts";
import {
  notifyDashboard,
  openOrchestrationDashboard,
} from "./dashboard.ts";
import { OrchestrationEngine } from "./engine.ts";
import {
  loadOrchestrationSettings,
  missingRoleModels,
} from "./settings.ts";
import { openOrchestrationSettings } from "./settings-ui.ts";

export default function orchestration(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let coordinator: SubagentCoordinator | undefined;
  let engine: OrchestrationEngine | undefined;

  const currentContext = () => {
    if (!context) throw new Error("Orchestration requires an active Pi session.");
    return context;
  };

  const updateStatus = () => {
    if (!ui || !engine) return;
    const active = engine.list().filter((run) => !["completed", "cancelled"].includes(run.status));
    if (context) {
      setActivitySource(context, "orchestration", active.map((run) => {
        const done = run.tasks.filter((task) => task.status === "completed").length;
        const attention = run.status === "awaiting-approval";
        return {
          id: run.id,
          label: "Orchestration",
          title: run.objective,
          detail: `${attention ? "plan ready for review" : run.status} · ${done}/${run.tasks.length}`,
          state: run.status === "blocked" ? "error" as const : attention ? "warning" as const : ["planning", "running"].includes(run.status) ? "active" as const : "muted" as const,
          priority: attention ? 120 : run.status === "blocked" ? 110 : 45,
        };
      }));
    }
    if (!active.length) {
      ui.setStatus("orchestration", undefined);
      return;
    }
    ui.setStatus("orchestration", undefined);
  };

  const requireEngine = () => {
    if (!engine) {
      throw new Error(
        "Orchestration requires the Subagents extension to be enabled. Enable both in pi config and reload.",
      );
    }
    return engine;
  };

  const ensureModels = async (ctx: ExtensionContext) => {
    const missing = missingRoleModels(loadOrchestrationSettings());
    if (!missing.length) return;
    if (!ctx.hasUI) {
      throw new Error(`Configure orchestration role models first: ${missing.join(", ")}.`);
    }
    ctx.ui.notify(`Configure role models before starting: ${missing.join(", ")}.`, "warning");
    await openOrchestrationSettings(ctx);
    const remaining = missingRoleModels(loadOrchestrationSettings());
    if (remaining.length) throw new Error(`Role models still missing: ${remaining.join(", ")}.`);
  };

  const createFromUi = async (ctx: ExtensionContext) => {
    const objective = await ctx.ui.editor(
      "New orchestration objective",
      "Describe the complete outcome, boundaries, and requirements…",
    );
    if (!objective?.trim()) return;
    await ensureModels(ctx);
    try {
      const run = await requireEngine().create(objective, ctx.cwd);
      ctx.ui.notify(`Started dedicated planning agent for ${run.id}.`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const openDashboard = async (ctx: ExtensionContext) => {
    const current = requireEngine();
    while (true) {
      const action = await openOrchestrationDashboard(ctx, current);
      if (action.kind === "close") return;
      try {
        if (action.kind === "create") {
          await createFromUi(ctx);
          continue;
        }
        if (action.kind === "settings") {
          await openOrchestrationSettings(ctx);
          continue;
        }
        const run = current.get(action.id);
        if (!run) {
          ctx.ui.notify(`Orchestration ${action.id} is no longer available.`, "warning");
          continue;
        }
        if (action.kind === "feedback") {
          const feedback = await ctx.ui.editor("Plan feedback", "Tell the orchestrator what to change…");
          if (feedback?.trim()) await current.feedback(run.id, feedback);
        } else if (action.kind === "approve") {
          await current.approve(run.id);
        } else if (action.kind === "toggle-pause") {
          if (["paused", "interrupted", "blocked"].includes(run.status)) await current.resume(run.id);
          else await current.pause(run.id);
        } else if (action.kind === "cancel") {
          const confirmed = await ctx.ui.confirm("Cancel orchestration?", `Stop ${run.id} and preserve its run artifacts?`);
          if (confirmed) await current.cancel(run.id);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    coordinator = requestSubagentCoordinator(pi.events);
    if (!coordinator) {
      ctx.ui.notify(
        "Orchestration is enabled but Subagents is unavailable. Enable Subagents and reload.",
        "error",
      );
      return;
    }
    engine = new OrchestrationEngine(pi, coordinator, currentContext, {
      changed() {
        updateStatus();
        if (engine) notifyDashboard(engine);
      },
      notify(message, level = "info") {
        ui?.notify(message, level);
      },
    });
    await engine.start();
    updateStatus();
    const interrupted = engine.list().filter((run) => run.status === "interrupted");
    if (interrupted.length && ctx.hasUI) {
      ctx.ui.notify(
        `${interrupted.length} orchestration run${interrupted.length === 1 ? " was" : "s were"} recovered paused. Open /orchestration to resume.`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    engine?.stop();
    engine = undefined;
    coordinator = undefined;
    ui?.setStatus("orchestration", undefined);
    if (context) clearActivitySource(context, "orchestration");
    context = undefined;
    ui = undefined;
  });

  pi.registerCommand("orchestration", {
    description: "Open the orchestration dashboard, create a run, or configure role models",
    getArgumentCompletions: (prefix) =>
      ["new", "settings"]
        .filter((item) => item.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "settings") {
        await openOrchestrationSettings(ctx);
        return;
      }
      if (action === "new") {
        await createFromUi(ctx);
        return;
      }
      await openDashboard(ctx);
    },
  });

  pi.registerTool({
    name: "create_orchestration",
    label: "Create Orchestration",
    description:
      "Start a dedicated multi-agent orchestration only when the user explicitly asks to orchestrate a large task. The dedicated orchestrator prepares a plan for user review before autonomous execution.",
    promptSnippet:
      "Start an explicitly requested large-task orchestration with dedicated role models and a reviewable plan",
    promptGuidelines: [
      "Use create_orchestration only when the user explicitly asks to orchestrate or use Orchestration; never infer it from task size.",
      "After create_orchestration starts planning, tell the user to review the plan in /orchestration instead of starting separate subagents.",
    ],
    parameters: Type.Object({
      objective: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description: "Complete large-task objective, requirements, and boundaries",
      }),
      cwd: Type.Optional(
        Type.String({ description: "Project working directory; defaults to the current session cwd" }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await ensureModels(ctx);
      const run = await requireEngine().create(params.objective, params.cwd ?? ctx.cwd);
      return {
        content: [
          {
            type: "text",
            text: `Started ${run.id}. The dedicated orchestrator is preparing the plan. The user can review and discuss it in /orchestration before approving autonomous execution.`,
          },
        ],
        details: { id: run.id, status: run.status, cwd: run.cwd },
      };
    },
    renderCall(args, theme) {
      return new Text(toolCallCard(theme, "orchestration create", oneLine(args.objective).slice(0, 100), args.cwd ?? "current workspace"), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Starting orchestration…"), 0, 0);
      const details = result.details as { id?: string; status?: string; cwd?: string } | undefined;
      return new Text(toolResultCard(result, expanded, theme, "active", details?.id ?? "orchestration", `${details?.status ?? "planning"} · ${details?.cwd ?? "workspace"} · /orchestration`), 0, 0);
    },
  });

  pi.registerTool({
    name: "get_orchestration",
    label: "Get Orchestration",
    description: "Inspect orchestration runs without changing or advancing them.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Run id; omit to list all runs" })),
    }),
    async execute(_id, params) {
      const current = requireEngine();
      const runs = params.id
        ? [current.get(params.id)].filter(Boolean)
        : current.list();
      if (!runs.length) throw new Error(params.id ? `Unknown orchestration ${params.id}.` : "No orchestration runs.");
      return {
        content: [
          {
            type: "text",
            text: runs
              .map((run) => {
                const done = run!.tasks.filter((task) => task.status === "completed").length;
                return `${run!.id} [${run!.status}] ${done}/${run!.tasks.length} tasks · ${run!.objective}`;
              })
              .join("\n"),
          },
        ],
        details: { runs },
      };
    },
    renderCall(args, theme) {
      return new Text(toolCallCard(theme, "orchestration inspect", args.id ?? "all runs"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { runs?: Array<{ status?: string; tasks?: Array<{ status?: string }> }> } | undefined;
      const runs = details?.runs ?? [];
      const attention = runs.filter((run) => run.status === "awaiting-approval" || run.status === "blocked").length;
      const done = runs.reduce((total, run) => total + (run.tasks?.filter((task) => task.status === "completed").length ?? 0), 0);
      const total = runs.reduce((count, run) => count + (run.tasks?.length ?? 0), 0);
      return new Text(toolResultCard(result, expanded, theme, attention ? "warning" : runs.some((run) => run.status === "running" || run.status === "planning") ? "active" : "muted", "orchestration", `${runs.length} run${runs.length === 1 ? "" : "s"} · ${done}/${total} tasks${attention ? ` · ${attention} need attention` : ""}`), 0, 0);
    },
  });
}
