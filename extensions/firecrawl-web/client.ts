import type { FirecrawlConfig } from "./auth.ts";

export type SearchSource = "web" | "news" | "images";
export type SearchCategory = "github" | "research" | "pdf";
export type SearchContent = "none" | "summary" | "markdown";
export type ScrapeFormat = "markdown" | "summary" | "links" | "question" | "highlights";
export type ProxyMode = "basic" | "auto" | "enhanced";
export type DeveloperSearchType = "doc" | "issue" | "pull_request" | "readme";

export type WebSearchParams = {
  query: string;
  limit?: number;
  sources?: SearchSource[];
  categories?: SearchCategory[];
  tbs?: string;
  include_domains?: string[];
  exclude_domains?: string[];
  location?: string;
  country?: string;
  scrape?: SearchContent;
  only_main_content?: boolean;
  content_max_characters?: number;
  timeout_seconds?: number;
};

export type DeveloperSearchParams = {
  query: string;
  limit?: number;
  types?: DeveloperSearchType[];
  repos?: string[];
  sources?: string[];
  language?: string;
  topic?: string;
  license?: string;
  min_stars?: number;
  max_stars?: number;
  archived?: boolean;
  fork?: boolean;
  skills?: "only";
  passages?: number;
  timeout_seconds?: number;
};

export type WebScrapeParams = {
  url: string;
  format?: ScrapeFormat;
  query?: string;
  only_main_content?: boolean;
  only_clean_content?: boolean;
  wait_for_ms?: number;
  max_age_ms?: number;
  mobile?: boolean;
  proxy?: ProxyMode;
  timeout_seconds?: number;
};

type FetchLike = typeof fetch;

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const RETRY_DELAYS_MS = [500, 1_500];

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cleanStrings(values: string[] | undefined, maxItems = 20): string[] | undefined {
  const cleaned = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, maxItems);
  return cleaned.length ? cleaned : undefined;
}

function validateDomainFilters(includeDomains: string[] | undefined, excludeDomains: string[] | undefined) {
  if (includeDomains?.length && excludeDomains?.length) {
    throw new Error("Use either include_domains or exclude_domains, not both.");
  }
}

export function buildSearchBody(params: WebSearchParams): Record<string, unknown> {
  const query = params.query?.trim();
  if (!query) throw new Error("web_search requires a query.");
  const includeDomains = cleanStrings(params.include_domains);
  const excludeDomains = cleanStrings(params.exclude_domains);
  validateDomainFilters(includeDomains, excludeDomains);
  const sources = cleanStrings(params.sources) as SearchSource[] | undefined;
  const categories = cleanStrings(params.categories) as SearchCategory[] | undefined;
  const scrape = params.scrape ?? "none";

  return {
    query,
    limit: clampInteger(params.limit, 5, 1, 20),
    ...(sources ? { sources: sources.map((type) => ({ type })) } : {}),
    ...(categories ? { categories: categories.map((type) => ({ type })) } : {}),
    ...(params.tbs?.trim() ? { tbs: params.tbs.trim() } : {}),
    ...(includeDomains ? { includeDomains } : {}),
    ...(excludeDomains ? { excludeDomains } : {}),
    ...(params.location?.trim() ? { location: params.location.trim() } : {}),
    ...(params.country?.trim() ? { country: params.country.trim().toUpperCase() } : {}),
    timeout: clampInteger(params.timeout_seconds, 60, 5, 120) * 1_000,
    ignoreInvalidURLs: true,
    ...(scrape === "none"
      ? {}
      : {
          scrapeOptions: {
            formats: [{ type: scrape }],
            onlyMainContent: params.only_main_content ?? true,
          },
        }),
  };
}

export function buildScrapeBody(params: WebScrapeParams): Record<string, unknown> {
  const url = params.url?.trim();
  if (!url || !URL.canParse(url) || !/^https?:\/\//i.test(url)) {
    throw new Error("web_scrape requires a fully formed HTTP or HTTPS URL.");
  }
  const format = params.format ?? "markdown";
  const query = params.query?.trim();
  if ((format === "question" || format === "highlights") && !query) {
    throw new Error(`web_scrape format ${format} requires query.`);
  }
  const formatSpec = format === "question"
    ? { type: "question", question: query }
    : format === "highlights"
      ? { type: "highlights", query }
      : { type: format };

  return {
    url,
    formats: [formatSpec],
    onlyMainContent: params.only_main_content ?? true,
    ...(params.only_clean_content != null ? { onlyCleanContent: params.only_clean_content } : {}),
    ...(params.wait_for_ms != null ? { waitFor: clampInteger(params.wait_for_ms, 0, 0, 60_000) } : {}),
    ...(params.max_age_ms != null ? { maxAge: clampInteger(params.max_age_ms, 0, 0, 31_536_000_000) } : {}),
    ...(params.mobile != null ? { mobile: params.mobile } : {}),
    ...(params.proxy ? { proxy: params.proxy } : {}),
    timeout: clampInteger(params.timeout_seconds, 60, 5, 120) * 1_000,
    removeBase64Images: true,
    blockAds: true,
  };
}

