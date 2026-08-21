import { Cursor, DEFAULT_LOGIN_API_KEY_TTL_MS, type SdkLoginOptions, type SdkLoginResult } from "@cursor/sdk";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { refreshCursorCatalog } from "./models.ts";

const EXPIRY_SKEW_MS = 60_000;
const BROWSER_KEY_SENTINEL = "cursor-sdk-browser-user-key";
const STATIC_KEY_SENTINEL = "cursor-static-user-key";
const NON_EXPIRING_CREDENTIAL_MS = 100 * 365 * 24 * 60 * 60_000;

type CursorSdkLogin = (options?: SdkLoginOptions) => Promise<SdkLoginResult>;
type CursorCatalogRefresh = (apiKey: string) => Promise<unknown>;
type CursorIdentityValidator = (apiKey: string) => Promise<unknown>;

async function validateAndCatalog(apiKey: string, refreshCatalog: CursorCatalogRefresh, validateIdentity: CursorIdentityValidator): Promise<void> {
  await validateIdentity(apiKey);
  await refreshCatalog(apiKey);
}

export async function loginCursor(
  callbacks: OAuthLoginCallbacks,
  sdkLogin: CursorSdkLogin = Cursor.auth.login,
  refreshCatalog: CursorCatalogRefresh = refreshCursorCatalog,
  validateIdentity: CursorIdentityValidator = (apiKey) => Cursor.me({ apiKey }),
): Promise<OAuthCredentials> {
  const environmentKey = process.env.CURSOR_API_KEY?.trim();
  const method = await callbacks.onSelect({
    message: "Choose how to authenticate with Cursor:",
    options: [
      { id: "browser", label: "Cursor browser login — mint a 90-day Pi key" },
      ...(environmentKey ? [{ id: "environment", label: "Use CURSOR_API_KEY from the environment" }] : []),
    ],
  });
  if (!method) throw new Error("Cursor login cancelled.");

  if (method === "environment") {
    const apiKey = environmentKey;
    if (!apiKey) throw new Error("CURSOR_API_KEY is not configured.");
    callbacks.onProgress?.("Validating the Cursor API key and refreshing models...");
    await validateAndCatalog(apiKey, refreshCatalog, validateIdentity);
    return {
      access: apiKey,
      refresh: STATIC_KEY_SENTINEL,
      expires: Date.now() + NON_EXPIRING_CREDENTIAL_MS,
    };
  }
  if (method !== "browser") throw new Error(`Unknown Cursor login method: ${method}`);

  callbacks.onProgress?.("Preparing Cursor browser authorization...");
  const result = await sdkLogin({
    openBrowser: false,
    store: null,
    signal: callbacks.signal,
    apiKeyName: "Pi coding agent",
    apiKeyTtlMs: DEFAULT_LOGIN_API_KEY_TTL_MS,
    onLoginUrl(url) {
      callbacks.onAuth({ url, instructions: "Sign in to Cursor and approve the Pi coding agent key." });
      callbacks.onProgress?.("Waiting for Cursor browser authorization...");
    },
  });
  callbacks.onProgress?.("Refreshing the Cursor-owned model catalog...");
  await refreshCatalog(result.apiKey);
  return {
    access: result.apiKey,
    refresh: BROWSER_KEY_SENTINEL,
    expires: result.apiKeyExpiresAtMs - EXPIRY_SKEW_MS,
  };
}

export async function refreshCursorToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (credentials.refresh === STATIC_KEY_SENTINEL) return credentials;
  if (credentials.refresh !== BROWSER_KEY_SENTINEL || credentials.expires <= Date.now()) {
    throw new Error("Cursor login expired. Run `/login cursor` again.");
  }
  return credentials;
}
