import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "./oauth.ts";
import { ANTIGRAVITY_ROUTING } from "./models.ts";

export const ANTIGRAVITY_STATE_DIR = path.join(getAgentDir(), "antigravity");
export const ANTIGRAVITY_ACCOUNTS_PATH = path.join(ANTIGRAVITY_STATE_DIR, "accounts.json");

const AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const RATE_COOLDOWN_MS = 30 * 60 * 1_000;
const CAPACITY_COOLDOWN_MS = 60 * 1_000;
const REFRESH_SKEW_MS = 60 * 1_000;

export type AntigravityQuotaGroup = "gemini" | "non-gemini";
export type AntigravityQuotaWindow = "five-hour" | "weekly";

export interface AntigravityQuotaEntry {
  modelId: string;
  displayName?: string;
  group: AntigravityQuotaGroup;
  window?: AntigravityQuotaWindow;
  remainingFraction: number;
  resetTime?: string;
}

export interface AntigravityAccount {
  id: string;
  email?: string;
  refresh: string;
  access: string;
  expires: number;
  projectId: string;
  disabled?: boolean;
  addedAt: number;
  lastUsedAt?: number;
  cooldownUntil?: number;
  cooldownReason?: "auth" | "rate" | "quota" | "capacity";
  lastError?: string;
  quota?: AntigravityQuotaEntry[];
  quotaUpdatedAt?: number;
  quotaError?: string;
}

interface AntigravityAccountFile {
  version: 1;
  accounts: AntigravityAccount[];
}

export type AntigravityAccountStore = {
  status: "missing" | "invalid" | "valid";
  accounts: AntigravityAccount[];
};

export type AntigravityStoredCredential = Pick<OAuthCredentials, "refresh" | "access" | "expires"> & {
  projectId?: string;
  email?: string;
};

export type AntigravityCredentialReconciliation =
  | { action: "none" }
  | { action: "migrate"; credentials: AntigravityStoredCredential }
  | { action: "replace"; account: AntigravityAccount }
  | { action: "delete" };

export interface AntigravityAccountStatus extends AntigravityAccount {
  active: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function credentialId(refresh: string, email?: string): string {
  return createHash("sha256").update(refresh || email || "antigravity").digest("hex").slice(0, 20);
}

function normalizeAccount(value: unknown): AntigravityAccount | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.refresh !== "string" || !raw.refresh) return undefined;
  if (typeof raw.access !== "string") return undefined;
  const projectId = typeof raw.projectId === "string" ? raw.projectId : "";
  if (!projectId) return undefined;
  const email = typeof raw.email === "string" && raw.email ? raw.email : undefined;
  const quota = Array.isArray(raw.quota)
    ? raw.quota.flatMap((item): AntigravityQuotaEntry[] => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.modelId !== "string") return [];
        if (entry.group !== "gemini" && entry.group !== "non-gemini") return [];
        const remainingFraction = finiteNumber(entry.remainingFraction);
        if (remainingFraction === undefined) return [];
        return [{
          modelId: entry.modelId,
          displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
          group: entry.group,
          window: entry.window === "five-hour" || entry.window === "weekly" ? entry.window : undefined,
          remainingFraction: Math.max(0, Math.min(1, remainingFraction)),
          resetTime: typeof entry.resetTime === "string" ? entry.resetTime : undefined,
        }];
      })
    : undefined;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : credentialId(raw.refresh, email),
    email,
    refresh: raw.refresh,
    access: raw.access,
    expires: finiteNumber(raw.expires) ?? 0,
    projectId,
    disabled: raw.disabled === true,
    addedAt: finiteNumber(raw.addedAt) ?? Date.now(),
    lastUsedAt: finiteNumber(raw.lastUsedAt),
    cooldownUntil: finiteNumber(raw.cooldownUntil),
    cooldownReason: raw.cooldownReason === "auth" || raw.cooldownReason === "rate" || raw.cooldownReason === "quota" || raw.cooldownReason === "capacity" ? raw.cooldownReason : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 300) : undefined,
    quota,
    quotaUpdatedAt: finiteNumber(raw.quotaUpdatedAt),
    quotaError: typeof raw.quotaError === "string" ? raw.quotaError.slice(0, 300) : undefined,
  };
}

export function inspectAntigravityAccountStore(): AntigravityAccountStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(ANTIGRAVITY_ACCOUNTS_PATH, "utf8")) as Partial<AntigravityAccountFile>;
    if (!Array.isArray(parsed.accounts)) return { status: "invalid", accounts: [] };
    return {
      status: "valid",
      accounts: parsed.accounts.map(normalizeAccount).filter((account): account is AntigravityAccount => Boolean(account)),
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return { status: code === "ENOENT" ? "missing" : "invalid", accounts: [] };
  }
}

