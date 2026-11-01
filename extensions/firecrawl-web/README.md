# Firecrawl web tools

Three Pi tools backed by the Firecrawl v2 API:

- `web_search` — live web, news, image, GitHub, research, and PDF discovery; optional result extraction.
- `web_scrape` — rendered main-content extraction from one difficult or JavaScript-heavy URL.
- `dev_search` — search 70M+ technical docs, GitHub issues, merged pull requests, and READMEs via Firecrawl Developer Index with matched markdown code passages.

Keep the separate `web_fetch` tool for lightweight exact URL and API retrieval without Firecrawl credits.

## Authentication

Credential precedence:

1. `FIRECRAWL_API_KEY` / optional `FIRECRAWL_API_URL` environment variables.
2. `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` in `<agent-dir>/.env`.
3. The existing Firecrawl CLI credential store (`firecrawl login`).

Without a key the three tools are not registered, so they never appear in the model's tool list; a one-time notice explains how to add a key, and `/reload` registers them afterwards. Credentials are read at call time and never appear in tool output. Complete responses that are too large for tool output are saved with restrictive permissions under `pi-firecrawl/` in the system temporary directory.

## Context and cost controls

- Search defaults to five compact results without scraping.
- Search is capped at 20 results per source.
- Scraping search results must be requested explicitly.
- Tool output is capped at Pi's 50KB/2000-line limits; complete truncated responses are saved to a temporary file.
- Search and scrape results are marked as untrusted web content.
- All three tools declare read-only, open-world annotations and stay callable from codemode scripts.
- No automatic search feedback is submitted.
