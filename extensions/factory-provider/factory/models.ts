import { FACTORY_API_BASE_URL } from "./constants.ts";
import { droidExecHelp } from "./droid.ts";
import {
  billingPoolForModel,
  type FactoryBillingPool,
} from "./limits.ts";

export type FactoryModel = {
  id: string;
  name: string;
  reasoning: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  contextWindow: number;
  maxTokens: number;
  images: boolean;
  pdf: boolean;
  api: "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";
  baseUrl: string;
  apiProvider?: string;
  billingPool: FactoryBillingPool;
};

type BinaryCapability = Omit<FactoryModel, "id" | "name" | "reasoning" | "supportedReasoningEfforts" | "defaultReasoningEffort" | "api" | "baseUrl" | "apiProvider" | "billingPool"> & Partial<Pick<FactoryModel, "api" | "baseUrl" | "apiProvider">>;

// Tracks the current Droid embedded registry; re-check the active binary after Droid upgrades.
// Re-check with UPDATING.md when Droid changes. Keep only the latest/current model per
// family to avoid cluttering Pi's model picker with older Factory models.
const BINARY_CAPABILITIES: Record<string, BinaryCapability> = {
  "claude-opus-5": { contextWindow: 867_000, maxTokens: 128_000, images: true, pdf: true },
  "claude-opus-5-fast": { contextWindow: 867_000, maxTokens: 128_000, images: true, pdf: true },
  "claude-fable-5": { contextWindow: 867_000, maxTokens: 128_000, images: true, pdf: true },
  "claude-sonnet-5": { contextWindow: 872_000, maxTokens: 128_000, images: true, pdf: true },
  "claude-haiku-4-5-20251001": { contextWindow: 180_000, maxTokens: 32_000, images: true, pdf: true },
  "gpt-5.6-sol": { contextWindow: 1_050_000, maxTokens: 128_000, images: true, pdf: true },
  "gpt-5.6-terra": { contextWindow: 1_050_000, maxTokens: 128_000, images: true, pdf: true },
  "gpt-5.6-luna": { contextWindow: 1_050_000, maxTokens: 128_000, images: true, pdf: true },
  "gpt-5.5-pro": { contextWindow: 1_050_000, maxTokens: 128_000, images: true, pdf: true },
  "gemini-3.1-pro-preview": { contextWindow: 1_000_000, maxTokens: 65_536, images: true, pdf: true },
  "gemini-3.7-flash": { contextWindow: 1_000_000, maxTokens: 65_536, images: true, pdf: true },
  "grok-4.6": { contextWindow: 200_000, maxTokens: 63_356, images: true, pdf: false },
  "minimax-m3": { contextWindow: 512_000, maxTokens: 64_000, images: true, pdf: false },
  "glm-5.2": { contextWindow: 1_040_000, maxTokens: 131_072, images: false, pdf: false },
  "glm-5.2-fast": { contextWindow: 524_288, maxTokens: 131_072, images: false, pdf: false },
  // Kimi documents a 1,048,576-token context and a 131,072-token default
  // completion limit. Droid 0.200.0 still embeds a conservative 262,144/65,536
  // proxy entry, so keep this explicit product-capability override.
  "kimi-k3": { contextWindow: 1_048_576, maxTokens: 131_072, images: true, pdf: false },
  "inkling": { contextWindow: 1_040_000, maxTokens: 32_768, images: true, pdf: false },
  "nemotron-3-ultra": { contextWindow: 202_000, maxTokens: 65_536, images: false, pdf: false },
  "deepseek-v4-flash-0731": { contextWindow: 1_040_000, maxTokens: 131_072, images: false, pdf: false },
  "deepseek-v4-pro": { contextWindow: 1_040_000, maxTokens: 65_536, images: false, pdf: false },
};

const HIDDEN_MODEL_IDS = new Set([
  "claude-haiku-4-5-20251001",
  "claude-opus-5",
  "gemini-3.1-pro-preview",
  "glm-5.2-fast",
  "inkling",
  "minimax-m3",
  "nemotron-3-ultra",
]);

