import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

export const MEMORY_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type MemoryReasoningLevel = typeof MEMORY_REASONING_LEVELS[number];

export interface MemoryModelConfig {
  provider: string;
  model: string;
  reasoning: MemoryReasoningLevel;
}

const DEFAULT_MEMORY_MODEL: MemoryModelConfig = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "max",
};

export interface MemoryConfig {
  root: string;
  databasePath: string;
  maxInjectedMemories: number;
  maxInjectedCharacters: number;
  maxSearchResults: number;
  extractionMaxInputCharacters: number;
  extractionMaxOutputTokens: number;
  jobLeaseMs: number;
  maxJobAttempts: number;
  enabledModes: ReadonlySet<string>;
  extractionModel: MemoryModelConfig;
}

function validModelConfig(value: unknown): value is MemoryModelConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MemoryModelConfig>;
  return typeof candidate.provider === "string" && candidate.provider.length > 0
    && typeof candidate.model === "string" && candidate.model.length > 0
    && MEMORY_REASONING_LEVELS.includes(candidate.reasoning as MemoryReasoningLevel);
}

export function loadMemoryModelConfig(root: string): MemoryModelConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")) as { extractionModel?: unknown };
    if (validModelConfig(parsed.extractionModel)) return { ...parsed.extractionModel };
  } catch {}
  return { ...DEFAULT_MEMORY_MODEL };
}

export function saveMemoryModelConfig(root: string, model: MemoryModelConfig): void {
  if (!validModelConfig(model)) throw new Error("invalid Pi Memory model configuration");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, "config.json");
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ extractionModel: model }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

export function defaultConfig(rootOverride?: string): MemoryConfig {
  const root = rootOverride ?? path.join(getAgentDir(), "pi-memory");
  return {
    root,
    databasePath: path.join(root, "memory.sqlite"),
    maxInjectedMemories: 10,
    maxInjectedCharacters: 12_000,
    maxSearchResults: 20,
    extractionMaxInputCharacters: 80_000,
    extractionMaxOutputTokens: 6_000,
    jobLeaseMs: 10 * 60 * 1_000,
    maxJobAttempts: 4,
    enabledModes: new Set(["tui", "rpc"]),
    extractionModel: loadMemoryModelConfig(root),
  };
}
