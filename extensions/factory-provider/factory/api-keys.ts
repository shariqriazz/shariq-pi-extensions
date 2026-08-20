import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { FACTORY_STATE_DIR } from "./constants.ts";
import { streamSimpleFactoryResponses } from "./responses.ts";
import {
  cachedLimitDecision,
  factoryCredentialId,
} from "./limits.ts";

export const FACTORY_API_KEY_FILE_SENTINEL = "pi-factory-api-key-file";
export const FACTORY_API_KEYS_PATH = join(FACTORY_STATE_DIR, "api-keys.json");
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RATE_COOLDOWN_MS = 30 * 60 * 1000;

export type FactoryApiKeyEntry = {
  label: string;
  key: string;
  disabled?: boolean;
};

type FactoryApiKeyConfig = {
  keys?: Array<string | Partial<FactoryApiKeyEntry>>;
};

type KeyRuntimeState = {
  cooldownUntil?: number;
  lastError?: string;
  lastUsedAt?: number;
};

const state = new Map<string, KeyRuntimeState>();
let lastConfigurationWarning: string | undefined;

function keyId(entry: FactoryApiKeyEntry) {
  return factoryCredentialId(entry.key);
}

export function maskKey(key: string) {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "****";
  return `${trimmed.slice(0, 5)}…${trimmed.slice(-4)}`;
}

function normalizeEntry(raw: string | Partial<FactoryApiKeyEntry>, index: number): FactoryApiKeyEntry | null {
  if (typeof raw === "string") {
    const key = raw.trim();
    return key ? { label: `key-${index + 1}`, key } : null;
  }
  const key = raw.key?.trim();
  if (!key) return null;
  return { label: raw.label?.trim() || `key-${index + 1}`, key, disabled: Boolean(raw.disabled) };
}

export function parseFactoryApiKeyFile(raw: string): { entries: FactoryApiKeyEntry[]; warning?: string } {
  try {
    const parsed = JSON.parse(raw) as FactoryApiKeyConfig | string[];
    const keys = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : [];
    return { entries: keys.map(normalizeEntry).filter((entry): entry is FactoryApiKeyEntry => Boolean(entry)) };
  } catch {
    return { entries: [], warning: "Factory rotating-key configuration contains invalid JSON." };
  }
}

