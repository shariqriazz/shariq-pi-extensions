import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { FACTORY_CLIENT_PROTOCOL, FACTORY_RESPONSES_BASE_URL, PROVIDER_ID } from "./factory/constants.ts";
import { factoryOrgHeader, importDroidCredentials, pollDeviceCode, refreshFactoryToken, requestDeviceCode, type FactoryOAuthCredentials } from "./factory/auth.ts";
import { droidVersion } from "./factory/droid.ts";
import { parseModelsFromDroidHelp, toPiModel } from "./factory/models.ts";
import {
  FACTORY_API_KEY_FILE_SENTINEL,
  FACTORY_API_KEYS_PATH,
  factoryApiKeyStatus,
  loadFactoryApiKeys,
  streamSimpleUnifiedFactoryResponses,
} from "./factory/api-keys.ts";
import {
  formatLimitRecord,
  loadFactoryLimitCache,
  refreshFactoryLimits,
  type FactoryLimitCredential,
} from "./factory/limits.ts";

const API_KEY_CONFIG_METHOD = "api-key-config";

function configuredApiKeyFileCredential(): OAuthCredentials {
  return {
    access: FACTORY_API_KEY_FILE_SENTINEL,
    refresh: FACTORY_API_KEY_FILE_SENTINEL,
    expires: Number.MAX_SAFE_INTEGER,
  };
}

