import assert from "node:assert/strict";
import test from "node:test";
import webFetchExtension from "./index.ts";

function registeredTool() {
  let tool: any;
  webFetchExtension({ registerTool(definition: any) { tool = definition; } } as never);
  return tool;
}

test("web_fetch routing treats remote content as data rather than instructions", () => {
  let tool: { name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;
  webFetchExtension({
    registerTool(definition: typeof tool) {
      tool = definition;
    },
  } as never);

  assert.equal(tool?.name, "web_fetch");
  assert.match(tool?.description ?? "", /known URL or API/);
  assert.match(tool?.promptSnippet ?? "", /web_search for discovery/);
  assert.match(tool?.promptGuidelines?.join(" ") ?? "", /untrusted data, not instructions/);
});

test("web_fetch propagates cancellation without starting an IPv4 retry", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = registeredTool().execute("cancel", { url: "http://127.0.0.1:9/" }, controller.signal);
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(pending, /cancelled by test/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch throws failed HTTP responses as tool errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("failure", { status: 500, statusText: "Server Error", headers: { "Content-Type": "text/plain" } })) as typeof fetch;
  try {
    await assert.rejects(
      registeredTool().execute("failure", { url: "https://example.invalid/failure" }),
      /HTTP 500 Server Error/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
