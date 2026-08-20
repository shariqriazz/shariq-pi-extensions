import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FACTORY_API_BASE_URL, FACTORY_STATE_DIR } from "./constants.ts";

export const FACTORY_LIMITS_CACHE_PATH = path.join(
  FACTORY_STATE_DIR,
  "limits-cache.json",
);
export const FACTORY_LIMITS_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export const FACTORY_CORE_MODEL_IDS = new Set([
  "glm-5.2",
  "glm-5.2-fast",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "nemotron-3-ultra",
  "deepseek-v4-flash-0731",
  "deepseek-v4-pro",
  "minimax-m3",
  "inkling",
]);

export type FactoryBillingPool = "standard" | "core";

export interface FactoryLimitBucket {
  usedPercent: number;
  windowEnd?: string | null;
  secondsRemaining?: number | null;
}

export interface FactoryPoolLimits {
  fiveHour: FactoryLimitBucket;
  weekly: FactoryLimitBucket;
  monthly: FactoryLimitBucket;
}

export interface FactoryLimits {
  standard?: FactoryPoolLimits;
  core?: FactoryPoolLimits;
}

export interface FactoryLimitCredential {
  label: string;
  secret: string;
  headers?: Record<string, string>;
}

export interface FactoryLimitRecord {
  id: string;
  label: string;
  fetchedAt: number;
  attemptedAt?: number;
  limits?: FactoryLimits;
  error?: string;
}

interface FactoryLimitCache {
  version: 1;
  records: FactoryLimitRecord[];
}

function finitePercent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
}

function bucket(value: unknown): FactoryLimitBucket {
  const raw = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  return {
    usedPercent: finitePercent(raw.usedPercent),
    windowEnd: typeof raw.windowEnd === "string" ? raw.windowEnd : null,
    secondsRemaining:
      typeof raw.secondsRemaining === "number" &&
      Number.isFinite(raw.secondsRemaining)
        ? Math.max(0, raw.secondsRemaining)
        : null,
  };
}

function pool(value: unknown): FactoryPoolLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    fiveHour: bucket(raw.fiveHour),
    weekly: bucket(raw.weekly),
    monthly: bucket(raw.monthly),
  };
}

function parseLimits(value: unknown): FactoryLimits {
  const raw = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  const limits = raw.limits && typeof raw.limits === "object"
    ? (raw.limits as Record<string, unknown>)
    : {};
  return { standard: pool(limits.standard), core: pool(limits.core) };
}

export function factoryCredentialId(secret: string) {
  return createHash("sha256").update(secret).digest("hex").slice(0, 20);
}

export function loadFactoryLimitCache(): FactoryLimitCache {
  try {
    const value = JSON.parse(
      fs.readFileSync(FACTORY_LIMITS_CACHE_PATH, "utf8"),
    ) as Partial<FactoryLimitCache>;
    const records = Array.isArray(value.records)
      ? value.records.filter(
          (record): record is FactoryLimitRecord =>
            !!record &&
            typeof record.id === "string" &&
            typeof record.label === "string" &&
            typeof record.fetchedAt === "number",
        )
      : [];
    return { version: 1, records };
  } catch {
    return { version: 1, records: [] };
  }
}

