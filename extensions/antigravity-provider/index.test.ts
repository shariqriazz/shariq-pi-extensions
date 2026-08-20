import assert from "node:assert/strict";
import test from "node:test";
import antigravityProviderExtension from "./index.ts";
import { loadCodeAssist, sanitizeText } from "./antigravity/oauth.ts";

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

test("registers one Antigravity provider and sanitized doctor command", async () => {
  const providers: Array<{ id: string; config: any }> = [];
  const commands = new Map<string, any>();
  const removed: string[] = [];
  const lifecycle = antigravityProviderExtension({
    registerProvider(id: string, config: any) { providers.push({ id, config }); },
    unregisterProvider(id: string) { removed.push(id); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
  } as never) as { deactivate(): Promise<void> };

  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, "antigravity");
  assert.ok(providers[0]?.config.models.length > 0);
  assert.equal(typeof providers[0]?.config.oauth.login, "function");
  assert.equal(typeof providers[0]?.config.streamSimple, "function");
  assert.ok(commands.has("antigravity.doctor"));

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

  await lifecycle.deactivate();
  assert.deepEqual(removed, ["antigravity"]);
});
