import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import https from "node:https";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	projectId?: string;
	email?: string;
};

export type OAuthCallbacks = {
	onAuth(params: { url: string; instructions?: string }): void;
	onPrompt?(params: { message: string }): Promise<string>;
	onSelect?(params: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
};

export type AntigravityApiKey = {
	token: string;
	projectId: string;
};

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ENDPOINT_FALLBACKS = [
	DEFAULT_ENDPOINT,
	"https://cloudcode-pa.googleapis.com",
];
export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

export function antigravityEnv(name: string): string | undefined {
	return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

export const CALLBACK_HOST = antigravityEnv("CALLBACK_HOST") || "127.0.0.1";
export const DEFAULT_PROJECT_ID = antigravityEnv("PROJECT_ID") || stableProjectId(process.cwd());
export const CLIENT_ID = antigravityEnv("CLIENT_ID") || Buffer.from(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" + "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
	"base64",
).toString("utf8");
export const CLIENT_SECRET = antigravityEnv("CLIENT_SECRET") || Buffer.from(
	"R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
	"base64",
).toString("utf8");
export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

type MinimalResponse = {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
};

function postTokenFormIpv4(body: URLSearchParams): Promise<MinimalResponse> {
	const url = new URL(TOKEN_URL);
	return new Promise((resolve, reject) => {
		const req = https.request({
			host: url.hostname,
			path: `${url.pathname}${url.search}`,
			method: "POST",
			family: 4,
			timeout: 30_000,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(body.toString()),
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			res.on("end", () => {
				const responseText = Buffer.concat(chunks).toString("utf8");
				resolve({
					ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
					status: res.statusCode ?? 0,
					text: async () => responseText,
					json: async () => JSON.parse(responseText),
				});
			});
		});
		req.on("timeout", () => req.destroy(new Error("Token request timed out")));
		req.on("error", reject);
		req.end(body.toString());
	});
}

// Shared diagnostics variables
export let lastStatus: number | undefined;
export function setLastStatus(status: number | undefined) { lastStatus = status; }

export let lastEndpoint: string | undefined;
export function setLastEndpoint(endpoint: string | undefined) { lastEndpoint = endpoint; }

export let lastError: string | undefined;
export function setLastError(error: string | undefined) { lastError = error; }

export let lastProjectId: string | undefined;
export function setLastProjectId(projectId: string | undefined) { lastProjectId = projectId; }

export let lastResolvedRuntimeModel: string | undefined;
export function setLastResolvedRuntimeModel(model: string | undefined) { lastResolvedRuntimeModel = model; }

export let lastAvailableModels: string | undefined;
export function setLastAvailableModels(models: string | undefined) { lastAvailableModels = models; }

export let lastMatchedModelDebug: string | undefined;
export function setLastMatchedModelDebug(debug: string | undefined) { lastMatchedModelDebug = debug; }

export function nowRequestId(): string {
	return `antigravity-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function stableProjectId(seed: string): string {
	const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = base64Url(randomBytes(32));
	const challenge = base64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function endpointCandidates(): string[] {
	const explicit = antigravityEnv("BASE_URL")?.trim();
	return explicit ? [explicit] : ENDPOINT_FALLBACKS;
}

export function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sanitizeText(text: unknown): string {
	return Array.from(String(text ?? ""), (character) => {
		const code = character.charCodeAt(0);
		return character.length === 1 && code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : character;
	}).join("");
}

function boundedFetchSignal(signal?: AbortSignal, timeoutMs = 10_000): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseApiKey(apiKeyRaw: string | undefined): AntigravityApiKey {
	if (!apiKeyRaw) throw new Error("No Antigravity credentials. Run /login antigravity.");
	try {
		const parsed = JSON.parse(apiKeyRaw) as Partial<AntigravityApiKey>;
		if (!parsed.token || !parsed.projectId) throw new Error("missing token or projectId");
		return { token: parsed.token, projectId: parsed.projectId };
	} catch (error) {
		throw new Error(`Invalid Antigravity credentials. Run /login antigravity. (${safeError(error)})`);
	}
}

export function antigravityHeaders(token: string): Record<string, string> {
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"Accept-Encoding": "gzip",
		"User-Agent": antigravityEnv("USER_AGENT") || `antigravity/cli/1.1.13 (aidev_client; os_type=${platform}; arch=${arch}; cl=964361259; auth_method=consumer)`,
	};
}

export function jsonOrTextError(text: string): string {
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string; status?: string; code?: number } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// not JSON
	}
	return text;
}

async function getUserEmail(token: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${token}` },
			signal: boundedFetchSignal(signal),
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as { email?: string };
		return data.email;
	} catch {
		return undefined;
	}
}

