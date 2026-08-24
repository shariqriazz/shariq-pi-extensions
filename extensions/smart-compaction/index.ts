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
import { runSmartCompaction } from "./engine.ts";

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
      if (!config.enabled) {
        ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const modelLabel = config.model === "inherit" ? "inherit" : config.model.split("/").pop() ?? config.model;
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
      }
    });

    pi.on("session_compact", (event, ctx) => {
      if (event.fromExtension) {
        const details = event.compactionEntry.details as Record<string, unknown> | undefined;
        if (details?.customCompactor === "smart-compaction") {
          const model = String(details.model ?? "session model");
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

          // Validate if model exists in registry
          const available = cmdCtx.modelRegistry.getAvailable();
          const match = available.find(
            (m) => m.id === requested || `${m.provider}/${m.id}` === requested,
          );

          if (!match) {
            cmdCtx.ui.notify(`Model "${requested}" not found in available models. Setting anyway.`, "warning");
          }

          config.model = match ? `${match.provider}/${match.id}` : requested;
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
        if (sub.startsWith("model ")) {
          const target = args.trim().slice(6).trim();
          config.model = target || "inherit";
          saveSmartCompactionConfig(config, options.configFile);
          updateStatus();
          cmdCtx.ui.notify(`Smart Compaction model set to: ${config.model}`, "info");
          return;
        }

        // Default status
        const currentModelDesc = config.model === "inherit"
          ? `inherit (${cmdCtx.model ? `${cmdCtx.model.provider}/${cmdCtx.model.id}` : "active session model"})`
          : config.model;
        const currentThinkingDesc = config.thinkingLevel === "inherit"
          ? `inherit (${cmdCtx.thinkingLevel ?? "session default"})`
          : (config.thinkingLevel ?? "inherit");
        const maxTokensDesc = config.maxSummaryTokens ? `${config.maxSummaryTokens}` : "unlimited (full model output capacity)";

        const status = [
          `Smart Compaction: ${config.enabled ? "ENABLED" : "DISABLED"}`,
          `Model: ${currentModelDesc}`,
          `Thinking Level: ${currentThinkingDesc}`,
          `Max Output Tokens: ${maxTokensDesc}`,
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