const ACTIVE_MODEL_IDS = new Set(Object.keys(BINARY_CAPABILITIES).filter((id) =>
  !id.endsWith("-fast") && !HIDDEN_MODEL_IDS.has(id),
));

// OpenRouter provider telemetry checked 2026-07-29. Prefer throughput and
// latency, with uptime and available context as reliability constraints.
const FACTORY_CORE_PROVIDER_OVERRIDES: Record<string, "fireworks" | "baseten"> = {
  "kimi-k3": "fireworks",
  "glm-5.2": "baseten",
  "glm-5.2-fast": "fireworks",
  "inkling": "fireworks",
  "deepseek-v4-flash-0731": "fireworks",
  "deepseek-v4-pro": "fireworks",
  "nemotron-3-ultra": "baseten",
};

const FACTORY_OPENAI_BASE_URL = `${FACTORY_API_BASE_URL}/api/llm/o/v1`;
const FACTORY_ANTHROPIC_BASE_URL = `${FACTORY_API_BASE_URL}/api/llm/a`;
const FACTORY_GEMINI_BASE_URL = `${FACTORY_API_BASE_URL}/api/llm/g/v1`;

const DEFAULT_CAPABILITIES: BinaryCapability = { contextWindow: 200_000, maxTokens: 64_000, images: true, pdf: false, api: "openai-responses", baseUrl: FACTORY_OPENAI_BASE_URL };

