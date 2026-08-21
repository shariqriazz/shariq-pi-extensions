import {
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	PROVIDER_ID,
	PROVIDER_NAME,
	ANTIGRAVITY_MODELS,
} from "./models.ts";
import {
	loginAntigravity,
	refreshAntigravityToken,
	getApiKey,
	lastStatus,
	lastEndpoint,
	lastError,
	lastProjectId,
	lastResolvedRuntimeModel,
	lastAvailableModels,
	lastMatchedModelDebug,
	DEFAULT_ENDPOINT,
} from "./oauth.ts";
import { streamAntigravity } from "./cloud-code-assist.ts";
import {
	antigravityAccountStatuses,
	setAntigravityAccountEnabled,
	upsertAntigravityAccount,
} from "./accounts.ts";
import { refreshAntigravityQuotas } from "./quotas.ts";
import {
	openAntigravityDashboard,
	type AntigravityDashboardSnapshot,
} from "./dashboard.ts";

export default function antigravityProviderExtension(pi: ExtensionAPI) {
	const dashboardSnapshot = (ctx: ExtensionContext): AntigravityDashboardSnapshot => {
		const auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
		return {
			authentication: auth.configured ? auth.source || auth.label || "configured" : "not authenticated",
			modelCount: ANTIGRAVITY_MODELS.length,
			accounts: antigravityAccountStatuses(),
		};
	};

	const migrateStoredCredential = () => {
		try {
			const credential = readStoredCredential(PROVIDER_ID) as any;
			if (credential?.type !== "oauth" || typeof credential.refresh !== "string" || typeof credential.access !== "string") return;
			upsertAntigravityAccount({
				refresh: credential.refresh,
				access: credential.access,
				expires: typeof credential.expires === "number" ? credential.expires : 0,
				projectId: typeof credential.projectId === "string" ? credential.projectId : undefined,
				email: typeof credential.email === "string" ? credential.email : undefined,
			});
		} catch {
			// A malformed or unavailable Pi credential must not block extension startup.
		}
	};

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: DEFAULT_ENDPOINT,
		api: "antigravity-api" as any,
		models: ANTIGRAVITY_MODELS,
		oauth: {
			name: PROVIDER_NAME,
			login: loginAntigravity as any,
			refreshToken: refreshAntigravityToken as any,
			getApiKey: getApiKey as any,
		},
		streamSimple: streamAntigravity,
	} as any);

	pi.on("session_start", (_event, ctx) => {
		(ctx.modelRegistry as any).authStorage?.reload?.();
		migrateStoredCredential();
		void refreshAntigravityQuotas({ signal: ctx.signal }).catch(() => {
			// Cached quota state remains available; /antigravity reports refresh failures.
		});
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		void refreshAntigravityQuotas({ signal: ctx.signal }).catch(() => {});
	});

	pi.registerCommand("antigravity", {
		description: "Open Antigravity accounts, rotation, and quota dashboard",
		handler: async (_args, ctx) => {
			migrateStoredCredential();
			await openAntigravityDashboard(
				ctx,
				dashboardSnapshot(ctx),
				async (force) => {
					await refreshAntigravityQuotas({ force, signal: ctx.signal });
					return dashboardSnapshot(ctx);
				},
				async (id, enabled) => {
					setAntigravityAccountEnabled(id, enabled);
					if (enabled) await refreshAntigravityQuotas({ force: true, signal: ctx.signal });
					return dashboardSnapshot(ctx);
				},
			);
		},
	});

	pi.registerCommand("antigravity.doctor", {
		description: "Show sanitized Antigravity provider diagnostics",
		handler: async (_args, ctx) => {
			const accounts = antigravityAccountStatuses();
			const lines = [
				`provider=${PROVIDER_ID}`,
				`lastResolvedRuntimeModel=${lastResolvedRuntimeModel || "none"}`,
				`availableModels=${lastAvailableModels || "none"}`,
				`matchedModel=${lastMatchedModelDebug || "none"}`,
				`lastEndpoint=${lastEndpoint || "none"}`,
				`lastStatus=${lastStatus ?? "none"}`,
				`lastProjectId=${lastProjectId || "none"}`,
				`lastError=${lastError || "none"}`,
				"transport=native-streamSimple",
				"runtimeCli=not-used",
				`accountsConfigured=${accounts.length}`,
				`accountsActive=${accounts.filter((account) => account.active).length}`,
				"rotation=quota-aware-lru",
			];
			const text = lines.join("\n");
			if (ctx.hasUI) ctx.ui.notify(`Antigravity doctor\n${text}`, "info");
			console.log(text);
		},
	});

	return {
		deactivate: async () => {
			try {
				pi.unregisterProvider(PROVIDER_ID);
			} catch {
				// ignore
			}
		},
	};
}
