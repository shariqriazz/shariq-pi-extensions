import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { REASONING_EFFORTS, type ReasoningEffort } from "./domain.ts";
import { FUSION_PROFILES } from "./fusion.ts";

export const AGENT_TYPES = ["general-purpose", "explore", "plan"] as const;
export const CAPABILITY_MODES = ["read-only", "read-write", "execute", "all"] as const;
export const ISOLATION_MODES = ["none", "worktree"] as const;
export const RUNTIME_MODES = ["in-process", "process"] as const;
export const TIERS = ["light", "medium", "heavy"] as const;

export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export type IsolationMode = (typeof ISOLATION_MODES)[number];
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type Tier = (typeof TIERS)[number];

/** Model and thinking level for one tier; unset fields inherit the parent session's. */
export interface TierSetting {
  model?: string;
  thinking?: ReasoningEffort;
}

export interface AgentProfile {
  description?: string;
  instructions?: string;
  capability?: CapabilityMode;
  model?: string;
  thinking?: ReasoningEffort;
  /** Take model and thinking from this tier when the profile sets neither. */
  tier?: Tier;
  isolation?: IsolationMode;
  /** "process" runs the child as a separate `pi --mode rpc` process with Pi's built-in extensions. */
  runtime?: RuntimeMode;
  /** Exact tool allowlist, applied on top of the capability. */
  tools?: string[];
  /** Set false to start the child without skills, AGENTS.md files, or extensions. */
  skills?: boolean;
  contextFiles?: boolean;
  extensions?: boolean;
}

/** Child session options resolved from a profile; none of them reach the model. */
export interface ChildSessionOptions {
  runtime: RuntimeMode;
  tools?: readonly string[];
  skills: boolean;
  contextFiles: boolean;
  extensions: boolean;
}

export interface PersonaProfile {
  description?: string;
  instructions: string;
  model?: string;
  thinking?: ReasoningEffort;
  isolation?: IsolationMode;
}

export interface SubagentConfig {
  maxConcurrent: number;
  /** Adds the Fusion profiles and lets the main session delegate without being asked. */
  fusion: boolean;
  tiers: Partial<Record<Tier, TierSetting>>;
  profiles: Record<string, AgentProfile>;
  personas: Record<string, PersonaProfile>;
}

const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  "general-purpose": {
    description: "Full-capability implementation and investigation agent",
    capability: "all",
  },
  explore: {
    description: "Read, search, and execute diagnostics without editing files",
    capability: "execute",
    instructions:
      "Investigate only as far as needed to answer the task. Do not modify files. Report concrete evidence and paths, and distinguish verified facts from inference.",
  },
  plan: {
    description: "Read-only planning agent that produces an implementation plan",
    capability: "execute",
    instructions:
      "Inspect the relevant code without modifying files. Return an ordered implementation plan tied to current paths, dependencies, material risks, and validation steps.",
  },
};

const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrent: 50,
  fusion: false,
  tiers: {},
  profiles: BUILTIN_PROFILES,
  personas: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : undefined;
}

// Emit only the fields a document actually sets, so a partial override keeps
// the rest of the profile it layers over (including its capability).
function parseProfile(value: unknown): AgentProfile | undefined {
  if (!isRecord(value)) return undefined;
  const profile: AgentProfile = {};
  if (typeof value.description === "string") profile.description = value.description;
  if (typeof value.instructions === "string") profile.instructions = value.instructions;
  const capability = enumValue(value.capability, CAPABILITY_MODES);
  if (capability) profile.capability = capability;
  if (typeof value.model === "string") profile.model = value.model;
  const thinking = enumValue(value.thinking, REASONING_EFFORTS);
  if (thinking) profile.thinking = thinking;
  const tier = enumValue(value.tier, TIERS);
  if (tier) profile.tier = tier;
  const isolation = enumValue(value.isolation, ISOLATION_MODES);
  if (isolation) profile.isolation = isolation;
  const runtime = enumValue(value.runtime, RUNTIME_MODES);
  if (runtime) profile.runtime = runtime;
  if (Array.isArray(value.tools) && value.tools.every((name) => typeof name === "string" && name.trim())) {
    profile.tools = value.tools.map((name) => (name as string).trim());
  }
  for (const key of ["skills", "contextFiles", "extensions"] as const) {
    if (typeof value[key] === "boolean") profile[key] = value[key] as boolean;
  }
  return profile;
}

function parsePersona(value: unknown): PersonaProfile | undefined {
  const profile = parseProfile(value);
  if (!profile?.instructions) return undefined;
  return {
    description: profile.description,
    instructions: profile.instructions,
    model: profile.model,
    thinking: profile.thinking,
    isolation: profile.isolation,
  };
}