export default async function factoryExtension(pi: ExtensionAPI) {
  const clientVersion = droidVersion();
  const models = parseModelsFromDroidHelp().map(toPiModel);

  const limitCredentials = async (
    ctx: ExtensionContext,
  ): Promise<FactoryLimitCredential[]> => {
    const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    const apiKey = resolved?.auth.apiKey?.trim();
    if (apiKey === FACTORY_API_KEY_FILE_SENTINEL) {
      return loadFactoryApiKeys().map((entry) => ({
        label: entry.label,
        secret: entry.key,
      }));
    }
    if (!apiKey) return [];
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(resolved?.auth.headers ?? {})) {
      if (name.toLowerCase() !== "authorization" && typeof value === "string") {
        headers[name] = value;
      }
    }
    if (apiKey.split(".").length === 3 && !headers["X-Factory-Org-Id"]) {
      Object.assign(
        headers,
        factoryOrgHeader({ access: apiKey, refresh: "", expires: Number.MAX_SAFE_INTEGER }),
      );
    }
    return [
      {
        label: resolved?.source || "Factory account",
        secret: apiKey,
        headers,
      },
    ];
  };

  const refreshLimits = async (
    ctx: ExtensionContext,
    force: boolean,
  ) => {
    const credentials = await limitCredentials(ctx);
    if (!credentials.length) return [];
    const records = await refreshFactoryLimits(credentials, {
      force,
      version: clientVersion,
      signal: ctx.signal,
    });
    return records;
  };

  pi.registerProvider(PROVIDER_ID, {
    name: "Factory",
    baseUrl: FACTORY_RESPONSES_BASE_URL,
    api: "factory" as any,
    apiKey: "$FACTORY_API_KEY",
    authHeader: true,
    streamSimple: streamSimpleUnifiedFactoryResponses as any,
    headers: {
      "X-Factory-Client": FACTORY_CLIENT_PROTOCOL,
      "X-Client-Version": clientVersion,
      "User-Agent": `factory-cli/${clientVersion}`,
    },
    models: models as any,
    oauth: {
      name: "Factory",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const apiKeys = factoryApiKeyStatus();
        const options = [
          { id: "import", label: "Factory account — import existing Droid CLI login" },
          { id: "device", label: "Factory account — browser/device login" },
          ...(apiKeys.configured > 0 ? [{ id: API_KEY_CONFIG_METHOD, label: `Factory API keys — use ${apiKeys.configured} configured key${apiKeys.configured === 1 ? "" : "s"}` }] : []),
        ];
        const method = await callbacks.onSelect({ message: "Choose how to authenticate with Factory:", options });
        if (!method) throw new Error("Factory login cancelled");

        if (method === API_KEY_CONFIG_METHOD) return configuredApiKeyFileCredential();
        if (method === "import") {
          const credentials = await importDroidCredentials();
          if (!credentials) throw new Error("No readable Droid CLI OAuth credentials found in ~/.factory; choose device login or run Droid /login first.");
          return credentials;
        }
        if (method !== "device") throw new Error(`Unknown Factory login method: ${method}`);

        const device = await requestDeviceCode();
        callbacks.onDeviceCode({
          userCode: device.user_code,
          verificationUri: device.verification_uri_complete || device.verification_uri,
          intervalSeconds: device.interval,
          expiresInSeconds: device.expires_in,
        });
        return pollDeviceCode(device.device_code, device.expires_in, device.interval);
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (credentials.refresh === FACTORY_API_KEY_FILE_SENTINEL) return configuredApiKeyFileCredential();
        return refreshFactoryToken(credentials.refresh, (credentials as FactoryOAuthCredentials).activeOrganizationId);
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
      modifyModels(nextModels: any[], credentials: OAuthCredentials): any[] {
        const orgHeader = factoryOrgHeader(credentials);
        if (!orgHeader["X-Factory-Org-Id"]) return nextModels;
        return nextModels.map((model) => model.provider === PROVIDER_ID ? { ...model, headers: { ...(model.headers || {}), ...orgHeader } } : model);
      },
    },
  } as any);

  // Pi keeps auth.json in memory for the process lifetime. Reload it when extensions
  // reload so credentials migrated or written by another Pi process immediately appear
  // in /logout and model availability without requiring a full Pi restart.
  pi.on("session_start", (_event, ctx) => {
    const authStorage = (ctx.modelRegistry as any).authStorage;
    authStorage?.reload?.();
    void refreshLimits(ctx, false).catch(() => {
      // Limits are advisory and refreshed silently; /factory-limits reports on demand.
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    void refreshLimits(ctx, false).catch(() => {
      // Cached usage remains available; the manual command reports refresh errors.
    });
  });

  pi.registerCommand("factory-status", {
    description: "Show unified Factory provider and authentication status",
    handler: async (_args, ctx) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
      const apiKeys = factoryApiKeyStatus();
      const cachedLimits = loadFactoryLimitCache().records;
      ctx.ui.notify([
        `Factory: ${models.length} model(s), Droid ${clientVersion}`,
        `Provider: ${PROVIDER_ID}`,
        `Authentication: ${auth.configured ? auth.label || auth.source || "configured" : "not configured — run /login factory"}`,
        `Configured API keys: ${apiKeys.configured} (${apiKeys.active} active)`,
        `API-key config: ${FACTORY_API_KEYS_PATH}`,
        `Usage records: ${cachedLimits.length} separate credential${cachedLimits.length === 1 ? "" : "s"} (use /factory-limits to refresh)`,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("factory-limits", {
    description: "Refresh and show separate Standard and Droid Core usage for each Factory credential",
    handler: async (args, ctx) => {
      const query = args.trim().toLowerCase();
      const credentials = await limitCredentials(ctx);
      const matching = query
        ? credentials.filter((credential) =>
            credential.label.toLowerCase().includes(query),
          )
        : credentials;
      if (!matching.length) {
        ctx.ui.notify(
          query
            ? `No Factory credential label matches "${args.trim()}".`
            : "No active Factory credential is available for usage lookup.",
          "warning",
        );
        return;
      }
      let credential = matching[0];
      if (matching.length > 1) {
        const choices = matching.map(
          (entry, index) => `${index + 1}. ${entry.label}`,
        );
        const selected = await ctx.ui.select(
          "Factory usage · choose a credential",
          choices,
        );
        if (!selected) return;
        const index = choices.indexOf(selected);
        if (index < 0) return;
        credential = matching[index];
      }
      const [record] = await refreshFactoryLimits([credential], {
        force: true,
        version: clientVersion,
        signal: ctx.signal,
      });
      if (!record) {
        ctx.ui.notify("Factory usage is unavailable for that credential.", "warning");
        return;
      }
      ctx.ui.notify(formatLimitRecord(record).join("\n"), record.error ? "warning" : "info");
    },
  });
}
