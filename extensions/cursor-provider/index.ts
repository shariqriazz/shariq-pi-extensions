import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loginCursor, refreshCursorToken } from "./cursor/auth.ts";
import { openCursorDashboard, type CursorDashboardSnapshot } from "./cursor/dashboard.ts";
import {
  CURSOR_API,
  CURSOR_BASE_URL,
  CURSOR_PROVIDER_ID,
  loadCursorCatalog,
  toCursorPiModels,
} from "./cursor/models.ts";
import { clearCursorAgentPool, streamCursorSdk } from "./cursor/stream.ts";
import { fetchCursorUsage } from "./cursor/usage.ts";

export default async function cursorProviderExtension(pi: ExtensionAPI) {
  const catalog = loadCursorCatalog();
  const models = toCursorPiModels(catalog);

  pi.registerProvider(CURSOR_PROVIDER_ID, {
    name: "Cursor",
    baseUrl: CURSOR_BASE_URL,
    api: CURSOR_API,
    apiKey: "$CURSOR_API_KEY",
    authHeader: true,
    models,
    oauth: {
      name: "Cursor",
      login: loginCursor,
      refreshToken: refreshCursorToken,
      getApiKey(credentials: OAuthCredentials) {
        return credentials.access;
      },
    },
    streamSimple: streamCursorSdk,
  } as any);

  const dashboardSnapshot = async (ctx: ExtensionContext): Promise<CursorDashboardSnapshot> => {
    const auth = await ctx.modelRegistry.getProviderAuth(CURSOR_PROVIDER_ID);
    const apiKey = auth?.auth.apiKey?.trim();
    const authentication = auth?.source ?? "not authenticated";
    if (!apiKey) return { authentication, error: "No Cursor credential is configured. Run `/login cursor` or set CURSOR_API_KEY." };
    try {
      return { authentication, usage: await fetchCursorUsage(apiKey, ctx.signal) };
    } catch (error) {
      return { authentication, error: error instanceof Error ? error.message : String(error) };
    }
  };

  pi.on("session_start", (_event, ctx) => {
    (ctx.modelRegistry as any).authStorage?.reload?.();
  });

  pi.on("session_shutdown", async () => {
    await clearCursorAgentPool();
  });

  pi.registerCommand("cursor", {
    description: "Open Cursor account, monthly usage, and limits dashboard",
    handler: async (_args, ctx) => {
      await openCursorDashboard(ctx, { authentication: ctx.modelRegistry.getProviderAuthStatus(CURSOR_PROVIDER_ID).source ?? "not authenticated" }, () => dashboardSnapshot(ctx));
    },
  });

  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Cursor provider diagnostics",
    handler: async (_args, ctx) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus(CURSOR_PROVIDER_ID);
      const text = [
        `provider=${CURSOR_PROVIDER_ID}`,
        "sdk=@cursor/sdk",
        `authenticated=${auth.configured}`,
        `authSource=${auth.source ?? "none"}`,
        `catalogModels=${catalog.length}`,
        `registeredModels=${models.length}`,
        "oauth=pi-owned-browser-api-key",
        "transport=native-cursor-sdk",
        "images=true",
        "nativeTools=true",
        "acp=false",
      ].join("\n");
      if (ctx.hasUI) ctx.ui.notify(`Cursor doctor\n${text}`, "info");
      console.log(text);
    },
  });

  return {
    deactivate: async () => {
      try {
        pi.unregisterProvider(CURSOR_PROVIDER_ID);
        await clearCursorAgentPool();
      } catch {
        // Ignore teardown after partial startup.
      }
    },
  };
}