function parseTiers(base: SubagentConfig["tiers"], value: unknown): SubagentConfig["tiers"] {
  if (!isRecord(value)) return base;
  const tiers = { ...base };
  for (const tier of TIERS) {
    const entry = value[tier];
    if (!isRecord(entry)) continue;
    const setting: TierSetting = { ...tiers[tier] };
    if (typeof entry.model === "string" && entry.model.trim()) setting.model = entry.model.trim();
    const thinking = enumValue(entry.thinking, REASONING_EFFORTS);
    if (thinking) setting.thinking = thinking;
    tiers[tier] = setting;
  }
  return tiers;
}

function mergeConfig(base: SubagentConfig, raw: Record<string, unknown> | undefined): SubagentConfig {
  if (!raw) return base;
  const profiles = { ...base.profiles };
  if (isRecord(raw.profiles)) {
    for (const [name, value] of Object.entries(raw.profiles)) {
      const parsed = parseProfile(value);
      if (parsed) profiles[name] = { ...profiles[name], ...parsed };
    }
  }
  const personas = { ...base.personas };
  if (isRecord(raw.personas)) {
    for (const [name, value] of Object.entries(raw.personas)) {
      const parsed = parsePersona(value);
      if (parsed) personas[name] = parsed;
    }
  }
  return {
    maxConcurrent: boundedInt(raw.maxConcurrent, base.maxConcurrent, 1, 50),
    fusion: typeof raw.fusion === "boolean" ? raw.fusion : base.fusion,
    tiers: parseTiers(base.tiers, raw.tiers),
    profiles,
    personas,
  };
}

export type ConfigScope = "global" | "project";

export function subagentConfigPath(scope: ConfigScope, cwd: string) {
  return scope === "global"
    ? path.join(getAgentDir(), "subagents.json")
    : path.join(cwd, CONFIG_DIR_NAME, "subagents.json");
}

export function loadConfigDocument(scope: ConfigScope, cwd: string) {
  const file = subagentConfigPath(scope, cwd);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return `${JSON.stringify({ maxConcurrent: 50, profiles: {}, personas: {} }, null, 2)}\n`;
  }
}

function validateProfileDocument(name: string, value: unknown, persona: boolean) {
  if (!isRecord(value)) throw new Error(`Invalid ${persona ? "persona" : "profile"} "${name}".`);
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`${name}.description must be a string.`);
  }
  if (value.instructions !== undefined && typeof value.instructions !== "string") {
    throw new Error(`${name}.instructions must be a string.`);
  }
  if (persona && typeof value.instructions !== "string") {
    throw new Error(`Invalid persona "${name}"; personas require instructions.`);
  }
  if (value.capability !== undefined && !enumValue(value.capability, CAPABILITY_MODES)) {
    throw new Error(`${name}.capability must be one of ${CAPABILITY_MODES.join(", ")}.`);
  }
  if (value.isolation !== undefined && !enumValue(value.isolation, ISOLATION_MODES)) {
    throw new Error(`${name}.isolation must be one of ${ISOLATION_MODES.join(", ")}.`);
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw new Error(`${name}.model must be a string.`);
  }
  if (value.thinking !== undefined && !enumValue(value.thinking, REASONING_EFFORTS)) {
    throw new Error(`${name}.thinking is invalid.`);
  }
  if (persona) return;
  if (value.tier !== undefined && !enumValue(value.tier, TIERS)) {
    throw new Error(`${name}.tier must be one of ${TIERS.join(", ")}.`);
  }
  if (value.runtime !== undefined && !enumValue(value.runtime, RUNTIME_MODES)) {
    throw new Error(`${name}.runtime must be one of ${RUNTIME_MODES.join(", ")}.`);
  }
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      value.tools.length === 0 ||
      !value.tools.every((tool) => typeof tool === "string" && tool.trim()))
  ) {
    throw new Error(`${name}.tools must be a non-empty array of tool names.`);
  }
  for (const key of ["skills", "contextFiles", "extensions"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`${name}.${key} must be true or false.`);
  }
}

