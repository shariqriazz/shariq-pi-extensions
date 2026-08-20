import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { REFRESH_SKEW_MS, WORKOS_BASE_URL, WORKOS_CLIENT_ID } from "./constants.ts";

export type DroidAuth = { access_token: string; refresh_token: string; active_organization_id?: string | null };
export type FactoryOAuthCredentials = OAuthCredentials & { activeOrganizationId?: string | null };
type WorkOSTokens = { access_token: string; refresh_token?: string; expires_in?: number };

function jwtPayload(token: string): any | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
}

function jwtOrgId(token: string): string | undefined {
  const payload = jwtPayload(token);
  return typeof payload?.external_org_id === "string" ? payload.external_org_id : typeof payload?.org_id === "string" ? payload.org_id : undefined;
}

function credentialsFromTokens(tokens: WorkOSTokens, fallbackRefresh?: string, activeOrganizationId?: string | null): FactoryOAuthCredentials {
  const expires = jwtExpiryMs(tokens.access_token) || (tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : Date.now() + 60 * 60 * 1000);
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token || fallbackRefresh || "",
    expires: expires - REFRESH_SKEW_MS,
    activeOrganizationId: activeOrganizationId || jwtOrgId(tokens.access_token) || null,
  };
}

export function factoryOrgHeader(credentials: OAuthCredentials): Record<string, string> {
  const orgId = (credentials as FactoryOAuthCredentials).activeOrganizationId || jwtOrgId(credentials.access);
  return orgId ? { "X-Factory-Org-Id": orgId } : {};
}

export async function refreshFactoryToken(refreshToken: string, activeOrganizationId?: string | null): Promise<FactoryOAuthCredentials> {
  const response = await fetch(`${WORKOS_BASE_URL}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: WORKOS_CLIENT_ID,
      ...(activeOrganizationId ? { organization_id: activeOrganizationId } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Factory WorkOS refresh failed: ${response.status} ${await response.text()}`);
  return credentialsFromTokens((await response.json()) as WorkOSTokens, refreshToken, activeOrganizationId);
}

function factoryDir() { return join(homedir(), ".factory"); }

export function decryptFactoryAuthFile(): DroidAuth | null {
  const keyPath = join(factoryDir(), "auth.v2.key");
  const filePath = join(factoryDir(), "auth.v2.file");
  if (!existsSync(keyPath) || !existsSync(filePath)) return null;
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  const parts = readFileSync(filePath, "utf8").trim().split(":");
  if (key.length !== 32 || parts.length !== 3) return null;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64"));
  decipher.setAuthTag(Buffer.from(parts[1], "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  const data = JSON.parse(plaintext) as DroidAuth;
  return data?.access_token && data?.refresh_token ? data : null;
}

export function saveFactoryAuthFile(tokens: OAuthCredentials, activeOrganizationId?: string | null) {
  const keyPath = join(factoryDir(), "auth.v2.key");
  const filePath = join(factoryDir(), "auth.v2.file");
  if (!existsSync(keyPath) || !existsSync(filePath)) return;
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  if (key.length !== 32) return;
  const body = JSON.stringify({ access_token: tokens.access, refresh_token: tokens.refresh, active_organization_id: activeOrganizationId || null });
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  writeFileSync(filePath, `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`, { mode: 0o600 });
}

export async function importDroidCredentials(): Promise<FactoryOAuthCredentials | null> {
  const auth = decryptFactoryAuthFile();
  if (!auth) return null;
  const existing = credentialsFromTokens({ access_token: auth.access_token, refresh_token: auth.refresh_token }, undefined, auth.active_organization_id);
  if (existing.expires > Date.now()) return existing;
  const refreshed = await refreshFactoryToken(auth.refresh_token, auth.active_organization_id);
  saveFactoryAuthFile(refreshed, auth.active_organization_id);
  return refreshed;
}

export async function requestDeviceCode() {
  const response = await fetch(`${WORKOS_BASE_URL}/authorize/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`Factory device authorization failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
}

export async function pollDeviceCode(deviceCode: string, expiresInSeconds: number, intervalSeconds: number): Promise<FactoryOAuthCredentials> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = Math.max(1, intervalSeconds || 5);
  while (Date.now() < deadline) {
    const response = await fetch(`${WORKOS_BASE_URL}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: WORKOS_CLIENT_ID }),
    });
    const text = await response.text();
    if (response.ok) return credentialsFromTokens(JSON.parse(text) as WorkOSTokens);
    let error = "unknown";
    try { error = JSON.parse(text).error || error; } catch { /* ignore */ }
    if (error === "authorization_pending" || error === "slow_down") {
      if (error === "slow_down") interval += 1;
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }
    throw new Error(`Factory device authorization failed: ${error}`);
  }
  throw new Error("Factory device authorization expired");
}