export function buildDeveloperSearchBody(params: DeveloperSearchParams): Record<string, unknown> {
  const query = params.query?.trim();
  if (!query) throw new Error("dev_search requires a query.");

  const types = cleanStrings(params.types) as DeveloperSearchType[] | undefined;
  const repos = cleanStrings(params.repos);
  const sources = cleanStrings(params.sources);

  if (types && repos && !types.some((t) => t === "issue" || t === "pull_request" || t === "readme")) {
    throw new Error("repos filter requires at least one repository type (issue, pull_request, or readme) in types.");
  }
  if (types && sources && !types.includes("doc")) {
    throw new Error("sources filter requires doc in types.");
  }

  const k = clampInteger(params.limit, 5, 1, 20);
  const passages = clampInteger(params.passages, 1, 1, 5);

  return {
    query,
    k,
    passages,
    ...(types?.length ? { types } : {}),
    ...(repos?.length ? { repos } : {}),
    ...(sources?.length ? { sources } : {}),
    ...(params.skills === "only" ? { skills: "only" } : {}),
    ...(params.language?.trim() ? { language: params.language.trim() } : {}),
    ...(params.topic?.trim() ? { topic: params.topic.trim() } : {}),
    ...(params.license?.trim() ? { license: params.license.trim() } : {}),
    ...(typeof params.min_stars === "number" && params.min_stars >= 0 ? { min_stars: Math.floor(params.min_stars) } : {}),
    ...(typeof params.max_stars === "number" && params.max_stars >= 0 ? { max_stars: Math.floor(params.max_stars) } : {}),
    ...(typeof params.archived === "boolean" ? { archived: params.archived } : {}),
    ...(typeof params.fork === "boolean" ? { fork: params.fork } : {}),
  };
}

function endpointUrl(config: FirecrawlConfig, endpoint: "search" | "scrape" | "search/developer"): string {
  const base = config.apiUrl.replace(/\/+$/, "");
  return `${base.endsWith("/v2") ? base : `${base}/v2`}/${endpoint}`;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(10_000, seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(10_000, date - Date.now())) : undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Request aborted"));
    }, { once: true });
  });
}

function redactSecrets(text: string): string {
  return text.replace(/fc-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

async function readResponseBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Firecrawl response exceeded 25 MiB.");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel("Firecrawl response exceeded 25 MiB.").catch(() => undefined);
      throw new Error("Firecrawl response exceeded 25 MiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function firecrawlRequest(
  endpoint: "search" | "scrape" | "search/developer",
  body: Record<string, unknown>,
  config: FirecrawlConfig,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  options?: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const timeoutMs = options?.timeoutMs || Number(body.timeout) || 60_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`Firecrawl ${endpoint} timed out.`)), timeoutMs + 5_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await fetchImpl(endpointUrl(config, endpoint), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "pi-firecrawl-web/1.0",
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Firecrawl response exceeded 25 MiB.");
      const bytes = await readResponseBounded(response);
      const text = new TextDecoder().decode(bytes);
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Firecrawl returned invalid JSON (HTTP ${response.status}).`);
      }

      if (response.ok) return payload as Record<string, unknown>;
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        await delay(retryAfterMs(response.headers.get("retry-after")) ?? RETRY_DELAYS_MS[attempt], signal);
        continue;
      }
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const message = typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
      throw new Error(`Firecrawl ${endpoint} failed: ${redactSecrets(message).slice(0, 1_000)}`);
    } catch (error) {
      if (signal?.aborted) throw new Error(`Firecrawl ${endpoint} cancelled.`);
      if (timeout.signal.aborted) throw timeout.signal.reason;
      lastError = error;
      if (attempt >= RETRY_DELAYS_MS.length || !(error instanceof TypeError)) throw error;
      await delay(RETRY_DELAYS_MS[attempt], signal);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Firecrawl ${endpoint} failed.`);
}
