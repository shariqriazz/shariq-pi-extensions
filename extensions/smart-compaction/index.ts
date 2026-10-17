import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { openModelPicker } from "../shared/model-picker.ts";
import {
  compactionThresholdTokens,
  loadSmartCompactionConfig,
  saveSmartCompactionConfig,
  type SmartCompactionConfig,
} from "./config.ts";
import { resolveCompactionModel, runSmartCompaction } from "./engine.ts";

const STATUS_KEY = "smart-compaction";

// Per-message sizes, cached because the context hook sees the same message objects on every request.
const messageSizes = new WeakMap<object, { tokens: number; bytes: number }>();

/** Pi's local token estimate and the serialized byte size of the messages a request will carry. */
export function measureMessages(messages: readonly AgentMessage[]): { tokens: number; bytes: number } {
  let tokens = 0;
  let bytes = 0;
  for (const message of messages) {
    let size = messageSizes.get(message);
    if (!size) {
      let serialized = 0;
      try {
        serialized = Buffer.byteLength(JSON.stringify(message) ?? "");
      } catch {
        // Unserializable messages count only toward the token estimate.
      }
      size = { tokens: estimateTokens(message), bytes: serialized };
      messageSizes.set(message, size);
    }
    tokens += size.tokens;
    bytes += size.bytes;
  }
  return { tokens, bytes };
}

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
          tools: () => pi.getAllTools(),
        });
        return { compaction };
      } catch (error) {
        if (event.signal.aborted) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify(`Smart Compaction failed: ${message}. Compaction cancelled to protect context.`, "error");
        // Fail-Closed: Return cancel: true so Pi aborts compaction and preserves all conversation context
        // rather than silently falling back to Pi's generic compactor.
        return { cancel: true };
      } finally {
        updateStatus();
      }
    });

    pi.on("session_compact", (event, ctx) => {
      if (event.fromExtension) {
        const details = event.compactionEntry.details as Record<string, unknown> | undefined;
        if (details?.customCompactor === "smart-compaction") {
          const model = String(details.resolvedModel ?? details.model ?? "session model");
          const sourceCharacters = Number(details.sourceCharacters ?? 0);
          const serializedCharacters = Number(details.serializedCharacters ?? 0);
          const durationMs = Number(details.durationMs ?? 0);
          const reduction = sourceCharacters > 0 && serializedCharacters > 0
            ? ` · input ${Math.max(0, Math.round((1 - (serializedCharacters / sourceCharacters)) * 100))}% smaller`
            : "";
          const duration = durationMs > 0 ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
          ctx.ui?.notify(`Smart Compaction completed (${model})${reduction}${duration}`, "info");
        }
      }
    });

    // Intercept manual /compact commands in interactive or RPC inputs
    pi.on("input", (event, ctx) => {
      const text = event.text.trim();
      if (text === "/compact" || text.startsWith("/compact ")) {
        const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
        ctx.compact(customInstructions ? { customInstructions } : undefined);
        return { action: "handled" };
      }
      return { action: "continue" };
    });

    // Smart Compaction's optional threshold policy is an upper-bound safeguard.
    // It runs from the context hook, where completed tool results are already in
    // context, rather than from tool_result itself. ctx.compact() aborts the
    // active run synchronously, before this hook returns, so the over-threshold
    // request is cancelled rather than sent. Pi's native reserve-token threshold
    // may still compact earlier. The size is the larger of the provider-reported
    // usage and Pi's local estimate, so usage a provider misreports cannot hide
    // growth; the optional byte ceiling catches requests that encrypted reasoning
    // makes large in bytes but not in tokens.
    let thresholdCompactionPending = false;
    pi.on("context", (event, ctx) => {
      if (!config.enabled || thresholdCompactionPending) return;
      const size = measureMessages(event.messages ?? []);
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const threshold = compactionThresholdTokens(config, contextWindow);
      const tokens = Math.max(usage?.tokens ?? 0, size.tokens);
      const overTokens = threshold !== undefined && tokens >= threshold;
      const overBytes = config.maxRequestBytes !== undefined && size.bytes >= config.maxRequestBytes;
      if (!overTokens && !overBytes) return;

      thresholdCompactionPending = true;
      ctx.compact({
        onComplete: () => {
          thresholdCompactionPending = false;
          pi.sendUserMessage("Continue.", { deliverAs: "followUp" });
        },
        onError: () => {
          thresholdCompactionPending = false;
        },
      });
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

        // The custom picker is a TUI component; RPC clients get a plain selector.
        if (cmdCtx.mode === "rpc" && cmdCtx.hasUI) {
          const choices = ["inherit", ...cmdCtx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`)];
          const selected = await cmdCtx.ui.select(`Compaction model (current: ${config.model})`, choices);
          if (!selected) return;
          config.model = selected;
          saveSmartCompactionConfig(config, options.configFile);
          updateStatus();
          cmdCtx.ui.notify(`Compaction model set to: ${config.model}`, "info");
          return;
        }

        if (cmdCtx.mode === "tui") {
          const selected = await openModelPicker(cmdCtx as never, {
            title: `Compaction Model (current: ${config.model})`,
            currentModel: config.model,
            extraChoices: [
              {
                id: "inherit",
                label: "inherit",
                description: `Use active session model (${cmdCtx.model ? `${cmdCtx.model.provider}/${cmdCtx.model.id}` : "none"})`,
              },
            ],
          });

          if (!selected) return;

          config.model = selected;
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

        const [setting, value] = sub.split(/\s+/, 2);
        if (setting === "threshold" && ["percent", "hard", "hybrid"].includes(value)) {
          config.thresholdMode = value as SmartCompactionConfig["thresholdMode"];
          saveSmartCompactionConfig(config, options.configFile);
          cmdCtx.ui.notify(`Compaction threshold mode set to: ${value}`, "info");
          return;
        }
        if (setting === "percent") {
          const percent = Number(value);
          if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
            cmdCtx.ui.notify("Usage: /smart-compaction percent <1-100>", "warning");
            return;
          }
          config.thresholdPercent = percent;
          saveSmartCompactionConfig(config, options.configFile);
          cmdCtx.ui.notify(`Compaction percentage set to: ${percent}%`, "info");
          return;
        }
        if (setting === "max-bytes") {
          if (value === "off") {
            config.maxRequestBytes = undefined;
          } else {
            const bytes = Number(value?.replaceAll(",", ""));
            if (!Number.isFinite(bytes) || bytes <= 0) {
              cmdCtx.ui.notify("Usage: /smart-compaction max-bytes <bytes|off>", "warning");
              return;
            }
            config.maxRequestBytes = Math.floor(bytes);
          }
          saveSmartCompactionConfig(config, options.configFile);
          cmdCtx.ui.notify(
            `Request byte ceiling: ${config.maxRequestBytes === undefined ? "off" : `${config.maxRequestBytes.toLocaleString()} bytes`}`,
            "info",
          );
          return;
        }
        if (setting === "hard-limit") {
          const tokens = Number(value?.replaceAll(",", ""));
          if (!Number.isFinite(tokens) || tokens <= 0) {
            cmdCtx.ui.notify("Usage: /smart-compaction hard-limit <tokens>", "warning");
            return;
          }
          config.hardLimitTokens = Math.floor(tokens);
          saveSmartCompactionConfig(config, options.configFile);
          cmdCtx.ui.notify(`Compaction hard limit set to: ${config.hardLimitTokens.toLocaleString()} tokens`, "info");
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
        const thresholdMode = config.thresholdMode ?? "hybrid";
        const thresholdDesc = thresholdMode === "percent"
          ? `${config.thresholdPercent ?? 95}%`
          : thresholdMode === "hard"
            ? `${(config.hardLimitTokens ?? 400_000).toLocaleString()} tokens`
            : `earliest of ${config.thresholdPercent ?? 95}% or ${(config.hardLimitTokens ?? 400_000).toLocaleString()} tokens`;

        const status = [
          `Smart Compaction: ${config.enabled ? "ENABLED" : "DISABLED"}`,
          `Configured Model: ${config.model}`,
          `Resolved Model: ${resolvedInfo}`,
          `Thinking Level: ${currentThinkingDesc}`,
          `Summary Token Ceiling: ${maxTokensDesc}`,
          `Threshold: ${thresholdMode} (${thresholdDesc})`,
          `Request Byte Ceiling: ${config.maxRequestBytes === undefined ? "off" : `${config.maxRequestBytes.toLocaleString()} bytes`}`,
          "",
          "Commands:",
          "  /smart-compaction enable | disable",
          "  /smart-compaction threshold percent | hard | hybrid",
          "  /smart-compaction percent <1-100>",
          "  /smart-compaction hard-limit <tokens>",
          "  /smart-compaction max-bytes <bytes|off>",
          "  /compaction-model [inherit | <provider/model>]",
        ].join("\n");

        cmdCtx.ui.notify(status, "info");
      },
    });
  };
}

export default createSmartCompactionExtension();
