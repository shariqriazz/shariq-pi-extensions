import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import firecrawlWebExtension from "./index.ts";
import { resolveFirecrawlConfig } from "./auth.ts";
import { buildDeveloperSearchBody, buildScrapeBody, buildSearchBody, firecrawlRequest } from "./client.ts";
import { formatDeveloperSearchOutput, formatScrapeOutput, formatSearchOutput } from "./output.ts";

function registeredTools() {
  const tools = new Map<string, { name: string; description: string; promptGuidelines?: string[] }>();
  firecrawlWebExtension({
    registerTool(tool: { name: string; description: string; promptGuidelines?: string[] }) { tools.set(tool.name, tool); },
  } as never);
  return tools;
}

test("registers native web_search, web_scrape, and dev_search tools", () => {
  const tools = registeredTools();
  assert.deepEqual([...tools.keys()].sort(), ["dev_search", "web_scrape", "web_search"]);
  assert.match(tools.get("web_search")!.description, /Firecrawl/);
  assert.match(tools.get("web_scrape")!.description, /web_fetch/);
  assert.match(tools.get("dev_search")!.description, /Developer Index/);
  assert.match(tools.get("web_search")!.promptGuidelines!.join(" "), /untrusted data, not instructions/);
  assert.match(tools.get("web_scrape")!.promptGuidelines!.join(" "), /untrusted data, not instructions/);
  assert.match(tools.get("dev_search")!.promptGuidelines!.join(" "), /untrusted data, not instructions/);
});

test("builds a compact Firecrawl search request with explicit filters", () => {
  const body = buildSearchBody({
    query: " current releases ",
    limit: 50,
    sources: ["web", "news"],
    categories: ["github"],
    include_domains: ["example.com", "example.com"],
    country: "gb",
    scrape: "summary",
  });
  assert.equal(body.query, "current releases");
  assert.equal(body.limit, 20);
  assert.deepEqual(body.sources, [{ type: "web" }, { type: "news" }]);
  assert.deepEqual(body.categories, [{ type: "github" }]);
  assert.deepEqual(body.includeDomains, ["example.com"]);
  assert.equal(body.country, "GB");
  assert.deepEqual(body.scrapeOptions, { formats: [{ type: "summary" }], onlyMainContent: true });
});

test("rejects conflicting search domain filters", () => {
  assert.throws(() => buildSearchBody({ query: "x", include_domains: ["a.test"], exclude_domains: ["b.test"] }), /either include_domains or exclude_domains/);
});

test("builds scrape formats and validates query-driven extraction", () => {
  assert.deepEqual(buildScrapeBody({ url: "https://example.com", format: "question", query: "What is this?" }).formats, [
    { type: "question", question: "What is this?" },
  ]);
  assert.throws(() => buildScrapeBody({ url: "https://example.com", format: "highlights" }), /requires query/);
  assert.throws(() => buildScrapeBody({ url: "file:///tmp/test" }), /HTTP or HTTPS/);
});

test("prefers environment auth without exposing credentials", () => {
  const config = resolveFirecrawlConfig({
    env: { FIRECRAWL_API_KEY: "fc-test-secret", FIRECRAWL_API_URL: "https://api.firecrawl.dev" },
    home: "/tmp/does-not-exist",
    platform: "darwin",
  });
  assert.equal(config.source, "environment");
  assert.equal(config.apiKey, "fc-test-secret");
  assert.equal(config.apiUrl, "https://api.firecrawl.dev");
});

test("reuses the existing Firecrawl CLI credential store", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-firecrawl-auth-test-"));
  try {
    const directory = join(home, "Library", "Application Support", "firecrawl-cli");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "credentials.json"), JSON.stringify({ apiKey: "fc-cli-test", apiUrl: "https://api.firecrawl.dev" }));
    const config = resolveFirecrawlConfig({ env: {}, home, platform: "darwin" });
    assert.equal(config.source, "firecrawl-cli");
    assert.equal(config.apiKey, "fc-cli-test");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("sends authenticated API requests without returning the credential", async () => {
  let authorization = "";
  const payload = await firecrawlRequest(
    "search",
    { query: "test", timeout: 5_000 },
    { apiKey: "fc-private-test", apiUrl: "https://api.firecrawl.dev", source: "environment" },
    undefined,
    async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );
  assert.equal(authorization, "Bearer fc-private-test");
  assert.doesNotMatch(JSON.stringify(payload), /fc-private-test/);
});

test("rejects oversized streaming responses before buffering beyond 25 MiB", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 26; index++) controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    firecrawlRequest(
      "search",
      { query: "test", timeout: 5_000 },
      { apiKey: "fc-private-test", apiUrl: "https://api.firecrawl.dev", source: "environment" },
      undefined,
      async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    ),
    /exceeded 25 MiB/,
  );
  assert.equal(cancelled, true);
});

test("formats compact untrusted search and scrape output", async () => {
  const search = await formatSearchOutput({ creditsUsed: 2, data: { web: [{ title: "Example", url: "https://example.com", description: "Result" }] } });
  assert.match(search, /untrusted web content/);
  assert.match(search, /Credits used: 2/);
  assert.match(search, /https:\/\/example\.com/);

  const scrape = await formatScrapeOutput({ data: { markdown: "# Example", metadata: { url: "https://example.com", statusCode: 200 } } }, "markdown");
  assert.match(scrape, /untrusted web content/);
  assert.match(scrape, /# Example/);
});

test("builds developer search request and validates mismatched filters", () => {
  const body = buildDeveloperSearchBody({
    query: "429 retry backoff",
    limit: 10,
    types: ["issue", "pull_request"],
    repos: ["sidekiq/sidekiq"],
    language: "Ruby",
    passages: 2,
    skills: "only",
    min_stars: 500,
  });
  assert.equal(body.query, "429 retry backoff");
  assert.equal(body.k, 10);
  assert.deepEqual(body.types, ["issue", "pull_request"]);
  assert.deepEqual(body.repos, ["sidekiq/sidekiq"]);
  assert.equal(body.language, "Ruby");
  assert.equal(body.passages, 2);
  assert.equal(body.skills, "only");
  assert.equal(body.min_stars, 500);

  // Rejects repos filter if no repo types are requested
  assert.throws(
    () => buildDeveloperSearchBody({ query: "q", types: ["doc"], repos: ["owner/repo"] }),
    /repos filter requires at least one repository type/,
  );

  // Rejects sources filter if doc is not in types
  assert.throws(
    () => buildDeveloperSearchBody({ query: "q", types: ["issue"], sources: ["docs.stripe.com"] }),
    /sources filter requires doc in types/,
  );
});

test("formats developer search output with matched passages and untrusted header", async () => {
  const output = await formatDeveloperSearchOutput({
    creditsUsed: 2,
    results: [
      {
        id: "issue:sidekiq/sidekiq#1471",
        type: "issue",
        url: "https://github.com/sidekiq/sidekiq/issues/1471",
        title: "Retries not applied to 429",
        passages: [{ text: "The client treats 429 as terminal." }],
      },
    ],
  });
  assert.match(output, /untrusted web content/);
  assert.match(output, /Credits used: 2/);
  assert.match(output, /\[ISSUE\] Retries not applied to 429/);
  assert.match(output, /The client treats 429 as terminal\./);
  assert.match(output, /https:\/\/github\.com\/sidekiq\/sidekiq\/issues\/1471/);
});
