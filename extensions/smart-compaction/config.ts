import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SmartCompactionConfig {
  version: 1;
  enabled: boolean;
  model: string; // "inherit" or "provider/model-id"
  thinkingLevel?: "off" | "low" | "medium" | "high";
  maxSummaryTokens?: number;
}

export const DEFAULT_SMART_COMPACTION_CONFIG: SmartCompactionConfig = {
  version: 1,
  enabled: true,
  model: "inherit",
  thinkingLevel: "medium",
  maxSummaryTokens: 16384,
};

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
      thinkingLevel: raw.thinkingLevel && ["off", "low", "medium", "high"].includes(raw.thinkingLevel)
        ? raw.thinkingLevel
        : DEFAULT_SMART_COMPACTION_CONFIG.thinkingLevel,
      maxSummaryTokens: typeof raw.maxSummaryTokens === "number" && raw.maxSummaryTokens > 0
        ? raw.maxSummaryTokens
        : DEFAULT_SMART_COMPACTION_CONFIG.maxSummaryTokens,
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
    thinkingLevel: config.thinkingLevel ?? "medium",
    maxSummaryTokens: config.maxSummaryTokens ?? 16384,
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
