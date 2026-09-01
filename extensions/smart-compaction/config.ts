import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CompactionThresholdMode = "percent" | "hard" | "hybrid";

export interface SmartCompactionConfig {
  version: 1;
  enabled: boolean;
  model: string; // "inherit" or "provider/model-id"
  thinkingLevel?: "inherit" | "off" | "low" | "medium" | "high" | "max";
  maxSummaryTokens?: number; // optional override; defaults to dynamic model maxTokens
  thresholdMode?: CompactionThresholdMode;
  thresholdPercent?: number;
  hardLimitTokens?: number;
}

export const DEFAULT_SMART_COMPACTION_CONFIG: SmartCompactionConfig = {
  version: 1,
  enabled: true,
  model: "inherit",
  thinkingLevel: "inherit",
  thresholdMode: "hybrid",
  thresholdPercent: 95,
  hardLimitTokens: 400_000,
};

export function compactionThresholdTokens(config: SmartCompactionConfig, contextWindow: number): number | undefined {
  const mode = config.thresholdMode ?? DEFAULT_SMART_COMPACTION_CONFIG.thresholdMode ?? "hybrid";
  const percent = config.thresholdPercent ?? DEFAULT_SMART_COMPACTION_CONFIG.thresholdPercent ?? 95;
  const hardLimit = config.hardLimitTokens ?? DEFAULT_SMART_COMPACTION_CONFIG.hardLimitTokens ?? 400_000;
  const percentLimit = contextWindow > 0 ? Math.floor(contextWindow * (percent / 100)) : undefined;
  if (mode === "percent") return percentLimit;
  if (mode === "hard") return hardLimit;
  return percentLimit === undefined ? hardLimit : Math.min(percentLimit, hardLimit);
}

export function smartCompactionConfigPath(): string {
  return path.join(getAgentDir(), "smart-compaction.json");
}

export function loadSmartCompactionConfig(file = smartCompactionConfigPath()): SmartCompactionConfig {
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_SMART_COMPACTION_CONFIG };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SmartCompactionConfig>;
    return {
      version: 1,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SMART_COMPACTION_CONFIG.enabled,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_SMART_COMPACTION_CONFIG.model,
      thinkingLevel: raw.thinkingLevel && ["inherit", "off", "low", "medium", "high", "max"].includes(raw.thinkingLevel)
        ? (raw.thinkingLevel as SmartCompactionConfig["thinkingLevel"])
        : DEFAULT_SMART_COMPACTION_CONFIG.thinkingLevel,
      maxSummaryTokens: typeof raw.maxSummaryTokens === "number" && raw.maxSummaryTokens > 0
        ? raw.maxSummaryTokens
        : undefined,
      thresholdMode: raw.thresholdMode && ["percent", "hard", "hybrid"].includes(raw.thresholdMode)
        ? raw.thresholdMode as CompactionThresholdMode
        : DEFAULT_SMART_COMPACTION_CONFIG.thresholdMode,
      thresholdPercent: typeof raw.thresholdPercent === "number" && raw.thresholdPercent > 0 && raw.thresholdPercent <= 100
        ? raw.thresholdPercent
        : DEFAULT_SMART_COMPACTION_CONFIG.thresholdPercent,
      hardLimitTokens: typeof raw.hardLimitTokens === "number" && raw.hardLimitTokens > 0
        ? Math.floor(raw.hardLimitTokens)
        : DEFAULT_SMART_COMPACTION_CONFIG.hardLimitTokens,
    };
  } catch {
    return { ...DEFAULT_SMART_COMPACTION_CONFIG };
  }
}

export function saveSmartCompactionConfig(config: SmartCompactionConfig, file = smartCompactionConfigPath()): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const document: SmartCompactionConfig = {
    version: 1,
    enabled: config.enabled,
    model: config.model || "inherit",
    thinkingLevel: config.thinkingLevel ?? "inherit",
    thresholdMode: config.thresholdMode ?? DEFAULT_SMART_COMPACTION_CONFIG.thresholdMode,
    thresholdPercent: config.thresholdPercent ?? DEFAULT_SMART_COMPACTION_CONFIG.thresholdPercent,
    hardLimitTokens: config.hardLimitTokens ?? DEFAULT_SMART_COMPACTION_CONFIG.hardLimitTokens,
    ...(typeof config.maxSummaryTokens === "number" && config.maxSummaryTokens > 0
      ? { maxSummaryTokens: config.maxSummaryTokens }
      : {}),
  };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}
