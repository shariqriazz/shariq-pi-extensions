# Native Firecrawl web tools

Provides two focused Pi tools backed directly by Firecrawl API v2:

- `web_search` — live web, news, image, GitHub, research, and PDF discovery; optional result extraction.
- `web_scrape` — rendered main-content extraction from one difficult or JavaScript-heavy URL.

Keep the separate `web_fetch` tool for lightweight exact URL and API retrieval without Firecrawl credits.

## Authentication

Credential precedence:

1. `FIRECRAWL_API_KEY` / optional `FIRECRAWL_API_URL` environment variables.
2. `~/.pi/agent/.env`.
3. The existing Firecrawl CLI credential store (`firecrawl login`).

Credentials are read at call time, never copied into source or tool output. Full oversized responses are stored with restrictive permissions under `/tmp/pi-firecrawl/`.

## Context and cost controls

- Search defaults to five compact results without scraping.
- Search is capped at 20 results per source.
- Scraping search results must be requested explicitly.
- Tool output is capped at Pi's 50KB/2000-line limits; complete truncated responses are saved to a temporary file.
- Search and scrape results are marked as untrusted web content.
- No automatic search feedback is submitted.

## Validation

From the repository root, run `npm run validate`.