export function saveConfigDocument(scope: ConfigScope, cwd: string, text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error("Subagent configuration must be a JSON object.");
  if (
    raw.maxConcurrent !== undefined &&
    (!Number.isInteger(raw.maxConcurrent) || (raw.maxConcurrent as number) < 1 || (raw.maxConcurrent as number) > 50)
  ) {
    throw new Error("maxConcurrent must be an integer from 1 to 50.");
  }
  if (raw.fusion !== undefined && typeof raw.fusion !== "boolean") {
    throw new Error("fusion must be true or false.");
  }
  if (raw.tiers !== undefined) {
    if (!isRecord(raw.tiers)) throw new Error("tiers must be an object keyed by light, medium, or heavy.");
    for (const [tier, value] of Object.entries(raw.tiers)) {
      if (!enumValue(tier, TIERS)) throw new Error(`Unknown tier "${tier}"; use ${TIERS.join(", ")}.`);
      if (!isRecord(value)) throw new Error(`tiers.${tier} must be an object.`);
      if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
        throw new Error(`tiers.${tier}.model must be a non-empty string.`);
      }
      if (value.thinking !== undefined && !enumValue(value.thinking, REASONING_EFFORTS)) {
        throw new Error(`tiers.${tier}.thinking is invalid.`);
      }
    }
  }
  if (raw.profiles !== undefined && !isRecord(raw.profiles)) {
    throw new Error("profiles must be an object keyed by profile name.");
  }
  for (const [name, value] of Object.entries(isRecord(raw.profiles) ? raw.profiles : {})) {
    if (!name.trim()) throw new Error("Profile names cannot be empty.");
    validateProfileDocument(name, value, false);
  }
  if (raw.personas !== undefined && !isRecord(raw.personas)) {
    throw new Error("personas must be an object keyed by persona name.");
  }
  for (const [name, value] of Object.entries(isRecord(raw.personas) ? raw.personas : {})) {
    if (!name.trim()) throw new Error("Persona names cannot be empty.");
    validateProfileDocument(name, value, true);
  }
  const file = subagentConfigPath(scope, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * `resumable` also defines Fusion profiles that no file defines, so a child
 * started under Fusion mode can be continued after the mode is turned off.
 */
export function loadSubagentConfig(
  cwd: string,
  projectTrusted: boolean,
  options: { resumable?: boolean } = {},
): SubagentConfig {
  const global = readJson(subagentConfigPath("global", cwd));
  const project = projectTrusted ? readJson(subagentConfigPath("project", cwd)) : undefined;
  // Fusion profiles sit under user documents so either file can tune them.
  const fusion = [project?.fusion, global?.fusion].find((value) => typeof value === "boolean") ?? DEFAULT_CONFIG.fusion;
  const base = fusion ? withFusionProfiles(DEFAULT_CONFIG) : DEFAULT_CONFIG;
  const config = mergeConfig(mergeConfig(base, global), project);
  if (fusion || !options.resumable) return config;
  const profiles = { ...config.profiles };
  for (const [name, profile] of Object.entries(FUSION_PROFILES)) profiles[name] ??= profile;
  return { ...config, profiles };
}

function withFusionProfiles(config: SubagentConfig): SubagentConfig {
  const profiles = { ...config.profiles };
  for (const [name, profile] of Object.entries(FUSION_PROFILES)) {
    profiles[name] = { ...profiles[name], ...profile };
  }
  return { ...config, profiles };
}

export function resolveProfile(
  config: SubagentConfig,
  options: {
    agentType?: string;
    persona?: string;
    capability?: CapabilityMode;
    model?: string;
    thinking?: ReasoningEffort;
    isolation?: IsolationMode;
  },
) {
  const agentType = options.agentType?.trim() || "general-purpose";
  const profile = config.profiles[agentType];
  if (!profile) {
    throw new Error(`Unknown agent_type "${agentType}". Available: ${Object.keys(config.profiles).join(", ")}.`);
  }
  const personaName = options.persona?.trim();
  const persona = personaName ? config.personas[personaName] : undefined;
  if (personaName && !persona) {
    throw new Error(
      `Unknown persona "${personaName}". Available: ${Object.keys(config.personas).join(", ") || "none"}.`,
    );
  }
  const instructions = [profile.instructions, persona?.instructions].filter(Boolean).join("\n\n");
  const tier = profile.tier ? config.tiers[profile.tier] : undefined;
  return {
    agentType,
    persona: personaName,
    instructions,
    capability: options.capability ?? profile.capability ?? "all",
    model: options.model ?? profile.model ?? tier?.model ?? persona?.model,
    thinking: options.thinking ?? profile.thinking ?? tier?.thinking ?? persona?.thinking,
    isolation: options.isolation ?? profile.isolation ?? persona?.isolation ?? "none",
    childOptions: {
      runtime: profile.runtime ?? "in-process",
      tools: profile.tools,
      skills: profile.skills ?? true,
      contextFiles: profile.contextFiles ?? true,
      extensions: profile.extensions ?? true,
    } satisfies ChildSessionOptions,
  } as const;
}
