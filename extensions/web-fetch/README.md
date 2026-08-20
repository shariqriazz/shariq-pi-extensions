# Web Fetch

Pi local extension that registers `web_fetch`, a read-only exact-URL retrieval tool inspired by OpenCode's `webfetch`.

Use `web_search` for discovery and `web_fetch` for retrieval from a specific URL.

Parameters:

- `url` — required `http://` or `https://` URL
- `format` — `markdown` (default), `text`, or `html`
- `timeoutSeconds` — default 30, max 120
- `maxBytes` — default 5 MiB, max 25 MiB
- `userAgent` — optional override
