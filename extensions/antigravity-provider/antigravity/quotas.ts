import {
  antigravityAccountStatuses,
  parseAntigravityQuota,
  resolveAntigravityAccount,
  updateAntigravityAccountQuota,
  type AntigravityAccountStatus,
} from "./accounts.ts";
import {
  fetchAntigravityQuotaCatalog,
  refreshAntigravityToken,
} from "./oauth.ts";

export const ANTIGRAVITY_QUOTA_TTL_MS = 15 * 60 * 1_000;
let refreshPromise: Promise<AntigravityAccountStatus[]> | undefined;

export function refreshAntigravityQuotas(options: { force?: boolean; signal?: AbortSignal } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const now = Date.now();
    const accounts = antigravityAccountStatuses(now);
    for (const account of accounts) {
      if (account.disabled) continue;
      const hasBothWindows = account.quota?.some((entry) => entry.window === "five-hour") &&
        account.quota.some((entry) => entry.window === "weekly");
      if (!options.force && hasBothWindows && account.quotaUpdatedAt && now - account.quotaUpdatedAt < ANTIGRAVITY_QUOTA_TTL_MS) continue;
      try {
        const resolved = await resolveAntigravityAccount(account, refreshAntigravityToken, now);
        const catalog = await fetchAntigravityQuotaCatalog(resolved.access, resolved.projectId, options.signal);
        const quota = parseAntigravityQuota(catalog);
        if (!quota.length) throw new Error("Antigravity returned no recognizable quota entries.");
        updateAntigravityAccountQuota(resolved.id, quota);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        updateAntigravityAccountQuota(account.id, undefined, error instanceof Error ? error.message : String(error));
      }
    }
    return antigravityAccountStatuses();
  })().finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}