export function loadFactoryApiKeys(): FactoryApiKeyEntry[] {
  const entries: FactoryApiKeyEntry[] = [];
  const envKeys = (process.env.FACTORY_API_KEYS || process.env.FACTORY_API_KEY || "")
    .split(/[\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  envKeys.forEach((key, index) => entries.push({ label: `env-${index + 1}`, key }));

  lastConfigurationWarning = undefined;
  if (existsSync(FACTORY_API_KEYS_PATH)) {
    try {
      const parsed = parseFactoryApiKeyFile(readFileSync(FACTORY_API_KEYS_PATH, "utf8"));
      entries.push(...parsed.entries);
      lastConfigurationWarning = parsed.warning;
    } catch {
      lastConfigurationWarning = "Factory rotating-key configuration could not be read.";
    }
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.disabled) return false;
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

function activeKeyEntries() {
  const now = Date.now();
  return loadFactoryApiKeys().filter((entry) => {
    const runtime = state.get(keyId(entry));
    return !runtime?.cooldownUntil || runtime.cooldownUntil <= now;
  });
}

function classifyCooldownMs(message: string): number | null {
  const lower = message.toLowerCase();
  if (/\b(401|403)\b/.test(lower) || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("forbidden")) return AUTH_COOLDOWN_MS;
  if (/\b429\b/.test(lower) || lower.includes("rate limit")) return RATE_COOLDOWN_MS;
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("credit") || lower.includes("usage limit") || lower.includes("exhaust")) return DEFAULT_COOLDOWN_MS;
  return null;
}

function markKeyFailure(entry: FactoryApiKeyEntry, error: string) {
  const cooldownMs = classifyCooldownMs(error);
  if (!cooldownMs) return false;
  state.set(keyId(entry), { cooldownUntil: Date.now() + cooldownMs, lastError: error, lastUsedAt: Date.now() });
  return true;
}

function markKeyUsed(entry: FactoryApiKeyEntry) {
  const runtime = state.get(keyId(entry)) || {};
  state.set(keyId(entry), { ...runtime, lastUsedAt: Date.now() });
}

function errorText(event: any): string | null {
  if (!event || event.type !== "error") return null;
  return event.error?.errorMessage || event.error?.message || event.reason || JSON.stringify(event).slice(0, 1000);
}

function errorEvent(model: any, message: string): any {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function streamAttempt(model: any, context: any, options: any, key: FactoryApiKeyEntry) {
  const headers = { ...(model.headers || {}), ...(options?.headers || {}), Authorization: `Bearer ${key.key}` };
  return streamSimpleFactoryResponses(model, context, { ...options, headers });
}

export function selectFactoryApiKeysByLimits(
  entries: FactoryApiKeyEntry[],
  modelId: string,
  decide = cachedLimitDecision,
) {
  const decisions = entries.map((key) => ({
    key,
    decision: decide(key.key, modelId),
  }));
  return {
    keys: decisions
      .filter(({ decision }) => decision?.available !== false)
      .map(({ key }) => key),
    exhausted: decisions
      .filter(({ decision }) => decision?.available === false)
      .map(({ key, decision }) =>
        `${key.label}: ${decision!.pool} ${decision!.exhausted} exhausted`,
      ),
  };
}

export function streamSimpleFactoryApiKeyResponses(model: any, context: any, options?: any) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const selected = selectFactoryApiKeysByLimits(activeKeyEntries(), model.id);
    const keys = selected.keys;
    if (!keys.length) {
      stream.push(errorEvent(
        model,
        selected.exhausted.length
          ? `No configured Factory API key has available ${model.id} usage (${selected.exhausted.join("; ")}). Refresh with /factory-limits.`
          : `No active Factory API keys configured. Add keys to ${FACTORY_API_KEYS_PATH} or FACTORY_API_KEYS.`,
      ));
      stream.end();
      return;
    }

    let lastError = "";
    for (const key of keys) {
      markKeyUsed(key);
      const inner = streamAttempt(model, context, options, key);
      const buffered: any[] = [];
      let hasStarted = false;
      let retriedBeforeStart = false;

      for await (const event of inner as any) {
        const error = errorText(event);
        if (error) {
          lastError = error;
          const retryNext = !hasStarted && markKeyFailure(key, error);
          if (retryNext) {
            retriedBeforeStart = true;
            break;
          }
          for (const bufferedEvent of buffered) stream.push(bufferedEvent);
          stream.push(event);
          stream.end();
          return;
        }

        if (!hasStarted) {
          hasStarted = true;
          for (const bufferedEvent of buffered) stream.push(bufferedEvent);
          buffered.length = 0;
        }
        stream.push(event);
      }

      if (retriedBeforeStart) continue;
      stream.end();
      return;
    }

    stream.push(errorEvent(model, `All configured Factory API keys are cooling down or failed. Last error: ${lastError}`));
    stream.end();
  })().catch((error) => {
    stream.push(errorEvent(model, error?.message || String(error)));
    stream.end();
  });
  return stream;
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function withoutHeader(headers: Record<string, string> | undefined, name: string) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([key]) => key.toLowerCase() !== name.toLowerCase()));
}

export function factoryAuthModeFromHeaders(headers?: Record<string, string>) {
  const authorization = headerValue(headers, "authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (token === FACTORY_API_KEY_FILE_SENTINEL) return "api-key-file" as const;
  if (token.split(".").length === 3) return "oauth" as const;
  return token ? "api-key" as const : "missing" as const;
}

export function streamSimpleUnifiedFactoryResponses(model: any, context: any, options?: any) {
  const mode = factoryAuthModeFromHeaders(options?.headers);
  const headers = mode === "oauth" ? options?.headers : withoutHeader(options?.headers, "X-Factory-Org-Id");
  if (mode === "api-key-file") {
    return streamSimpleFactoryApiKeyResponses(model, context, { ...options, headers });
  }
  return streamSimpleFactoryResponses(model, context, { ...options, headers });
}

export function factoryApiKeyStatus() {
  const keys = loadFactoryApiKeys();
  const now = Date.now();
  return {
    configured: keys.length,
    active: activeKeyEntries().length,
    path: FACTORY_API_KEYS_PATH,
    warning: lastConfigurationWarning,
    keys: keys.map((entry) => {
      const runtime = state.get(keyId(entry));
      return {
        label: entry.label,
        key: maskKey(entry.key),
        cooldownSeconds: runtime?.cooldownUntil && runtime.cooldownUntil > now ? Math.ceil((runtime.cooldownUntil - now) / 1000) : 0,
        lastError: runtime?.lastError ? runtime.lastError.slice(0, 200) : undefined,
        lastUsedAt: runtime?.lastUsedAt ? new Date(runtime.lastUsedAt).toISOString() : undefined,
      };
    }),
  };
}
