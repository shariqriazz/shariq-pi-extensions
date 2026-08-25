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
	inspectAntigravityAccountStore,
	reconcileAntigravityStoredCredential,
	removeAntigravityAccount,
	setAntigravityAccountEnabled,
	upsertAntigravityAccount,
	type AntigravityStoredCredential,
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

	const readOAuthCredential = (): AntigravityStoredCredential | undefined => {
		const credential = readStoredCredential(PROVIDER_ID) as any;
		if (credential?.type !== "oauth" || typeof credential.refresh !== "string" || typeof credential.access !== "string") return undefined;
		return {
			refresh: credential.refresh,
			access: credential.access,
			expires: typeof credential.expires === "number" ? credential.expires : 0,
			projectId: typeof credential.projectId === "string" ? credential.projectId : undefined,
			email: typeof credential.email === "string" ? credential.email : undefined,
		};
	};

	const reconcileStoredCredential = async (ctx?: ExtensionContext) => {
		try {
			const credentials = readOAuthCredential();
			const reconciliation = reconcileAntigravityStoredCredential(inspectAntigravityAccountStore(), credentials);
			if (reconciliation.action === "migrate") {
				upsertAntigravityAccount(reconciliation.credentials);
				return;
			}
			const authStorage = (ctx?.modelRegistry as any)?.authStorage;
			if (!authStorage) return;
			if (reconciliation.action === "replace") {
				const account = reconciliation.account;
				await authStorage.modify(PROVIDER_ID, async () => ({
					type: "oauth",
					refresh: account.refresh,
					access: account.access,
					expires: account.expires,
					projectId: account.projectId,
					email: account.email,
				}));
			} else if (reconciliation.action === "delete") {
				await authStorage.delete(PROVIDER_ID);
			}
		} catch {
			// Malformed or unavailable credential state must not block extension startup.
		}
	};

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: DEFAULT_ENDPOINT,
		api: "antigravity-api" as any,
		models: ANTIGRAVITY_MODELS,
		oauth: {
			name: PROVIDER_NAME,
			login: ((callbacks: Parameters<typeof loginAntigravity>[0]) => {
				// A missing account store is a legacy installation, so archive Pi's single
				// credential before login. A valid store remains authoritative after edits.
				void reconcileStoredCredential();
				return loginAntigravity(callbacks);
			}) as any,
			refreshToken: refreshAntigravityToken as any,
			getApiKey: getApiKey as any,
		},
		streamSimple: streamAntigravity,
	} as any);

	pi.on("session_start", async (_event, ctx) => {
		(ctx.modelRegistry as any).authStorage?.reload?.();
		await reconcileStoredCredential(ctx);
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
			await reconcileStoredCredential(ctx);
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
				async (id, label) => {
					const confirmed = await ctx.ui.confirm("Remove Antigravity account?", `Permanently remove ${label} from this Pi installation?`);
					if (!confirmed) return dashboardSnapshot(ctx);
					removeAntigravityAccount(id);
					await reconcileStoredCredential(ctx);
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
