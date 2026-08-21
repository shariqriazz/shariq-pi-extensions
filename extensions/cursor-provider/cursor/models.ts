import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cursor, type ModelListItem, type ModelSelection } from "@cursor/sdk";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_API = "cursor-sdk" as const;
export const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CATALOG_PATH = join(getAgentDir(), "cursor", "models.json");

const FALLBACK_CATALOG: ModelListItem[] = [
  { id: "composer-2.5", displayName: "Composer 2.5", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true", displayName: "Fast" }] }] },
  { id: "grok-4.5", displayName: "Cursor Grok 4.5", parameters: [{ id: "effort", values: ["low", "medium", "high"].map((value) => ({ value })) }, { id: "fast", values: [{ value: "false" }, { value: "true", displayName: "Fast" }] }] },
  { id: "grok-4.6", displayName: "Cursor Grok 4.6", parameters: [{ id: "effort", values: ["low", "medium", "high", "xhigh"].map((value) => ({ value })) }, { id: "fast", values: [{ value: "false" }, { value: "true", displayName: "Fast" }] }] },
];

function cursorOwned(model: ModelListItem): boolean {
  if (model.id === "composer-2") return false; // Retired; Cursor reroutes it to Composer 2.5.
  return model.id.startsWith("composer-") || /^grok-4\.(?:5|6)$/.test(model.id) || model.id.startsWith("cursor-grok-");
}

function piModelId(model: ModelListItem): string {
  return model.id.startsWith("grok-") ? `cursor-${model.id}` : model.id;
}

export function loadCursorCatalog(): ModelListItem[] {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    if (Array.isArray(parsed)) {
      const models = parsed.filter((value): value is ModelListItem => value && typeof value.id === "string" && typeof value.displayName === "string" && cursorOwned(value));
      if (models.length > 0) return models;
    }
  } catch {
    // The deterministic fallback keeps the provider available before first login.
  }
  return FALLBACK_CATALOG;
}

export async function refreshCursorCatalog(apiKey: string): Promise<ModelListItem[]> {
  const models = (await Cursor.models.list({ apiKey })).filter(cursorOwned);
  if (models.length === 0) throw new Error("Cursor returned no Composer or Cursor Grok models for this account.");
  mkdirSync(dirname(CATALOG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CATALOG_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, CATALOG_PATH);
  return models;
}

function parameter(model: ModelListItem, matcher: RegExp) {
  return model.parameters?.find((value) => matcher.test(value.id));
}

function modelCapabilities(id: string) {
  const fast = id.endsWith("-fast");
  if (id.startsWith("composer-2.5")) {
    return { contextWindow: 200_000, maxTokens: 64_000, cost: fast ? { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 } : { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 } };
  }
  if (id.startsWith("cursor-grok-4.6")) {
    return { contextWindow: 256_000, maxTokens: 64_000, cost: fast ? { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 } : { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 } };
  }
  if (id.startsWith("cursor-grok-4.5")) {
    return { contextWindow: 256_000, maxTokens: 64_000, cost: fast ? { input: 4, output: 18, cacheRead: 0, cacheWrite: 0 } : { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } };
  }
  return { contextWindow: 200_000, maxTokens: 64_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

function cursorModelConfig(id: string, name: string, reasoning: boolean, efforts: string[] = []) {
  const supported = new Set(efforts.length > 0 ? efforts : ["low", "medium", "high", "xhigh"]);
  const low = supported.has("low") ? "low" : [...supported][0] ?? "low";
  const medium = supported.has("medium") ? "medium" : low;
  const high = supported.has("high") ? "high" : medium;
  const xhigh = supported.has("xhigh") ? "xhigh" : high;
  return {
    id,
    name,
    api: CURSOR_API,
    reasoning,
    input: ["text", "image"] as const,
    ...modelCapabilities(id),
    ...(reasoning ? { thinkingLevelMap: { off: low, minimal: low, low, medium, high, xhigh, max: xhigh } } : {}),
  };
}

export function toCursorPiModels(catalog: ModelListItem[] = loadCursorCatalog()): Array<ReturnType<typeof cursorModelConfig>> {
  const result: Array<ReturnType<typeof cursorModelConfig>> = [];
  for (const model of catalog.filter(cursorOwned)) {
    const id = piModelId(model);
    const effortValues = parameter(model, /effort|reason/i)?.values.map((value) => value.value) ?? [];
    const reasoning = effortValues.length > 0 || id.startsWith("cursor-grok-");
    result.push(cursorModelConfig(id, model.displayName, reasoning, effortValues));
    const fast = parameter(model, /fast/i);
    if (fast?.values.some((value) => value.value === "true")) {
      result.push(cursorModelConfig(`${id}-fast`, `${model.displayName} Fast`, reasoning, effortValues));
    }
  }
  return result.filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index).sort((left, right) => left.id.localeCompare(right.id));
}

function supportedValue(model: ModelListItem | undefined, parameterId: RegExp, desired: string): { id: string; value: string } | undefined {
  const definition = model && parameter(model, parameterId);
  if (!definition) return undefined;
  const value = definition.values.find((candidate) => candidate.value === desired)?.value;
  return value ? { id: definition.id, value } : undefined;
}

export function resolveCursorModelSelection(model: Model<any>, reasoning: string | undefined, catalog: ModelListItem[] = loadCursorCatalog()): ModelSelection {
  const fast = model.id.endsWith("-fast");
  const baseId = fast ? model.id.slice(0, -5) : model.id;
  const sdkBaseId = baseId.startsWith("cursor-grok-") ? baseId.slice("cursor-".length) : baseId;
  const item = catalog.find((candidate) => candidate.id === sdkBaseId || candidate.aliases?.includes(sdkBaseId));
  const params: Array<{ id: string; value: string }> = [];
  const fastParam = supportedValue(item, /fast/i, fast ? "true" : "false");
  if (fastParam) params.push(fastParam);
  if (model.reasoning) {
    const desired = reasoning === "off" || reasoning === "minimal" ? "low" : reasoning === "max" ? "xhigh" : !reasoning ? "high" : reasoning;
    const effort = supportedValue(item, /effort|reason/i, desired)
      ?? supportedValue(item, /effort|reason/i, "high")
      ?? supportedValue(item, /effort|reason/i, "medium")
      ?? supportedValue(item, /effort|reason/i, "low");
    if (effort) params.push(effort);
  }
  return { id: item?.id ?? sdkBaseId, ...(params.length > 0 ? { params } : {}) };
}
