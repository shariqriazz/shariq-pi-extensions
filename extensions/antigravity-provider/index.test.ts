import assert from "node:assert/strict";
import test from "node:test";
import antigravityProviderExtension from "./index.ts";
import { loadCodeAssist, sanitizeText } from "./antigravity/oauth.ts";
import { classifyAntigravityFailure, eligibleAntigravityAccounts, parseAntigravityQuota } from "./antigravity/accounts.ts";

test("preserves valid non-BMP Unicode and replaces only unpaired surrogates", () => {
  assert.equal(sanitizeText("A😀B"), "A😀B");
  assert.equal(sanitizeText(`A${String.fromCharCode(0xd800)}B`), "A�B");
});

test("discovery requests honor cancellation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  })) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = loadCodeAssist("token", controller.signal);
    controller.abort(new Error("cancelled discovery"));
    await assert.rejects(pending, /cancelled discovery/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parses model quotas and exact reset times", () => {
  const quota = parseAntigravityQuota({
    models: {
      "gemini-3.7-flash-low": { displayName: "Gemini Flash", quotaInfo: { remainingFraction: 0.25, resetTime: "2030-01-01T00:00:00Z" } },
      "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0, resetTime: "2030-01-02T00:00:00Z" } },
    },
  });
  assert.deepEqual(quota.map((entry) => [entry.modelId, entry.group, entry.remainingFraction]), [
    ["gemini-3.7-flash-low", "gemini", 0.25],
    ["claude-opus-4-6-thinking", "non-gemini", 0],
  ]);
  const failure = classifyAntigravityFailure("429 quota reached; resets in 2h 5m", "gemini-3.7-flash", undefined);
  assert.equal(failure?.reason, "quota");
  assert.ok((failure?.until ?? 0) > Date.now() + 2 * 60 * 60 * 1000);
});

test("rotation skips unavailable accounts and balances by least recent use", () => {
  const now = Date.now();
  const base = { refresh: "refresh", access: "access", expires: now + 60_000, projectId: "project", addedAt: now };
  const selected = eligibleAntigravityAccounts([
    { ...base, id: "recent", lastUsedAt: now - 1_000 },
    { ...base, id: "rested", lastUsedAt: now - 10_000 },
    { ...base, id: "disabled", disabled: true },
    { ...base, id: "cooldown", cooldownUntil: now + 60_000 },
    { ...base, id: "exhausted", quota: [{ modelId: "gemini-3.7-flash", group: "gemini", remainingFraction: 0, resetTime: new Date(now + 60_000).toISOString() }] },
  ], "gemini-3.7-flash", now);
  assert.deepEqual(selected.map((account) => account.id), ["rested", "recent"]);
});

test("registers one Antigravity provider, dashboard, rotation hooks, and sanitized doctor command", async () => {
  const providers: Array<{ id: string; config: any }> = [];
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const removed: string[] = [];
  const lifecycle = antigravityProviderExtension({
    registerProvider(id: string, config: any) { providers.push({ id, config }); },
    unregisterProvider(id: string) { removed.push(id); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    on(name: string, handler: any) { events.set(name, handler); },
  } as never) as { deactivate(): Promise<void> };

  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, "antigravity");
  assert.ok(providers[0]?.config.models.length > 0);
  assert.equal(typeof providers[0]?.config.oauth.login, "function");
  assert.equal(typeof providers[0]?.config.streamSimple, "function");
  assert.ok(commands.has("antigravity"));
  assert.ok(commands.has("antigravity.doctor"));
  assert.ok(events.has("session_start"));
  assert.ok(events.has("agent_end"));

  const notices: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => { logs.push(String(message ?? "")); };
  try {
    await commands.get("antigravity.doctor").handler("", {
      hasUI: true,
      ui: { notify(message: string) { notices.push(message); } },
    });
  } finally {
    console.log = originalLog;
  }
  assert.match(notices[0] ?? "", /provider=antigravity/);
  assert.match(logs[0] ?? "", /provider=antigravity/);
  assert.doesNotMatch(notices[0] ?? "", /access_token|refresh_token/i);
  assert.match(notices[0] ?? "", /rotation=quota-aware-lru/);

  await lifecycle.deactivate();
  assert.deepEqual(removed, ["antigravity"]);
});
