import assert from "node:assert/strict";
import test from "node:test";
import factoryExtension from "./index.ts";
import { FACTORY_API_KEY_FILE_SENTINEL, classifyFactoryKeyCooldown, factoryApiKeyStatus, factoryAuthModeFromHeaders, factoryProviderRoutingSource, factoryResponsesUsesWebSocket, parseFactoryApiKeyFile, selectFactoryApiKeysByLimits, sortFactoryApiKeysByLastUsed } from "./factory/api-keys.ts";
import { refreshFactoryToken } from "./factory/auth.ts";
import { FALLBACK_DROID_VERSION, PROVIDER_ID } from "./factory/constants.ts";
import { droidVersion } from "./factory/droid.ts";
import { DROID_MODELS_FALLBACK, factoryApiForModel, toPiModel } from "./factory/models.ts";
import { FACTORY_SYSTEM_MARKER, resolvedFactoryReasoning, sanitizeFactoryContext, streamFactoryGemini } from "./factory/responses.ts";

async function registeredFactory() {
  const providers = new Map<string, any>();
  const commands: string[] = [];
  const handlers = new Map<string, any>();
  const pi = {
    registerProvider(id: string, config: any) { providers.set(id, config); },
    registerCommand(name: string) { commands.push(name); },
    on(name: string, handler: any) { handlers.set(name, handler); },
  };
  await factoryExtension(pi as never);
  return { providers, commands, handlers, config: providers.get(PROVIDER_ID) };
}

test("Pi reasoning levels clamp to each Factory model's Droid-advertised efforts", () => {
  const model = (id: string) => toPiModel(DROID_MODELS_FALLBACK.find((entry) => entry.id === id)!);
  assert.equal(resolvedFactoryReasoning(model("grok-4.6"), "max"), "xhigh");
  assert.equal(resolvedFactoryReasoning(model("gemini-3.7-flash"), "max"), "high");
  assert.equal(resolvedFactoryReasoning(model("deepseek-v4-flash-0731"), "medium"), "high");
  assert.equal(resolvedFactoryReasoning(model("glm-5.2"), "low"), "high");
  assert.equal(resolvedFactoryReasoning(model("gpt-5.6-luna"), "off"), "none");
  assert.equal(resolvedFactoryReasoning(model("gpt-5.5-pro"), "off"), "medium");
  const nemotron = toPiModel({
    id: "nemotron-3-ultra",
    name: "Nemotron 3 Ultra",
    reasoning: true,
    supportedReasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "high",
    contextWindow: 202_000,
    maxTokens: 65_536,
    images: false,
    pdf: false,
    api: "openai-completions",
    baseUrl: "https://factory.example/api/llm/o/v1",
    apiProvider: "baseten",
    billingPool: "core",
  });
  assert.equal(resolvedFactoryReasoning(nemotron, "off"), "none");
});

test("Factory routing sources match current Droid provider families", () => {
  assert.equal(factoryProviderRoutingSource("openai"), "configured_order");
  assert.equal(factoryProviderRoutingSource("bedrock_anthropic"), "configured_order");
  assert.equal(factoryProviderRoutingSource("fireworks"), "configured_order");
  assert.equal(factoryProviderRoutingSource("xai"), "session_lock");
  assert.equal(factoryProviderRoutingSource("google"), "session_lock");
});

test("Factory uses Responses WebSocket only for OpenAI-routed models", () => {
  assert.equal(factoryResponsesUsesWebSocket("openai-responses", { "x-api-provider": "openai" }), true);
  assert.equal(factoryResponsesUsesWebSocket("openai-responses", { "x-api-provider": "xai" }), false);
  assert.equal(factoryResponsesUsesWebSocket("openai-completions", { "x-api-provider": "openai" }), false);
});

test("generic Factory authorization responses do not disable valid rotating keys", () => {
  assert.equal(classifyFactoryKeyCooldown('401 {"detail":"Missing authorization token"}'), null);
  assert.equal(classifyFactoryKeyCooldown("403 Forbidden"), null);
  assert.equal(classifyFactoryKeyCooldown("401 invalid API key")?.kind, "auth");
});