export function loadAntigravityAccounts(): AntigravityAccount[] {
  return inspectAntigravityAccountStore().accounts;
}

function matchesStoredCredential(account: AntigravityAccount, credentials: AntigravityStoredCredential) {
  return account.refresh === credentials.refresh || Boolean(account.email && credentials.email && account.email === credentials.email);
}

export function reconcileAntigravityStoredCredential(
  store: AntigravityAccountStore,
  credentials: AntigravityStoredCredential | undefined,
): AntigravityCredentialReconciliation {
  if (store.status === "invalid") return { action: "none" };
  if (store.status === "missing") return credentials ? { action: "migrate", credentials } : { action: "none" };
  if (credentials && store.accounts.some((account) => matchesStoredCredential(account, credentials))) return { action: "none" };
  const replacement = store.accounts.find((account) => !account.disabled) ?? store.accounts[0];
  if (replacement) return { action: "replace", account: replacement };
  return credentials ? { action: "delete" } : { action: "none" };
}

function saveAntigravityAccounts(accounts: AntigravityAccount[]) {
  fs.mkdirSync(ANTIGRAVITY_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(ANTIGRAVITY_STATE_DIR, 0o700);
  const temporary = `${ANTIGRAVITY_ACCOUNTS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, ANTIGRAVITY_ACCOUNTS_PATH);
  fs.chmodSync(ANTIGRAVITY_ACCOUNTS_PATH, 0o600);
}

function replaceAccount(id: string, update: (account: AntigravityAccount) => AntigravityAccount) {
  const accounts = loadAntigravityAccounts();
  const index = accounts.findIndex((account) => account.id === id);
  if (index < 0) return undefined;
  const next = update(accounts[index]!);
  accounts[index] = next;
  saveAntigravityAccounts(accounts);
  return next;
}

export function upsertAntigravityAccount(
  credentials: OAuthCredentials,
  options: { clearCooldown?: boolean } = {},
): AntigravityAccount {
  const id = credentialId(credentials.refresh, credentials.email);
  const accounts = loadAntigravityAccounts();
  const index = accounts.findIndex((account) => account.id === id || Boolean(credentials.email && account.email === credentials.email));
  const existing = index >= 0 ? accounts[index] : undefined;
  const account: AntigravityAccount = {
    ...existing,
    id,
    email: credentials.email || existing?.email,
    refresh: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
    projectId: credentials.projectId || existing?.projectId || "",
    addedAt: existing?.addedAt ?? Date.now(),
    disabled: existing?.disabled ?? false,
    cooldownUntil: options.clearCooldown ? undefined : existing?.cooldownUntil,
    cooldownReason: options.clearCooldown ? undefined : existing?.cooldownReason,
    lastError: options.clearCooldown ? undefined : existing?.lastError,
  };
  if (index >= 0) accounts[index] = account;
  else accounts.push(account);
  saveAntigravityAccounts(accounts);
  return account;
}

export function setAntigravityAccountEnabled(id: string, enabled: boolean) {
  return replaceAccount(id, (account) => ({
    ...account,
    disabled: !enabled,
    ...(enabled ? { cooldownUntil: undefined, cooldownReason: undefined, lastError: undefined } : {}),
  }));
}

export function removeAntigravityAccount(id: string) {
  const accounts = loadAntigravityAccounts();
  const next = accounts.filter((account) => account.id !== id);
  if (next.length === accounts.length) return false;
  saveAntigravityAccounts(next);
  return true;
}

function quotaGroupForModel(modelId: string): AntigravityQuotaGroup {
  return modelId.startsWith("gemini-") ? "gemini" : "non-gemini";
}

function resetAt(entry: AntigravityQuotaEntry | undefined): number | undefined {
  if (!entry?.resetTime) return undefined;
  const value = Date.parse(entry.resetTime);
  return Number.isFinite(value) ? value : undefined;
}

export function quotaForModel(account: AntigravityAccount, modelId: string) {
  const group = quotaGroupForModel(modelId);
  const routing = ANTIGRAVITY_ROUTING[modelId];
  const relatedIds = new Set([
    modelId,
    routing?.off,
    routing?.defaultRequestId,
    ...Object.values(routing?.routing ?? {}),
  ].filter((value): value is string => typeof value === "string"));
  const related = account.quota?.filter((entry) =>
    relatedIds.has(entry.modelId) || entry.modelId.startsWith(`${modelId}-`)
  ) ?? [];
  if (related.length) return related.sort((left, right) => left.remainingFraction - right.remainingFraction)[0];
  const grouped = account.quota?.filter((entry) => entry.group === group) ?? [];
  return grouped.sort((left, right) => left.remainingFraction - right.remainingFraction)[0];
}

export function eligibleAntigravityAccounts(
  accounts: AntigravityAccount[],
  modelId: string,
  now = Date.now(),
) {
  return accounts
    .filter((account) => {
      if (account.disabled) return false;
      if (account.cooldownUntil && account.cooldownUntil > now) return false;
      const quota = quotaForModel(account, modelId);
      const reset = resetAt(quota);
      return !(quota && quota.remainingFraction <= 0 && reset && reset > now);
    })
    .sort((left, right) => (left.lastUsedAt ?? 0) - (right.lastUsedAt ?? 0));
}

export function selectAntigravityAccounts(modelId: string, now = Date.now()) {
  return eligibleAntigravityAccounts(loadAntigravityAccounts(), modelId, now);
}

export function markAntigravityAccountUsed(id: string) {
  return replaceAccount(id, (account) => ({ ...account, lastUsedAt: Date.now() }));
}

function parseRetryAfter(message: string, now = Date.now()): number | undefined {
  const iso = message.match(/(?:reset(?:s| time)?(?: at| in)?|retry after)[^\n]*?(\d{4}-\d{2}-\d{2}T[^\s,;]+)/i)?.[1];
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  const duration = message.match(/(?:reset(?:s)? in|retry after)\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (!duration) return undefined;
  const milliseconds = ((Number(duration[1] || 0) * 3600) + (Number(duration[2] || 0) * 60) + Number(duration[3] || 0)) * 1_000;
  return milliseconds > 0 ? now + milliseconds : undefined;
}

export function classifyAntigravityFailure(message: string, modelId: string, account?: AntigravityAccount) {
  const lower = message.toLowerCase();
  const now = Date.now();
  if (/\b401\b/.test(lower) || lower.includes("invalid_grant") || lower.includes("login expired") || lower.includes("credentials are invalid")) {
    return { reason: "auth" as const, until: now + AUTH_COOLDOWN_MS };
  }
  if (/\b429\b/.test(lower) || lower.includes("rate limit") || lower.includes("quota reached") || lower.includes("resource exhausted")) {
    const quotaReset = resetAt(account ? quotaForModel(account, modelId) : undefined);
    const explicitReset = parseRetryAfter(message, now);
    return {
      reason: lower.includes("quota") || lower.includes("exhaust") ? "quota" as const : "rate" as const,
      until: explicitReset || (quotaReset && quotaReset > now ? quotaReset : now + RATE_COOLDOWN_MS),
    };
  }
  if (/\b503\b/.test(lower) || /\b529\b/.test(lower) || lower.includes("capacity") || lower.includes("overloaded")) {
    return { reason: "capacity" as const, until: now + CAPACITY_COOLDOWN_MS };
  }
  return undefined;
}

export function markAntigravityAccountFailure(id: string, modelId: string, message: string) {
  const account = loadAntigravityAccounts().find((entry) => entry.id === id);
  const failure = classifyAntigravityFailure(message, modelId, account);
  if (!failure) return false;
  replaceAccount(id, (current) => ({
    ...current,
    cooldownUntil: failure.until,
    cooldownReason: failure.reason,
    lastError: message.slice(0, 300),
    lastUsedAt: Date.now(),
  }));
  return true;
}

export function updateAntigravityAccountQuota(id: string, quota: AntigravityQuotaEntry[] | undefined, error?: string) {
  return replaceAccount(id, (account) => ({
    ...account,
    ...(quota ? { quota, quotaUpdatedAt: Date.now(), quotaError: undefined } : { quotaError: error?.slice(0, 300) }),
  }));
}

export function parseAntigravityQuota(value: unknown): AntigravityQuotaEntry[] {
  const findGroups = (node: unknown): unknown[] | undefined => {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findGroups(item);
        if (found) return found;
      }
      return undefined;
    }
    const raw = node as Record<string, unknown>;
    if (Array.isArray(raw.groups)) return raw.groups;
    for (const child of Object.values(raw)) {
      const found = findGroups(child);
      if (found) return found;
    }
    return undefined;
  };

  const summaryEntries: AntigravityQuotaEntry[] = [];
  for (const groupValue of findGroups(value) ?? []) {
    if (!groupValue || typeof groupValue !== "object") continue;
    const group = groupValue as Record<string, unknown>;
    const groupLabel = [group.displayName, group.name, group.id].find((item): item is string => typeof item === "string") ?? "";
    const quotaGroup: AntigravityQuotaGroup | undefined = /gemini/i.test(groupLabel)
      ? "gemini"
      : /claude|third.party|3p|gpt/i.test(groupLabel)
        ? "non-gemini"
        : undefined;
    if (!quotaGroup || !Array.isArray(group.buckets)) continue;
    for (const bucketValue of group.buckets) {
      if (!bucketValue || typeof bucketValue !== "object") continue;
      const bucket = bucketValue as Record<string, unknown>;
      const remaining = bucket.remaining && typeof bucket.remaining === "object"
        ? bucket.remaining as Record<string, unknown>
        : undefined;
      const remainingFraction = finiteNumber(bucket.remainingFraction) ?? finiteNumber(remaining?.remainingFraction);
      const windowLabel = [bucket.window, bucket.bucketId, bucket.displayName].find((item): item is string => typeof item === "string") ?? "";
      const window: AntigravityQuotaWindow | undefined = /week/i.test(windowLabel)
        ? "weekly"
        : /5h|five.?hour/i.test(windowLabel)
          ? "five-hour"
          : undefined;
      if (remainingFraction === undefined || !window) continue;
      summaryEntries.push({
        modelId: typeof bucket.bucketId === "string" ? bucket.bucketId : `${quotaGroup}-${window}`,
        displayName: window === "weekly" ? "Weekly" : "5-Hour",
        group: quotaGroup,
        window,
        remainingFraction: Math.max(0, Math.min(1, remainingFraction)),
        resetTime: typeof bucket.resetTime === "string"
          ? bucket.resetTime
          : typeof remaining?.resetTime === "string"
            ? remaining.resetTime
            : undefined,
      });
    }
  }
  if (summaryEntries.length) return summaryEntries;

  const supportedRuntimeIds = new Set(
    Object.entries(ANTIGRAVITY_ROUTING).flatMap(([modelId, routing]) => [
      modelId,
      routing.off,
      routing.defaultRequestId,
      ...Object.values(routing.routing ?? {}),
    ]).filter((item): item is string => typeof item === "string"),
  );
  const modelEntries: AntigravityQuotaEntry[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, keyHint?: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const raw = node as Record<string, unknown>;
    const quota = raw.quotaInfo && typeof raw.quotaInfo === "object" ? raw.quotaInfo as Record<string, unknown> : raw;
    const remainingFraction = finiteNumber(quota.remainingFraction);
    const modelId = [raw.modelId, raw.id, raw.name, raw.model, keyHint].find((item): item is string => typeof item === "string");
    if (modelId && remainingFraction !== undefined) {
      const normalized = modelId.replace(/^models\//, "");
      if (supportedRuntimeIds.has(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        modelEntries.push({
          modelId: normalized,
          group: normalized.startsWith("gemini-") ? "gemini" : "non-gemini",
          window: "five-hour",
          remainingFraction: Math.max(0, Math.min(1, remainingFraction)),
          resetTime: typeof quota.resetTime === "string" ? quota.resetTime : undefined,
        });
      }
    }
    for (const [key, child] of Object.entries(raw)) {
      if (child && typeof child === "object") visit(child, key);
    }
  };
  visit(value);

  return (["gemini", "non-gemini"] as const).flatMap((group) => {
    const entries = modelEntries.filter((entry) => entry.group === group).sort((left, right) => left.remainingFraction - right.remainingFraction);
    const mostConstrained = entries[0];
    return mostConstrained ? [{
      ...mostConstrained,
      modelId: group === "gemini" ? "gemini-5h" : "claude-5h",
      displayName: "5-Hour",
    }] : [];
  });
}

const refreshes = new Map<string, Promise<AntigravityAccount>>();

export function resolveAntigravityAccount(
  account: AntigravityAccount,
  refresh: (credentials: OAuthCredentials) => Promise<OAuthCredentials>,
  now = Date.now(),
): Promise<AntigravityAccount> {
  if (account.access && account.expires > now + REFRESH_SKEW_MS) return Promise.resolve(account);
  const existing = refreshes.get(account.id);
  if (existing) return existing;
  const pending = refresh({
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    projectId: account.projectId,
    email: account.email,
  }).then(upsertAntigravityAccount).finally(() => refreshes.delete(account.id));
  refreshes.set(account.id, pending);
  return pending;
}

export function antigravityAccountStatuses(now = Date.now()): AntigravityAccountStatus[] {
  return loadAntigravityAccounts().map((account) => ({
    ...account,
    active: !account.disabled && !(account.cooldownUntil && account.cooldownUntil > now),
  }));
}