export function extractProjectId(data: any): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const direct = data.antigravityProjectId ?? data.projectId ?? data.backendProjectId ?? data.userDefinedCloudaicompanionProject ?? data.cloudaicompanionProject ?? data.project;
	if (typeof direct === "string" && direct) return direct;
	if (direct && typeof direct === "object" && typeof direct.id === "string" && direct.id) return direct.id;
	for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
		const value = data[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = extractProjectId(item);
				if (nested) return nested;
				if (typeof item === "string" && item) return item;
			}
		}
	}
	return undefined;
}

async function listCloudAICompanionProjects(token: string, signal?: AbortSignal): Promise<string | undefined> {
	for (const endpoint of endpointCandidates()) {
		try {
			const res = await fetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
				method: "POST",
				headers: antigravityHeaders(token),
				body: JSON.stringify({}),
				signal: boundedFetchSignal(signal),
			});
			lastStatus = res.status;
			lastEndpoint = endpoint;
			if (!res.ok) continue;
			return extractProjectId(await res.json());
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = safeError(error);
		}
	}
	return undefined;
}

function collectModelLabels(value: any, out: string[] = []): string[] {
	if (!value || out.length > 50) return out;
	if (typeof value === "string") {
		if (/gemini|claude|gpt-oss/i.test(value)) out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectModelLabels(item, out);
		return out;
	}
	if (typeof value === "object") {
		for (const key of ["id", "name", "label", "displayName", "model", "modelId"]) collectModelLabels(value[key], out);
		for (const nested of Object.values(value)) {
			if (nested && typeof nested === "object") collectModelLabels(nested, out);
		}
	}
	return out;
}

function summarizeModelCandidate(value: any): string {
	if (!value || typeof value !== "object") return String(value ?? "none");
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (/token|auth|credential|secret|email/i.test(key)) continue;
		if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
		else if (Array.isArray(raw)) out[key] = `[array:${raw.length}]`;
		else if (typeof raw === "object") out[key] = `{${Object.keys(raw as Record<string, unknown>).slice(0, 12).join(",")}}`;
	}
	return JSON.stringify(out).slice(0, 1200);
}

export type DynamicModelInfo = { id: string; experiments?: string[]; apiProvider?: string; modelProvider?: string };

function findDynamicModel(value: any, requestedId: string): DynamicModelInfo | undefined {
	if (!value) return undefined;

	let targetRegex: RegExp;
	const req = requestedId.toLowerCase();
	if (req === "gemini-3.5-flash-low") targetRegex = /gemini[- ]3\.5[- ]flash \(low\)/i;
	else if (req === "gemini-3.5-flash-medium") targetRegex = /gemini[- ]3\.5[- ]flash \(medium\)/i;
	else if (req === "gemini-3.5-flash-high") targetRegex = /gemini[- ]3\.5[- ]flash \(high\)/i;
	else if (req.includes("claude-opus-4-6")) targetRegex = /claude.*opus.*4\.6/i;
	else if (req.includes("claude-sonnet-4-6")) targetRegex = /claude.*sonnet.*4\.6/i;
	else if (req.includes("gpt-oss-120b")) targetRegex = /gpt.*oss.*120b/i;
	else if (req === "gemini-3.1-pro-low") targetRegex = /gemini[- ]3\.1[- ]pro \(low\)/i;
	else if (req === "gemini-3.1-pro-high") targetRegex = /gemini[- ]3\.1[- ]pro \(high\)/i;
	else targetRegex = new RegExp(req.replace(/-/g, ".*"), "i");

	if (typeof value === "string") return targetRegex.test(value) ? { id: value } : undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findDynamicModel(item, requestedId);
			if (found) return found;
		}
		return undefined;
	}
	if (typeof value === "object") {
		const label = value.label ?? value.displayName ?? value.name ?? value.modelId ?? value.id ?? value.model;
		if (typeof label === "string" && targetRegex.test(label)) {
			lastMatchedModelDebug = summarizeModelCandidate(value);
			return {
				id: String(value.modelId ?? value.id ?? value.model ?? label),
				experiments: value.modelExperiments,
				apiProvider: value.apiProvider,
				modelProvider: value.modelProvider
			};
		}
		for (const nested of Object.values(value)) {
			if (nested && typeof nested === "object") {
				const found = findDynamicModel(nested, requestedId);
				if (found) return found;
			}
		}
	}
	return undefined;
}

