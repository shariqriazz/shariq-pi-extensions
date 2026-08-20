import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { FACTORY_CLIENT_PROTOCOL, FACTORY_RESPONSES_BASE_URL, PROVIDER_ID } from "./factory/constants.ts";
import { factoryOrgHeader, importDroidCredentials, pollDeviceCode, refreshFactoryToken, requestDeviceCode, type FactoryOAuthCredentials } from "./factory/auth.ts";
import { droidVersion } from "./factory/droid.ts";
import { parseModelsFromDroidHelp, toPiModel } from "./factory/models.ts";
import {
  FACTORY_API_KEY_FILE_SENTINEL,
  FACTORY_API_KEYS_PATH,
  factoryApiKeyStatus,
  streamSimpleUnifiedFactoryResponses,
} from "./factory/api-keys.ts";

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
  });

  pi.registerCommand("factory-status", {
    description: "Show unified Factory provider and authentication status",
    handler: async (_args, ctx) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
      const apiKeys = factoryApiKeyStatus();
      ctx.ui.notify([
        `Factory: ${models.length} model(s), Droid ${clientVersion}`,
        `Provider: ${PROVIDER_ID}`,
        `Authentication: ${auth.configured ? auth.label || auth.source || "configured" : "not configured — run /login factory"}`,
        `Configured API keys: ${apiKeys.configured} (${apiKeys.active} active)`,
        `API-key config: ${FACTORY_API_KEYS_PATH}`,
      ].join("\n"), "info");
    },
  });
}
