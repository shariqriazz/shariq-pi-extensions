import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  loadSmartCompactionConfig,
  saveSmartCompactionConfig,
  type SmartCompactionConfig,
} from "./config.ts";
import { resolveCompactionModel, runSmartCompaction } from "./engine.ts";

const STATUS_KEY = "smart-compaction";

export interface SmartCompactionExtensionOptions {
  configFile?: string;
}

export function createSmartCompactionExtension(options: SmartCompactionExtensionOptions = {}) {
  return (pi: ExtensionAPI) => {
    let config: SmartCompactionConfig = loadSmartCompactionConfig(options.configFile);
    let ui: ExtensionUIContext | undefined;

    const updateStatus = () => {
      if (!ui) return;
      if (!config.enabled || config.model === "inherit") {
        ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const modelLabel = config.model.split("/").pop() ?? config.model;
      ui.setStatus(STATUS_KEY, `compact: ${modelLabel}`);
    };

    pi.on("session_start", (_event, ctx) => {
      ui = ctx.ui;
      updateStatus();
    });

    pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
      if (!config.enabled) {
        return undefined;
      }

      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "compacting…");
      try {
        const compaction = await runSmartCompaction({
          event,
          ctx,
          config,
        });
        return { compaction };
      } catch (error) {
        if (event.signal.aborted) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify(`Smart Compaction failed: ${message}. Falling back to default compactor.`, "warning");
        return undefined;
      } finally {
        updateStatus();
      }
    });

    pi.on("session_compact", (event, ctx) => {
      if (event.fromExtension) {
        const details = event.compactionEntry.details as Record<string, unknown> | undefined;
        if (details?.customCompactor === "smart-compaction") {
          const model = String(details.resolvedModel ?? details.model ?? "session model");
          ctx.ui?.notify(`Smart Compaction completed (${model})`, "info");
        }
      }
    });

    // Slash command: /compaction-model
    pi.registerCommand("compaction-model", {
      description: "Select or view the model used for smart context compaction (default: inherit).",
      handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
        const requested = args.trim();

        if (requested) {
          if (requested === "inherit") {
            config.model = "inherit";
            saveSmartCompactionConfig(config, options.configFile);
            updateStatus();
            cmdCtx.ui.notify("Compaction model set to: inherit (active session model)", "info");
            return;
          }

          // Strict validation against available models in registry
          const available = cmdCtx.modelRegistry.getAvailable();
          const match = available.find(
            (m) => m.id === requested || `${m.provider}/${m.id}` === requested,
          );

          if (!match) {
            cmdCtx.ui.notify(
              `Model "${requested}" not found in available models. Run /compaction-model without arguments to select from active providers.`,
              "error",
            );
            return;
          }

          config.model = `${match.provider}/${match.id}`;
          saveSmartCompactionConfig(config, options.configFile);
          updateStatus();
          cmdCtx.ui.notify(`Compaction model set to: ${config.model}`, "info");
          return;
        }

        if (cmdCtx.hasUI) {
          const available = cmdCtx.modelRegistry.getAvailable();
          const choices = [
            `inherit (active session model: ${cmdCtx.model ? `${cmdCtx.model.provider}/${cmdCtx.model.id}` : "none"})`,
            ...available.map((m) => `${m.provider}/${m.id}`),
          ];

          const selected = await cmdCtx.ui.select(
            `Select Compaction Model (current: ${config.model})`,
            choices,
          );

          if (!selected) return;

          if (selected.startsWith("inherit")) {
            config.model = "inherit";
          } else {
            config.model = selected;
          }

          saveSmartCompactionConfig(config, options.configFile);
          updateStatus();
          cmdCtx.ui.notify(`Compaction model set to: ${config.model}`, "info");
          return;
        }

        cmdCtx.ui.notify(
          `Compaction model: ${config.model}. Usage: /compaction-model [inherit|<provider/model>]`,
          "info",
        );
      },
    });

    // Slash command: /smart-compaction
    pi.registerCommand("smart-compaction", {
      description: "Manage smart context compaction settings (enable/disable/status).",
      handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
        const sub = args.trim().toLowerCase();
        if (sub === "enable" || sub === "on") {
          config.enabled = true;
          saveSmartCompactionConfig(config, options.configFile);
          updateStatus();
          cmdCtx.ui.notify("Smart Compaction enabled.", "info");
          return;
        }
        if (sub === "disable" || sub === "off") {
          config.enabled = false;
          saveSmartCompactionConfig(config, options.configFile);
          updateStatus();
          cmdCtx.ui.notify("Smart Compaction disabled (using default compactor).", "info");
          return;
        }

        let resolvedInfo = "inherit";
        try {
          const { model, isFallback, fallbackReason } = resolveCompactionModel(cmdCtx, config.model);
          resolvedInfo = `${model.provider}/${model.id}`;
          if (isFallback) {
            resolvedInfo += ` (FALLBACK: ${fallbackReason})`;
          }
        } catch {
          resolvedInfo = "unresolved";
        }

        const currentThinkingDesc = config.thinkingLevel === "inherit"
          ? `inherit (${cmdCtx.thinkingLevel ?? "session default"})`
          : (config.thinkingLevel ?? "inherit");
        const maxTokensDesc = typeof config.maxSummaryTokens === "number"
          ? `${config.maxSummaryTokens} tokens (custom override)`
          : "dynamic (full model capacity)";

        const status = [
          `Smart Compaction: ${config.enabled ? "ENABLED" : "DISABLED"}`,
          `Configured Model: ${config.model}`,
          `Resolved Model: ${resolvedInfo}`,
          `Thinking Level: ${currentThinkingDesc}`,
          `Summary Token Ceiling: ${maxTokensDesc}`,
          "",
          "Commands:",
          "  /smart-compaction enable | disable",
          "  /compaction-model [inherit | <provider/model>]",
        ].join("\n");

        cmdCtx.ui.notify(status, "info");
      },
    });
  };
}

export default createSmartCompactionExtension();
