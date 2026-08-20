import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

export type AntigravityRouting = {
	off?: string;
	routing?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>>;
	defaultRequestId?: string;
};

// Public Pi model IDs route to the effort-specific runtime IDs reported by `agy models`.
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
	"claude-opus-4-6": {
		off: "claude-opus-4-6-thinking",
		routing: {
			minimal: "claude-opus-4-6-thinking",
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
			xhigh: "claude-opus-4-6-thinking",
			max: "claude-opus-4-6-thinking",
		},
		defaultRequestId: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		routing: {
			minimal: "claude-sonnet-4-6",
			low: "claude-sonnet-4-6",
			medium: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6",
			xhigh: "claude-sonnet-4-6",
			max: "claude-sonnet-4-6",
		},
		defaultRequestId: "claude-sonnet-4-6",
	},
	"gemini-3.1-pro": {
		off: "gemini-3.1-pro-low",
		routing: {
			minimal: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			medium: "gemini-3.1-pro-low",
			high: "gemini-pro-agent",
			xhigh: "gemini-pro-agent",
			max: "gemini-pro-agent",
		},
		defaultRequestId: "gemini-3.1-pro-low",
	},
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-low",
		routing: {
			minimal: "gemini-3.7-flash-low",
			low: "gemini-3.7-flash-low",
			medium: "gemini-3.7-flash-medium",
			high: "gemini-3.7-flash-high",
			xhigh: "gemini-3.7-flash-high",
			max: "gemini-3.7-flash-high",
		},
		defaultRequestId: "gemini-3.7-flash-low",
	},
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		routing: {
			minimal: "gemini-3.6-flash-low",
			low: "gemini-3.6-flash-low",
			medium: "gemini-3.6-flash-medium",
			high: "gemini-3.6-flash-high",
			xhigh: "gemini-3.6-flash-high",
			max: "gemini-3.6-flash-high",
		},
		defaultRequestId: "gemini-3.6-flash-low",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: {
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
			xhigh: "gemini-3-flash-agent",
			max: "gemini-3-flash-agent",
		},
		defaultRequestId: "gemini-3.5-flash-low",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		routing: {
			minimal: "gpt-oss-120b-medium",
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
			xhigh: "gpt-oss-120b-medium",
			max: "gpt-oss-120b-medium",
		},
		defaultRequestId: "gpt-oss-120b-medium",
	},
};

export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "HIGH", low: "HIGH", medium: "HIGH", high: "HIGH", xhigh: "HIGH", max: "HIGH" } as any,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "THINKING", low: "THINKING", medium: "THINKING", high: "THINKING", xhigh: "THINKING", max: "THINKING" } as any,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "LOW", low: "LOW", medium: "LOW", high: "HIGH", xhigh: "HIGH", max: "HIGH" } as any,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "LOW", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH" } as any,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "LOW", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH" } as any,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "LOW", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH" } as any,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B (Antigravity)",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "MEDIUM", low: "MEDIUM", medium: "MEDIUM", high: "MEDIUM", xhigh: "MEDIUM", max: "MEDIUM" } as any,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	},
];

export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
	const r = ANTIGRAVITY_ROUTING[modelId];
	if (!r) return modelId;
	if (effort === undefined || effort === "off") {
		return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
	}
	const effortKey = effort as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	if (effortKey === "xhigh" || effortKey === "max") {
		return r.routing?.[effortKey] ?? r.routing?.high ?? r.routing?.low ?? r.routing?.minimal ?? r.off ?? r.defaultRequestId ?? modelId;
	}
	return r.routing?.[effortKey] ?? r.routing?.low ?? r.routing?.minimal ?? r.off ?? r.defaultRequestId ?? modelId;
}
