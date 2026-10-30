# Web Fetch

Registers `web_fetch`, a read-only tool that retrieves one known URL without spending Firecrawl credits. HTML is converted to Markdown (tables, lists, images, and links resolved against the final URL) or text; JSON, Markdown, and other non-HTML responses are returned exactly as served, decoded with their declared charset. Responses are bounded by one deadline across redirects and by size, and compressed bodies are limited by their decoded size. Cookies set during a redirect chain are sent back to the same host for the rest of that fetch and then discarded, so sites that redirect until a cookie returns still load.

Requests to localhost, private, link-local (including cloud metadata), and other non-public addresses are blocked, including through redirects and DNS names that resolve to them. Each connection uses the address that was checked, so DNS rebinding cannot swap it. Set `PI_WEB_FETCH_ALLOW_PRIVATE=1` to allow local destinations.

Use `web_search` for discovery and `web_fetch` for retrieval from a specific URL.

Parameters:

- `url` — required `http://` or `https://` URL
- `format` — `markdown` (default), `text`, or `html`
- `timeoutSeconds` — default 30, max 120
- `maxBytes` — default 5 MiB, max 25 MiB
- `userAgent` — optional override
