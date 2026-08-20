import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { FACTORY_API_BASE_URL, FACTORY_STATE_DIR } from "./constants.ts";
import { factoryApiForModel } from "./models.ts";
import { streamSimpleFactoryResponses } from "./responses.ts";
import { createFactoryResponsesWebSocketFetch } from "./websocket.ts";
import {
  cachedLimitDecision,
  factoryCredentialId,
  refreshFactoryLimits,
} from "./limits.ts";
import { droidVersion } from "./droid.ts";

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
  cooldownKind?: "auth" | "rate" | "quota";
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

export function sortFactoryApiKeysByLastUsed(
  entries: FactoryApiKeyEntry[],
  lastUsed = (entry: FactoryApiKeyEntry) => state.get(keyId(entry))?.lastUsedAt,
) {
  return entries
    .map((entry, index) => ({ entry, index, lastUsedAt: lastUsed(entry) ?? 0 }))
    .sort((left, right) =>
      left.lastUsedAt - right.lastUsedAt || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

function activeKeyEntries(modelId?: string) {
  const now = Date.now();
  const active = loadFactoryApiKeys().filter((entry) => {
    const id = keyId(entry);
    const runtime = state.get(id);
    if (!runtime?.cooldownUntil || runtime.cooldownUntil <= now) return true;
    if (runtime.cooldownKind !== "quota" || !modelId) return false;
    const decision = cachedLimitDecision(entry.key, modelId, now);
    if (decision?.available === true) {
      state.set(id, { ...runtime, cooldownUntil: undefined, cooldownKind: undefined });
      return true;
    }
    if (decision?.available === false && decision.resetAt) {
      state.set(id, { ...runtime, cooldownUntil: decision.resetAt });
    }
    return false;
  });
  // Least-recently-used ordering distributes successful traffic instead of
  // draining the first configured key before considering the rest.
  return sortFactoryApiKeysByLastUsed(active);
}

export function classifyFactoryKeyCooldown(message: string): { ms: number; kind: "auth" | "rate" | "quota" } | null {
  const lower = message.toLowerCase();
  // A bare 401/403 usually means our Factory transport or headers are wrong.
  // Disable a credential only when Factory explicitly identifies the key itself.
  if (lower.includes("invalid api key") || lower.includes("api key revoked") || lower.includes("api key expired")) return { ms: AUTH_COOLDOWN_MS, kind: "auth" };
  if (/\b429\b/.test(lower) || lower.includes("rate limit")) return { ms: RATE_COOLDOWN_MS, kind: "rate" };
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("credit") || lower.includes("usage limit") || lower.includes("exhaust")) return { ms: DEFAULT_COOLDOWN_MS, kind: "quota" };
  return null;
}

function markKeyFailure(
  entry: FactoryApiKeyEntry,
  error: string,
  modelId: string,
) {
  const cooldown = classifyFactoryKeyCooldown(error);
  if (!cooldown) return false;
  const now = Date.now();
  const cached = cachedLimitDecision(entry.key, modelId, now);
  state.set(keyId(entry), {
    cooldownUntil:
      cached?.available === false && cached.resetAt
        ? cached.resetAt
        : now + cooldown.ms,
    cooldownKind: cooldown.kind,
    lastError: error,
    lastUsedAt: now,
  });

  // Authorization failures cannot query billing. For rate/quota failures,
  // refresh Factory's authoritative windows and replace the fallback cooldown
  // with the exact monthly/weekly/5-hour reset when available.
  if (cooldown.kind !== "auth") {
    void refreshFactoryLimits(
      [{ label: entry.label, secret: entry.key }],
      { force: true, version: droidVersion() },
    ).then(() => {
      const decision = cachedLimitDecision(entry.key, modelId);
      if (decision?.available !== false || !decision.resetAt) return;
      const runtime = state.get(keyId(entry)) ?? {};
      state.set(keyId(entry), {
        ...runtime,
        cooldownUntil: decision.resetAt,
      });
    }).catch(() => {
      // Retain the conservative error-class fallback cooldown.
    });
  }
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

const organizationIdCache = new Map<string, Promise<string | undefined>>();

async function factoryApiKeyOrganizationId(key: FactoryApiKeyEntry, version: string) {
  const id = keyId(key);
  let pending = organizationIdCache.get(id);
  if (!pending) {
    pending = fetch(`${FACTORY_API_BASE_URL}/api/cli/whoami`, {
      headers: {
        Authorization: `Bearer ${key.key}`,
        "User-Agent": `factory-cli/${version}`,
        "X-Client-Version": version,
        "X-Factory-Client": "cli",
      },
    }).then(async (response) => {
      if (!response.ok) return undefined;
      const body = await response.json() as { organization_id?: string; organizationId?: string };
      return body.organization_id || body.organizationId;
    }).catch(() => undefined);
    organizationIdCache.set(id, pending);
  }
  return pending;
}

async function streamAttempt(model: any, context: any, options: any, key: FactoryApiKeyEntry) {
  const api = factoryApiForModel(model.id);
  const version = droidVersion();
  const sessionId = options?.sessionId || randomUUID();
  const assistantMessageId = randomUUID();
  const organizationId = await factoryApiKeyOrganizationId(key, version);
  const headers: Record<string, string> = {
    ...(model.headers || {}),
    ...(options?.headers || {}),
    "User-Agent": `factory-cli/${version}`,
    "X-Client-Version": version,
    "X-Factory-Client": "cli",
    "X-Provider-Routing-Source": "configured_order",
    "X-Session-Id": sessionId,
    "X-Assistant-Message-Id": assistantMessageId,
    ...(organizationId ? { "X-Factory-Org-Id": organizationId } : {}),
  };
  delete headers.Authorization;
  delete headers.authorization;
  headers.Authorization = `Bearer ${key.key}`;
  if (api === "anthropic-messages") headers["X-Api-Key"] = "placeholder";

  return streamSimpleFactoryResponses(model, context, {
    ...options,
    sessionId,
    headers,
    ...(api === "openai-responses"
      ? { fetch: createFactoryResponsesWebSocketFetch({ apiKey: key.key, assistantMessageId, headers }) }
      : {}),
  });
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
    const selected = selectFactoryApiKeysByLimits(activeKeyEntries(model.id), model.id);
    const keys = selected.keys;
    if (!keys.length) {
      stream.push(errorEvent(
        model,
        selected.exhausted.length
          ? `No configured Factory API key has available ${model.id} usage (${selected.exhausted.join("; ")}). Refresh with /factory.`
          : `No active Factory API keys configured. Add keys to ${FACTORY_API_KEYS_PATH} or FACTORY_API_KEYS.`,
      ));
      stream.end();
      return;
    }

    let lastError = "";
    for (const key of keys) {
      markKeyUsed(key);
      const inner = await streamAttempt(model, context, options, key);
      const buffered: any[] = [];
      let hasStarted = false;
      let retriedBeforeStart = false;

      for await (const event of inner as any) {
        const error = errorText(event);
        if (error) {
          lastError = error;
          const retryNext = !hasStarted && markKeyFailure(key, error, model.id);
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
        id: keyId(entry),
        label: entry.label,
        key: maskKey(entry.key),
        cooldownSeconds: runtime?.cooldownUntil && runtime.cooldownUntil > now ? Math.ceil((runtime.cooldownUntil - now) / 1000) : 0,
        lastError: runtime?.lastError ? runtime.lastError.slice(0, 200) : undefined,
        lastUsedAt: runtime?.lastUsedAt ? new Date(runtime.lastUsedAt).toISOString() : undefined,
      };
    }),
  };
}