function saveFactoryLimitCache(cache: FactoryLimitCache) {
  fs.mkdirSync(path.dirname(FACTORY_LIMITS_CACHE_PATH), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${FACTORY_LIMITS_CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, FACTORY_LIMITS_CACHE_PATH);
  fs.chmodSync(FACTORY_LIMITS_CACHE_PATH, 0o600);
}

function bucketResetAt(
  bucket: FactoryLimitBucket,
  observedAt = Date.now(),
) {
  if (bucket.windowEnd) {
    const end = Date.parse(bucket.windowEnd);
    if (Number.isFinite(end)) return end;
  }
  if (typeof bucket.secondsRemaining === "number") {
    return observedAt + bucket.secondsRemaining * 1000;
  }
  return undefined;
}

function active(
  bucket: FactoryLimitBucket,
  now = Date.now(),
  observedAt = now,
) {
  const resetAt = bucketResetAt(bucket, observedAt);
  return resetAt !== undefined && resetAt > now;
}

/** Parent windows dominate exhausted child windows: monthly → weekly → 5-hour. */
export function exhaustedBucket(
  limits: FactoryPoolLimits | undefined,
  now = Date.now(),
  observedAt = now,
): "monthly" | "weekly" | "fiveHour" | undefined {
  if (!limits) return undefined;
  if (active(limits.monthly, now, observedAt) && limits.monthly.usedPercent >= 100) {
    return "monthly";
  }
  if (active(limits.weekly, now, observedAt) && limits.weekly.usedPercent >= 100) {
    return "weekly";
  }
  if (active(limits.fiveHour, now, observedAt) && limits.fiveHour.usedPercent >= 100) {
    return "fiveHour";
  }
  return undefined;
}

export function billingPoolForModel(modelId: string): FactoryBillingPool {
  return FACTORY_CORE_MODEL_IDS.has(modelId) ? "core" : "standard";
}

export function cachedLimitDecision(
  secret: string,
  modelId: string,
  now = Date.now(),
) {
  const record = loadFactoryLimitCache().records.find(
    (item) => item.id === factoryCredentialId(secret),
  );
  if (!record?.limits) return undefined;
  const poolName = billingPoolForModel(modelId);
  const limits = record.limits[poolName];
  const exhausted = exhaustedBucket(limits, now, record.fetchedAt);
  if (exhausted && limits) {
    return {
      available: false as const,
      pool: poolName,
      exhausted,
      resetAt: bucketResetAt(limits[exhausted], record.fetchedAt),
      label: record.label,
    };
  }
  if (now - record.fetchedAt > FACTORY_LIMITS_TTL_MS * 2) return undefined;
  return { available: true as const, pool: poolName, label: record.label };
}

let refreshPromise: Promise<FactoryLimitRecord[]> | undefined;

export function refreshFactoryLimits(
  credentials: ReadonlyArray<FactoryLimitCredential>,
  options: { force?: boolean; version: string; signal?: AbortSignal },
) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const now = Date.now();
    const cache = loadFactoryLimitCache();
    const unique = new Map(
      credentials
        .filter((credential) => credential.secret.trim())
        .map((credential) => [factoryCredentialId(credential.secret), credential]),
    );
    const records: FactoryLimitRecord[] = [];
    for (const [id, credential] of unique) {
      const existing = cache.records.find((record) => record.id === id);
      if (
        !options.force &&
        existing &&
        now - (existing.attemptedAt ?? existing.fetchedAt) < FACTORY_LIMITS_TTL_MS
      ) {
        records.push({ ...existing, label: credential.label });
        continue;
      }
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      try {
        const response = await fetch(
          `${FACTORY_API_BASE_URL}/api/billing/limits`,
          {
            headers: {
              Authorization: `Bearer ${credential.secret}`,
              "X-Factory-Client": "cli",
              "X-Client-Version": options.version,
              ...(credential.headers ?? {}),
            },
            signal,
          },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = await response.json();
        records.push({
          id,
          label: credential.label,
          fetchedAt: Date.now(),
          attemptedAt: Date.now(),
          limits: parseLimits(body),
        });
      } catch (error) {
        records.push({
          id,
          label: credential.label,
          fetchedAt: existing?.fetchedAt ?? Date.now(),
          attemptedAt: Date.now(),
          limits: existing?.limits,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        });
      }
    }
    for (const record of cache.records) {
      if (
        unique.has(record.id) ||
        now - record.fetchedAt > CACHE_MAX_AGE_MS
      ) continue;
      records.push(record);
    }
    saveFactoryLimitCache({ version: 1, records });
    return records.filter((record) => unique.has(record.id));
  })().finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}

function resetText(
  bucket: FactoryLimitBucket,
  now = Date.now(),
  observedAt = now,
) {
  if (!active(bucket, now, observedAt)) return "reset";
  const resetAt = bucketResetAt(bucket, observedAt);
  const seconds = resetAt ? Math.max(0, Math.round((resetAt - now) / 1000)) : 0;
  if (!seconds) return "reset soon";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ""}` : `${minutes}m`;
}

export function formatPoolLimits(
  name: "Standard" | "Core",
  limits: FactoryPoolLimits | undefined,
  now = Date.now(),
  observedAt = now,
) {
  if (!limits) return `${name}: unavailable`;
  const exhausted = exhaustedBucket(limits, now, observedAt);
  if (exhausted === "monthly") {
    return `${name} used: monthly 100% · resets ${resetText(limits.monthly, now, observedAt)} · weekly/5h inactive`;
  }
  if (exhausted === "weekly") {
    return `${name} used: monthly ${limits.monthly.usedPercent}% · weekly 100% · resets ${resetText(limits.weekly, now, observedAt)} · 5h inactive`;
  }
  if (exhausted === "fiveHour") {
    return `${name} used: monthly ${limits.monthly.usedPercent}% · weekly ${limits.weekly.usedPercent}% · 5h 100% · resets ${resetText(limits.fiveHour, now, observedAt)}`;
  }
  const parts = [
    active(limits.monthly, now, observedAt) ? `M ${limits.monthly.usedPercent}%` : undefined,
    active(limits.weekly, now, observedAt) ? `W ${limits.weekly.usedPercent}%` : undefined,
    active(limits.fiveHour, now, observedAt) ? `5h ${limits.fiveHour.usedPercent}%` : undefined,
  ].filter(Boolean);
  return `${name} used: ${parts.join(" · ") || "fresh window"}`;
}

export function formatLimitRecord(record: FactoryLimitRecord, now = Date.now()) {
  const ageMinutes = Math.max(0, Math.floor((now - record.fetchedAt) / 60_000));
  const lines = [
    `${record.label} · ${ageMinutes ? `${ageMinutes}m old` : "just refreshed"}${record.error ? ` · refresh error: ${record.error}` : ""}`,
    `  ${formatPoolLimits("Standard", record.limits?.standard, now, record.fetchedAt)}`,
    `  ${formatPoolLimits("Core", record.limits?.core, now, record.fetchedAt)}`,
  ];
  return lines;
}