export async function fetchAvailableRuntimeModel(token: string, projectId: string, requestedRuntimeModel: string, signal?: AbortSignal): Promise<DynamicModelInfo | undefined> {
	const bodies = [{}, { cloudaicompanionProject: projectId }, { project: projectId }];
	for (const endpoint of endpointCandidates()) {
		for (const candidateBody of bodies) {
			try {
				const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
					method: "POST",
					headers: antigravityHeaders(token),
					body: JSON.stringify(candidateBody),
					signal: boundedFetchSignal(signal),
				});
				lastStatus = res.status;
				lastEndpoint = endpoint;
				if (!res.ok) continue;
				const data = await res.json();
				const labels = [...new Set(collectModelLabels(data))].slice(0, 12);
				lastAvailableModels = labels.join(",");
				const matched = findDynamicModel(data, requestedRuntimeModel);
				if (matched) return matched;
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = safeError(error);
			}
		}
	}
	return undefined;
}

export async function loadCodeAssist(token: string, signal?: AbortSignal): Promise<string | undefined> {
	const body = JSON.stringify({
		metadata: { ideType: "ANTIGRAVITY" },
	});

	for (const endpoint of endpointCandidates()) {
		try {
			const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: antigravityHeaders(token),
				body,
				signal: boundedFetchSignal(signal),
			});
			lastStatus = res.status;
			lastEndpoint = endpoint;
			if (!res.ok) continue;
			const project = extractProjectId(await res.json());
			if (project) return project;
			return await listCloudAICompanionProjects(token, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = safeError(error);
		}
	}
	return undefined;
}

type CallbackServer = {
	server: Server;
	waitForCode: () => Promise<{ code: string; state: string }>;
};

function startCallbackServer(): Promise<CallbackServer> {
	return new Promise((resolve, reject) => {
		let resolveCode!: (value: { code: string; state: string }) => void;
		let rejectCode!: (error: Error) => void;
		const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", REDIRECT_URI);
			if (url.pathname !== "/oauth-callback") {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end("Antigravity callback route not found.");
				return;
			}

			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`Antigravity authentication failed: ${error}`);
				rejectCode(new Error(`OAuth error: ${error}`));
				return;
			}
			if (!code || !state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end("Antigravity authentication failed: missing code or state.");
				rejectCode(new Error("Missing code or state in OAuth callback"));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("Antigravity authentication complete. You can close this window and return to Pi.");
			resolveCode({ code, state });
		});

		server.on("error", reject);
		server.listen(51121, CALLBACK_HOST, () => resolve({ server, waitForCode: () => codePromise }));
	});
}

export async function loginAntigravity(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = generatePKCE();
	const { server, waitForCode } = await startCallbackServer();
	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});
		callbacks.onAuth({ url: `${AUTH_URL}?${authParams.toString()}`, instructions: "Complete Google sign-in. Pi will capture the local callback." });

		let callbackTimer: ReturnType<typeof setTimeout> | undefined;
		const callbackTimeout = new Promise<never>((_resolve, reject) => {
			callbackTimer = setTimeout(() => reject(new Error("Antigravity authentication callback timed out.")), CALLBACK_TIMEOUT_MS);
			callbackTimer.unref?.();
		});
		const { code, state } = await Promise.race([waitForCode(), callbackTimeout]).finally(() => {
			if (callbackTimer) clearTimeout(callbackTimer);
		});
		if (state !== verifier) throw new Error("OAuth state mismatch");

		const tokenResponse = await postTokenFormIpv4(new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}));
		if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
		const tokenData = (await tokenResponse.json()) as { access_token: string; refresh_token?: string; expires_in: number };
		if (!tokenData.refresh_token) throw new Error("No refresh token received. Re-run /login antigravity and allow offline access.");

		const [email, discoveredProject] = await Promise.all([getUserEmail(tokenData.access_token), loadCodeAssist(tokenData.access_token)]);
		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId: discoveredProject || DEFAULT_PROJECT_ID,
			email,
		};
	} finally {
		server.close();
	}
}

export async function refreshAntigravityToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await postTokenFormIpv4(new URLSearchParams({
		client_id: CLIENT_ID,
		client_secret: CLIENT_SECRET,
		refresh_token: credentials.refresh,
		grant_type: "refresh_token",
	}));
	if (!response.ok) throw new Error(`Antigravity token refresh failed: ${await response.text()}`);
	const data = (await response.json()) as { access_token: string; expires_in: number; refresh_token?: string };
	const discoveredProject = await loadCodeAssist(data.access_token);
	return {
		...credentials,
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId: discoveredProject || credentials.projectId || DEFAULT_PROJECT_ID,
	};
}

export function getApiKey(credentials: OAuthCredentials): string {
	return JSON.stringify({ token: credentials.access, projectId: credentials.projectId || DEFAULT_PROJECT_ID });
}