const FALLBACK_REASONING: Record<string, { supported: string[]; default: string }> = {
  "claude-opus-5": { supported: ["off", "low", "medium", "high", "xhigh", "max"], default: "high" },
  "claude-opus-5-fast": { supported: ["off", "low", "medium", "high", "xhigh", "max"], default: "high" },
  "claude-fable-5": { supported: ["off", "low", "medium", "high", "xhigh", "max"], default: "high" },
  "claude-sonnet-5": { supported: ["off", "low", "medium", "high", "xhigh", "max"], default: "high" },
  "claude-haiku-4-5-20251001": { supported: ["off", "low", "medium", "high"], default: "off" },
  "gpt-5.6-sol": { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
  "gpt-5.6-terra": { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
  "gpt-5.6-luna": { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
  "gpt-5.5-pro": { supported: ["medium", "high", "xhigh"], default: "medium" },
  "gemini-3.7-flash": { supported: ["low", "medium", "high"], default: "high" },
  "grok-4.6": { supported: ["low", "medium", "high", "xhigh"], default: "high" },
  "minimax-m3": { supported: ["high"], default: "high" },
  "inkling": { supported: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], default: "high" },
  "deepseek-v4-flash-0731": { supported: ["off", "low", "high", "max"], default: "high" },
  "deepseek-v4-pro": { supported: ["off", "low", "high", "max"], default: "high" },
  "glm-5.2": { supported: ["off", "high", "max"], default: "high" },
  "glm-5.2-fast": { supported: ["off", "high", "max"], default: "high" },
  "kimi-k3": { supported: ["off", "low", "high", "max"], default: "high" },
  // Live Factory streaming rejects reasoning_effort="off" for Nemotron and reports
  // the accepted disable token as `none`; keep this as an API-truth override.
  "nemotron-3-ultra": { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "max" },
};

// The live Factory API accepts a broader Nemotron effort set than Droid's
// current help advertises. All other models follow refreshed Droid metadata.
const FORCE_REASONING_OVERRIDES = new Set(["nemotron-3-ultra"]);

export const DROID_MODELS_FALLBACK: FactoryModel[] = Object.entries(BINARY_CAPABILITIES).filter(([id]) => ACTIVE_MODEL_IDS.has(id)).map(([id, capability]) => {
  const reasoning = FALLBACK_REASONING[id] || fallbackReasoning(id);
  return {
    id,
    name: fallbackName(id),
    reasoning: reasoning.supported.some((effort) => effort !== "none" && effort !== "off"),
    supportedReasoningEfforts: reasoning.supported,
    defaultReasoningEffort: reasoning.default,
    ...capability,
    ...familyForModel(id),
    billingPool: billingPoolForModel(id),
  } as FactoryModel;
});

function fallbackName(id: string) {
  const fromHelp = id
    .replace(/-/g, " ")
    .replace(/\bgpt\b/i, "GPT")
    .replace(/\bgrok\b/i, "Grok")
    .replace(/\bsol\b/i, "Sol")
    .replace(/\bterra\b/i, "Terra")
    .replace(/\bluna\b/i, "Luna")
    .replace(/\bglm\b/i, "GLM")
    .replace(/\bkimi\b/i, "Kimi")
    .replace(/\bdeepseek\b/i, "DeepSeek")
    .replace(/\binkling\b/i, "Inkling")
    .replace(/\bclaude\b/i, "Claude")
    .replace(/\bopus\b/i, "Opus")
    .replace(/\bfable\b/i, "Fable")
    .replace(/\bsonnet\b/i, "Sonnet")
    .replace(/\bhaiku\b/i, "Haiku")
    .replace(/\bfast\b/i, "Fast Mode")
    .replace(/\bpro\b/i, "Pro")
    .replace(/\bcodex\b/i, "Codex");
  return fromHelp.replace(/\s+/g, " ").trim();
}

function fallbackReasoning(id: string) {
  if (id.startsWith("gpt-5.2")) return { supported: ["off", "low", "medium", "high", "xhigh"], default: "low" };
  if (id.startsWith("gpt-")) return { supported: ["low", "medium", "high", "xhigh"], default: "medium" };
  if (id.startsWith("gemini-3.1")) return { supported: ["low", "medium", "high"], default: "high" };
  if (id.startsWith("gemini-")) return { supported: ["minimal", "low", "medium", "high"], default: "high" };
  if (id.startsWith("glm-5.2")) return { supported: ["off", "high", "max"], default: "high" };
  if (id.startsWith("glm-") || id.startsWith("kimi-") || id.startsWith("nemotron-")) return { supported: ["off", "high"], default: "high" };
  if (id.startsWith("deepseek-")) return { supported: ["off", "low", "high", "max"], default: "high" };
  if (id.startsWith("minimax-m2.5")) return { supported: ["low", "medium", "high"], default: "high" };
  if (id.includes("4-5")) return { supported: ["off", "low", "medium", "high"], default: "off" };
  return { supported: ["off", "low", "medium", "high"], default: "high" };
}

export function factoryApiForModel(id: string) {
  if (id.startsWith("claude-") || id.startsWith("minimax-")) return "anthropic-messages";
  if (id.startsWith("gemini-")) return "google-generative-ai";
  if (id === "inkling" || id.startsWith("kimi-") || id.startsWith("glm-") || id.startsWith("deepseek-") || id.startsWith("nemotron-")) return "openai-completions";
  return "openai-responses";
}

function familyForModel(id: string): Pick<BinaryCapability, "api" | "baseUrl" | "apiProvider"> {
  const api = factoryApiForModel(id);
  if (api === "anthropic-messages") {
    return { api, baseUrl: FACTORY_ANTHROPIC_BASE_URL, apiProvider: id.startsWith("minimax-") ? "fireworks" : "anthropic" };
  }
  if (api === "google-generative-ai") return { api, baseUrl: FACTORY_GEMINI_BASE_URL, apiProvider: "google" };
  if (api === "openai-completions") {
    return { api, baseUrl: FACTORY_OPENAI_BASE_URL, apiProvider: FACTORY_CORE_PROVIDER_OVERRIDES[id] || "fireworks" };
  }
  return { api, baseUrl: FACTORY_OPENAI_BASE_URL, apiProvider: id.startsWith("grok-") ? "xai" : "openai" };
}

function capabilityForModel(id: string): Required<Pick<FactoryModel, "api" | "baseUrl">> & BinaryCapability {
  return { ...(BINARY_CAPABILITIES[id] || DEFAULT_CAPABILITIES), ...familyForModel(id) } as Required<Pick<FactoryModel, "api" | "baseUrl">> & BinaryCapability;
}

function normalizeDisplayName(name: string) {
  return name
    .replace(/\s*\(default\)\s*$/, "")
    .replace(/\s+\[Deprecated\]\s*$/, "")
    .replace(/^Droid Core\s*\((.+)\)$/i, "$1")
    .trim();
}

function comparableDisplayName(name: string) {
  return normalizeDisplayName(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function parseModelsFromDroidHelp(): FactoryModel[] {
  try {
    const help = droidExecHelp();
    const modelSection = help.split("Available Models:")[1]?.split("Model details:")[0] || "";
    const detailSection = help.split("Model details:")[1]?.split("Authentication:")[0] || "";
    const models = new Map<string, FactoryModel>();
    for (const line of modelSection.split(/\r?\n/)) {
      const match = line.match(/^\s{2}([^\s]+)\s{2,}(.+?)\s*(?:\[Deprecated\])?\s*$/);
      if (!match) continue;
      const id = match[1];
      if (!ACTIVE_MODEL_IDS.has(id)) continue;
      const reasoning = FALLBACK_REASONING[id] || fallbackReasoning(id);
      models.set(id, {
        id,
        name: normalizeDisplayName(match[2]),
        reasoning: reasoning.supported.some((effort) => effort !== "none" && effort !== "off"),
        supportedReasoningEfforts: reasoning.supported,
        defaultReasoningEffort: reasoning.default,
        ...capabilityForModel(id),
        billingPool: /\(Droid Core\)/i.test(match[2])
          ? "core"
          : billingPoolForModel(id),
      });
    }
    for (const line of detailSection.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s+(.+?): supports reasoning: (Yes|No); supported: \[([^\]]*)\]; default: ([^\s]+)/);
      if (!match) continue;
      const detailName = comparableDisplayName(match[1]);
      const byName = [...models.values()].find((model) => comparableDisplayName(model.name) === detailName);
      if (!byName || FORCE_REASONING_OVERRIDES.has(byName.id)) continue;
      byName.supportedReasoningEfforts = match[3].split(",").map((effort) => effort.trim()).filter(Boolean);
      byName.defaultReasoningEffort = match[4];
      byName.reasoning = match[2] === "Yes";
    }
    if (!models.size) return DROID_MODELS_FALLBACK;
    for (const fallback of DROID_MODELS_FALLBACK) {
      if (!models.has(fallback.id)) models.set(fallback.id, fallback);
    }
    return [...models.values()];
  } catch {
    return DROID_MODELS_FALLBACK;
  }
}

function thinkingMap(model: FactoryModel) {
  const supported = model.supportedReasoningEfforts;
  const levels = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const disableLevel = supported.includes("none") ? "none" : supported.includes("off") ? "off" : null;
  return Object.fromEntries(levels.map((level) => {
    const providerLevel = level === "off" || level === "none" ? disableLevel : level;
    return [level, providerLevel && supported.includes(providerLevel) ? providerLevel : null];
  }));
}

export function toPiModel(model: FactoryModel) {
  return {
    id: model.id,
    name:
      model.billingPool === "core" && !/Droid Core/i.test(model.name)
        ? `${model.name} (Droid Core)`
        : model.name,
    baseUrl: model.baseUrl,
    headers: model.apiProvider ? { "x-api-provider": model.apiProvider } : undefined,
    reasoning: model.reasoning,
    input: model.images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      supportsReasoningEffort: model.reasoning,
      supportsDeveloperRole: false,
      supportsPdf: model.pdf,
      ...(model.api === "anthropic-messages" ? { forceAdaptiveThinking: true } : {}),
    },
    thinkingLevelMap: thinkingMap(model),
  };
}
