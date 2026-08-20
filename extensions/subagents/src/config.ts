import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ReasoningEffort } from "./domain.ts";

export const AGENT_TYPES = ["general-purpose", "explore", "plan"] as const;
export const CAPABILITY_MODES = ["read-only", "read-write", "execute", "all"] as const;
export const ISOLATION_MODES = ["none", "worktree"] as const;

export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export interface AgentProfile {
  description?: string;
  instructions?: string;
  capability?: CapabilityMode;
  model?: string;
  thinking?: ReasoningEffort;
  isolation?: IsolationMode;
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
    instructions: "Investigate only as far as needed to answer the task. Do not modify files. Report concrete evidence and paths, and distinguish verified facts from inference.",
  },
  plan: {
    description: "Read-only planning agent that produces an implementation plan",
    capability: "execute",
    instructions: "Inspect the relevant code without modifying files. Return an ordered implementation plan tied to current paths, dependencies, material risks, and validation steps."
  },
};

const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrent: 50,
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
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : undefined;
}

function parseProfile(value: unknown): AgentProfile | undefined {
  if (!isRecord(value)) return undefined;
  return {
    description: typeof value.description === "string" ? value.description : undefined,
    instructions: typeof value.instructions === "string" ? value.instructions : undefined,
    capability: enumValue(value.capability, CAPABILITY_MODES),
    model: typeof value.model === "string" ? value.model : undefined,
    thinking: enumValue(value.thinking, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
    isolation: enumValue(value.isolation, ISOLATION_MODES),
  };
}

function parsePersona(value: unknown): PersonaProfile | undefined {
  const profile = parseProfile(value);
  if (!profile?.instructions) return undefined;
  return { ...profile, instructions: profile.instructions };
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
  if (
    value.thinking !== undefined &&
    !enumValue(value.thinking, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)
  ) {
    throw new Error(`${name}.thinking is invalid.`);
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

export function loadSubagentConfig(cwd: string, projectTrusted: boolean): SubagentConfig {
  let config = mergeConfig(DEFAULT_CONFIG, readJson(subagentConfigPath("global", cwd)));
  if (projectTrusted) {
    config = mergeConfig(config, readJson(subagentConfigPath("project", cwd)));
  }
  return config;
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
    throw new Error(`Unknown persona "${personaName}". Available: ${Object.keys(config.personas).join(", ") || "none"}.`);
  }
  const instructions = [profile.instructions, persona?.instructions].filter(Boolean).join("\n\n");
  return {
    agentType,
    persona: personaName,
    instructions,
    capability: options.capability ?? profile.capability ?? "all",
    model: options.model ?? profile.model ?? persona?.model,
    thinking: options.thinking ?? profile.thinking ?? persona?.thinking,
    isolation: options.isolation ?? profile.isolation ?? persona?.isolation ?? "none",
  } as const;
}
