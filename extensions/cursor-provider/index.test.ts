import assert from "node:assert/strict";
import test from "node:test";
import cursorProviderExtension from "./index.ts";
import { loginCursor, refreshCursorToken } from "./cursor/auth.ts";
import { CursorDashboard } from "./cursor/dashboard.ts";
import { resolveCursorModelSelection, toCursorPiModels } from "./cursor/models.ts";
import { formatCursorError, serializeCursorContext } from "./cursor/stream.ts";
import { dollars, percentUsed } from "./cursor/usage.ts";

const catalog = [
  { id: "composer-2.5", displayName: "Composer 2.5", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }] },
  { id: "composer-2", displayName: "Composer 2" },
  { id: "grok-4.5", displayName: "Cursor Grok 4.5", parameters: [{ id: "effort", values: ["low", "medium", "high"].map((value) => ({ value })) }] },
  { id: "grok-4.6", displayName: "Cursor Grok 4.6", parameters: [{ id: "effort", values: ["low", "medium", "high", "xhigh"].map((value) => ({ value })) }] },
  { id: "gpt-5.6", displayName: "GPT 5.6" },
];

test("uses Cursor SDK browser login and keeps the minted key in Pi credentials", async () => {
  const urls: string[] = [];
  const expires = Date.now() + 90 * 24 * 60 * 60_000;
  const credentials = await loginCursor({
    onAuth(info) { urls.push(info.url); },
    onDeviceCode() {},
    async onPrompt() { return ""; },
    async onSelect() { return "browser"; },
  }, async (options) => {
    options?.onLoginUrl?.("https://cursor.com/loginDeepControl?test=1");
    return { apiKey: "cursor-key", apiKeyExpiresAtMs: expires };
  }, async () => undefined);
  assert.deepEqual(urls, ["https://cursor.com/loginDeepControl?test=1"]);
  assert.equal(credentials.access, "cursor-key");
  assert.ok(credentials.expires < expires);
  assert.deepEqual(await refreshCursorToken(credentials), credentials);
});

test("validates CURSOR_API_KEY without duplicating the model catalog", async () => {
  const previous = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "crsr_test";
  let validated = "";
  try {
    const credentials = await loginCursor({
      onAuth() {},
      onDeviceCode() {},
      async onPrompt() { return ""; },
      async onSelect() { return "environment"; },
    }, async () => { throw new Error("browser login should not run"); }, async () => undefined, async (key) => { validated = key; });
    assert.equal(credentials.access, "crsr_test");
    assert.equal(validated, "crsr_test");
    assert.deepEqual(await refreshCursorToken(credentials), credentials);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
  }
});

test("registers only Cursor-owned models with images and parameterized variants", () => {
  const models = toCursorPiModels(catalog);
  assert.deepEqual(models.map((model) => model.id), ["composer-2.5", "composer-2.5-fast", "cursor-grok-4.5", "cursor-grok-4.6"]);
  assert.ok(models.every((model) => model.input.includes("image")));
  assert.equal(models[1]?.cost.input, 3);
  assert.equal(models[2]?.contextWindow, 256_000);
  assert.deepEqual(resolveCursorModelSelection(models[1] as never, undefined, catalog), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  });
  assert.deepEqual(resolveCursorModelSelection(models[2] as never, "max", catalog), {
    id: "grok-4.5",
    params: [{ id: "effort", value: "high" }],
  });
  assert.deepEqual(resolveCursorModelSelection(models[3] as never, "off", catalog), {
    id: "grok-4.6",
    params: [{ id: "effort", value: "low" }],
  });
});

test("serializes full Pi context and forwards image bytes separately", () => {
  const result = serializeCursorContext({
    systemPrompt: "system",
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], timestamp: 2 } as never,
      { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "source" }], timestamp: 3 },
    ],
    tools: [],
  });
  assert.equal(result.images.length, 1);
  assert.equal((result.images[0] as any).data, "aW1hZ2U=");
  assert.ok(result.text.includes("inspect"));
  assert.ok(result.text.includes("Tool call call-1"));
  assert.ok(result.text.includes("source"));
  assert.ok(!result.text.includes("aW1hZ2U="));
});

test("renders Cursor monthly totals without Factory-style windows", () => {
  const passthrough = (_name: string, text: string) => text;
  const dashboard = new CursorDashboard(
    { terminal: { rows: 30 }, requestRender() {} } as never,
    { fg: passthrough, bg: passthrough, bold: (text: string) => text } as never,
    { matches() { return false; } } as never,
    {
      authentication: "OAuth",
      usage: {
        email: "user@example.com",
        apiKeyName: "Pi",
        plan: { planName: "Pro", includedAmountCents: 2_000 },
        usage: { totalSpend: 800, includedSpend: 2_000, bonusSpend: 0, remaining: 1_200, limit: 2_000, totalPercentUsed: 40, autoPercentUsed: 35, apiPercentUsed: 5 },
        billingCycleStart: Date.now(),
        billingCycleEnd: Date.now() + 86_400_000,
        enabled: true,
        canAdjustOnDemand: true,
        models: catalog.slice(0, 2),
        fetchedAt: Date.now(),
      },
    },
    async () => ({ authentication: "OAuth" }),
    () => {},
  );
  const rendered = dashboard.render(100).join("\n");
  assert.match(rendered, /CURRENT MONTH/);
  assert.match(rendered, /MONTHLY TOTAL USAGE/);
  assert.match(rendered, /Auto \/ Composer/);
  assert.doesNotMatch(rendered, /5-HOUR|WEEKLY|DROID CORE/);
  assert.equal(dollars(2_000), "$20.00");
  assert.equal(percentUsed((dashboard as any).snapshot.usage), 40);
});

test("maps Cursor failures to actionable provider errors", () => {
  assert.match(formatCursorError(new Error("HTTP 429")), /rate limit/i);
  assert.match(formatCursorError(new Error("context too long")), /Compact/i);
  assert.match(formatCursorError(new Error("invalid api key")), /login cursor/i);
});

test("registers the native non-ACP Cursor provider", async () => {
  const providers: any[] = [];
  const commands: string[] = [];
  await cursorProviderExtension({
    registerProvider(id: string, config: any) { providers.push({ id, config }); },
    unregisterProvider() {},
    registerCommand(name: string) { commands.push(name); },
    on() {},
  } as never);
  assert.equal(providers[0].id, "cursor");
  assert.equal(providers[0].config.api, "cursor-sdk");
  assert.equal(typeof providers[0].config.oauth.login, "function");
  assert.equal(typeof providers[0].config.streamSimple, "function");
  assert.ok(providers[0].config.models.every((model: any) => model.id.startsWith("composer-") || model.id.startsWith("cursor-grok-")));
  assert.deepEqual(commands, ["cursor", "cursor.doctor"]);
});
