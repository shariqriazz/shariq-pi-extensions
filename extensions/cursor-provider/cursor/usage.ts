import { Cursor, type ModelListItem } from "@cursor/sdk";
import { CURSOR_BASE_URL } from "./models.ts";

export interface CursorPlanInfo {
  planName?: string;
  includedAmountCents?: number;
  price?: string;
  billingCycleEnd?: number;
}

export interface CursorPlanUsage {
  totalSpend: number;
  includedSpend: number;
  bonusSpend: number;
  remaining: number;
  limit: number;
  autoSpend?: number;
  apiSpend?: number;
  autoLimit?: number;
  apiLimit?: number;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
}

export interface CursorSpendLimitUsage {
  totalSpend?: number;
  individualLimit?: number;
  individualUsed?: number;
  individualRemaining?: number;
  overallLimit?: number;
  overallUsed?: number;
  overallRemaining?: number;
  limitType?: string;
}

export interface CursorUsageSnapshot {
  email?: string;
  apiKeyName?: string;
  apiKeyCreatedAt?: number;
  apiKeyExpiresAt?: number;
  plan?: CursorPlanInfo;
  usage?: CursorPlanUsage;
  spendLimit?: CursorSpendLimitUsage;
  billingCycleStart?: number;
  billingCycleEnd?: number;
  enabled: boolean;
  displayMessage?: string;
  canAdjustOnDemand: boolean;
  currentOnDemandLimitCents?: number;
  recommendedOnDemandLimitCents?: number;
  models: ModelListItem[];
  fetchedAt: number;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

async function exchangeCursorApiKey(apiKey: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${CURSOR_BASE_URL}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Cursor API key is invalid." : `Cursor key exchange failed with HTTP ${response.status}.`);
  const body = await response.json() as { accessToken?: unknown };
  if (typeof body.accessToken !== "string" || !body.accessToken) throw new Error("Cursor key exchange returned no access token.");
  return body.accessToken;
}

async function dashboardRpc(accessToken: string, method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, any>> {
  const response = await fetch(`${CURSOR_BASE_URL}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Cursor ${method} failed with HTTP ${response.status}.`);
  return await response.json() as Record<string, any>;
}

export async function fetchCursorUsage(apiKey: string, signal?: AbortSignal): Promise<CursorUsageSnapshot> {
  const accessToken = await exchangeCursorApiKey(apiKey, signal);
  const [identity, models, period, plan, limits, keys] = await Promise.all([
    Cursor.me({ apiKey }),
    Cursor.models.list({ apiKey }),
    dashboardRpc(accessToken, "GetCurrentPeriodUsage", { includePooledUsage: true }, signal),
    dashboardRpc(accessToken, "GetPlanInfo", {}, signal),
    dashboardRpc(accessToken, "GetUsageLimitStatusAndActiveGrants", {}, signal),
    dashboardRpc(accessToken, "ListUserApiKeys", {}, signal),
  ]);
  const planUsage = period.planUsage as Record<string, unknown> | undefined;
  const spendLimit = period.spendLimitUsage as Record<string, unknown> | undefined;
  const planInfo = plan.planInfo as Record<string, unknown> | undefined;
  const policy = limits.usageLimitPolicyStatus as Record<string, unknown> | undefined;
  const listedKeys = Array.isArray(keys.apiKeys) ? keys.apiKeys as Array<Record<string, unknown>> : [];
  const currentKey = listedKeys.find((entry) =>
    (typeof entry.maskedKey === "string" && entry.maskedKey.endsWith(apiKey.slice(-4))) ||
    entry.name === identity.apiKeyName
  );

  return {
    email: identity.userEmail,
    apiKeyName: identity.apiKeyName,
    apiKeyCreatedAt: numberValue(currentKey?.createdAt),
    apiKeyExpiresAt: numberValue(currentKey?.expiresAt),
    plan: planInfo ? {
      planName: typeof planInfo.planName === "string" ? planInfo.planName : undefined,
      includedAmountCents: numberValue(planInfo.includedAmountCents),
      price: typeof planInfo.price === "string" ? planInfo.price : undefined,
      billingCycleEnd: numberValue(planInfo.billingCycleEnd),
    } : undefined,
    usage: planUsage ? {
      totalSpend: numberValue(planUsage.totalSpend) ?? 0,
      includedSpend: numberValue(planUsage.includedSpend) ?? 0,
      bonusSpend: numberValue(planUsage.bonusSpend) ?? 0,
      remaining: numberValue(planUsage.remaining) ?? 0,
      limit: numberValue(planUsage.limit) ?? 0,
      autoSpend: numberValue(planUsage.autoSpend),
      apiSpend: numberValue(planUsage.apiSpend),
      autoLimit: numberValue(planUsage.autoLimit),
      apiLimit: numberValue(planUsage.apiLimit),
      autoPercentUsed: numberValue(planUsage.autoPercentUsed),
      apiPercentUsed: numberValue(planUsage.apiPercentUsed),
      totalPercentUsed: numberValue(planUsage.totalPercentUsed),
    } : undefined,
    spendLimit: spendLimit ? {
      totalSpend: numberValue(spendLimit.totalSpend),
      individualLimit: numberValue(spendLimit.individualLimit),
      individualUsed: numberValue(spendLimit.individualUsed),
      individualRemaining: numberValue(spendLimit.individualRemaining),
      overallLimit: numberValue(spendLimit.overallLimit),
      overallUsed: numberValue(spendLimit.overallUsed),
      overallRemaining: numberValue(spendLimit.overallRemaining),
      limitType: typeof spendLimit.limitType === "string" ? spendLimit.limitType : undefined,
    } : undefined,
    billingCycleStart: numberValue(period.billingCycleStart),
    billingCycleEnd: numberValue(period.billingCycleEnd),
    enabled: period.enabled === true,
    displayMessage: typeof period.displayMessage === "string" ? period.displayMessage : undefined,
    canAdjustOnDemand: policy?.canAdjustOnDemand === true,
    currentOnDemandLimitCents: numberValue(policy?.currentOnDemandLimitCents),
    recommendedOnDemandLimitCents: numberValue(policy?.recommendedOnDemandLimitCents),
    models: models.filter((model) => model.id !== "composer-2" && (model.id.startsWith("composer-") || /^grok-4\.(?:5|6)$/.test(model.id) || model.id.startsWith("cursor-grok-"))),
    fetchedAt: Date.now(),
  };
}

export function dollars(cents: number | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "unavailable";
}

export function percentUsed(snapshot: CursorUsageSnapshot): number | undefined {
  if (typeof snapshot.usage?.totalPercentUsed === "number") return snapshot.usage.totalPercentUsed;
  if (snapshot.usage?.limit) return snapshot.usage.totalSpend / snapshot.usage.limit * 100;
  return undefined;
}