test("Factory requests preserve Pi guidance behind the required Factory system marker", () => {
  const context = sanitizeFactoryContext({
    systemPrompt: "You are an expert coding assistant operating inside pi, a coding agent harness.",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.ok(context.systemPrompt.startsWith(FACTORY_SYSTEM_MARKER));
  assert.match(context.systemPrompt, /running in Pi/);
  assert.doesNotMatch(context.systemPrompt, /operating inside pi/);
  assert.equal(sanitizeFactoryContext(context).systemPrompt.split(FACTORY_SYSTEM_MARKER).length - 1, 1);
});

test("Factory Gemini preserves guidance, multimodal/tool context, and every streamed event", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: any;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestBody = JSON.parse(String(init?.body));
    const events = [
      { candidates: [{ content: { parts: [{ text: "first" }] } }] },
      { candidates: [{ content: { parts: [{ text: " second" }] } }] },
      {
        candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "read", args: { path: "README.md" } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const stream = streamFactoryGemini(
      {
        id: "gemini-3.7-flash",
        provider: "factory",
        api: "google-generative-ai",
        baseUrl: "https://factory.example/api/llm/g/v1",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
      },
      {
        systemPrompt: "System guidance",
        messages: [
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] },
          { role: "assistant", provider: "factory", model: "gemini-3.7-flash", content: [{ type: "toolCall", id: "prior", name: "read", arguments: { path: "a.ts" } }] },
          { role: "toolResult", toolCallId: "prior", toolName: "read", isError: false, content: [{ type: "text", text: "source" }] },
        ],
        tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      },
      { headers: { Authorization: "Bearer test" }, reasoning: "max" },
    );
    const emitted: any[] = [];
    for await (const event of stream) emitted.push(event);
    const done = emitted.find((event) => event.type === "done");
    assert.equal(requestUrl, "https://factory.example/api/llm/g/v1/generate");
    assert.equal(requestBody.systemInstruction.parts[0].text, "System guidance");
    assert.equal(requestBody.contents[0].parts[1].inlineData.mimeType, "image/png");
    assert.equal(requestBody.contents[2].parts[0].functionResponse.response.output, "source");
    assert.equal(requestBody.tools[0].functionDeclarations[0].name, "read");
    assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.equal(done.message.content[0].text, "first second");
    assert.equal(done.message.content[1].type, "toolCall");
    assert.equal(done.message.stopReason, "toolUse");
    assert.equal(done.message.usage.totalTokens, 15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routes selected models through their Factory API families", () => {
  assert.equal(factoryApiForModel("gemini-3.7-flash"), "google-generative-ai");
  assert.equal(factoryApiForModel("deepseek-v4-flash-0731"), "openai-completions");
  assert.equal(factoryApiForModel("inkling"), "openai-completions");
});

test("registers one unified Factory provider and one dashboard command", async () => {
  const { providers, commands, config } = await registeredFactory();
  assert.deepEqual([...providers.keys()], ["factory"]);
  assert.deepEqual(commands, ["factory"]);
  assert.equal(config.models.length, 13);
  assert.equal(config.headers["X-Client-Version"], droidVersion());
  const ids = config.models.map((model: any) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("gpt-5.6-luna"));
  for (const removed of [
    "claude-opus-4-8",
    "claude-opus-4-8-fast",
    "claude-sonnet-4-6",
    "gpt-5.5",
    "gpt-5.5-fast",
    "gemini-3.5-flash",
    "garnet-07-15",
    "atlas-07-21",
    "aster-07-15",
    "amber-07-09",
    "agate-07-11",
    "kimi-k2.7-code",
    "claude-haiku-4-5-20251001",
    "claude-opus-5",
    "claude-opus-5-fast",
    "gemini-3.1-pro-preview",
    "glm-5.2-fast",
    "inkling",
    "minimax-m3",
    "nemotron-3-ultra",
  ]) {
    assert.ok(!ids.includes(removed), `${removed} should not be registered`);
  }
  assert.ok(ids.includes("gpt-5.5-pro"), "gpt-5.5-pro should remain until a 5.6 Pro replacement exists");
  assert.ok(ids.includes("grok-4.5"), "Grok 4.5 should be registered");
  assert.ok(ids.includes("grok-4.6"), "current Grok should be registered");
  const grok45 = config.models.find((model: any) => model.id === "grok-4.5");
  const grok46 = config.models.find((model: any) => model.id === "grok-4.6");
  assert.equal(grok45.contextWindow, 200_000);
  assert.equal(grok45.maxTokens, 63_356);
  assert.equal(grok46.contextWindow, 200_000);
  assert.equal(grok46.maxTokens, 63_356);
  const byId = new Map(config.models.map((model: any) => [model.id, model]));
  for (const [id, provider] of Object.entries({
    "kimi-k3": "fireworks",
    "glm-5.2": "baseten",
    "deepseek-v4-flash-0731": "fireworks",
    "deepseek-v4-pro": "fireworks",
  })) {
    const model: any = byId.get(id);
    assert.ok(model, `${id} should be registered`);
    assert.equal(model.headers["x-api-provider"], provider);
  }
  const geminiFlash: any = byId.get("gemini-3.7-flash");
  assert.ok(geminiFlash, "gemini-3.7-flash should be registered");
  assert.equal(geminiFlash.contextWindow, 1_000_000);
  assert.equal(geminiFlash.maxTokens, 65_536);
  const kimi: any = byId.get("kimi-k3");
  assert.ok(kimi, "kimi-k3 should be registered");
  assert.equal(kimi.contextWindow, 1_048_576);
  assert.equal(kimi.maxTokens, 131_072);
  assert.deepEqual(kimi.input, ["text", "image"]);
  assert.equal(kimi.thinkingLevelMap.max, "max");
  assert.match(kimi.name, /Droid Core/);
  const deepseekFlash: any = byId.get("deepseek-v4-flash-0731");
  assert.ok(deepseekFlash, "deepseek-v4-flash-0731 should be registered");
  assert.equal(deepseekFlash.contextWindow, 1_040_000);
  assert.equal(deepseekFlash.maxTokens, 131_072);
  assert.deepEqual(deepseekFlash.input, ["text"]);
  assert.equal(deepseekFlash.thinkingLevelMap.max, "max");
});

test("session reload refreshes Pi's in-memory credential view", async () => {
  const { handlers } = await registeredFactory();
  let reloads = 0;
  handlers.get("session_start")({}, { modelRegistry: { authStorage: { reload() { reloads++; } } } });
  assert.equal(reloads, 1);
});

test("registers native API-key auth alongside Factory account OAuth", async () => {
  const { config } = await registeredFactory();
  assert.equal(config.apiKey, "$FACTORY_API_KEY");
  assert.ok(config.oauth);
});

test("malformed rotating-key configuration becomes a warning instead of an exception", () => {
  assert.deepEqual(parseFactoryApiKeyFile("{"), {
    entries: [],
    warning: "Factory rotating-key configuration contains invalid JSON.",
  });
});

test("configured key login stores a non-secret file selector", async () => {
  if (factoryApiKeyStatus().configured === 0) return;
  const { config } = await registeredFactory();
  const result = await config.oauth.login({
    async onSelect() { return "api-key-config"; },
    async onPrompt() { throw new Error("unexpected prompt"); },
    onAuth() {},
    onDeviceCode() {},
  });
  assert.deepEqual(result, {
    access: FACTORY_API_KEY_FILE_SENTINEL,
    refresh: FACTORY_API_KEY_FILE_SENTINEL,
    expires: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(await config.oauth.refreshToken(result), result);
});

test("organization-scoped OAuth refresh matches current Droid", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body || "");
    return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await refreshFactoryToken("old-refresh", "org-current");
    const params = new URLSearchParams(body);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("organization_id"), "org-current");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rotating keys prefer the least recently used eligible credential", () => {
  const keys = [
    { label: "first", key: "key-a" },
    { label: "second", key: "key-b" },
    { label: "third", key: "key-c" },
  ];
  const lastUsed = new Map([["key-a", 300], ["key-b", 100], ["key-c", 200]]);
  assert.deepEqual(
    sortFactoryApiKeysByLastUsed(keys, (entry) => lastUsed.get(entry.key)).map((entry) => entry.label),
    ["second", "third", "first"],
  );
});

test("rotating keys skip only the credential exhausted for the selected billing pool", () => {
  const selected = selectFactoryApiKeysByLimits(
    [
      { label: "standard-exhausted", key: "key-a" },
      { label: "available", key: "key-b" },
    ],
    "gpt-5.6-luna",
    (key) =>
      key === "key-a"
        ? { available: false, pool: "standard", exhausted: "monthly", resetAt: Date.now() + 3_600_000, label: "standard-exhausted" }
        : { available: true, pool: "standard", label: "available" },
  );
  assert.deepEqual(selected.keys.map((entry) => entry.label), ["available"]);
  assert.deepEqual(selected.exhausted, ["standard-exhausted: standard monthly exhausted"]);
});

test("request auth routing distinguishes OAuth, direct keys, and configured key rotation", () => {
  const jwt = `a.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.c`;
  assert.equal(factoryAuthModeFromHeaders({ Authorization: `Bearer ${jwt}` }), "oauth");
  assert.equal(factoryAuthModeFromHeaders({ authorization: "Bearer factory-key" }), "api-key");
  assert.equal(factoryAuthModeFromHeaders({ Authorization: `Bearer ${FACTORY_API_KEY_FILE_SENTINEL}` }), "api-key-file");
  assert.equal(factoryAuthModeFromHeaders({}), "missing");
});
