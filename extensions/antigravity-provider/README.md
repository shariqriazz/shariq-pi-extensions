# Antigravity Provider

Local persistent Pi provider for Google Antigravity-compatible models.

- Package module: `extensions/antigravity-provider/`
- Provider id: `antigravity`
- Login command: `/login antigravity` (repeat once per Google account)
- Account and quota dashboard: `/antigravity`
- Doctor command: `/antigravity.doctor`

The provider includes an IPv4 OAuth token-exchange fallback for Node environments where the default request fails. Its curated catalog follows current Antigravity model identifiers and runtime behavior.

Successful logins are added to `<agent-dir>/antigravity/accounts.json`, written with owner-only permissions. A missing account file triggers one-time migration of an existing Pi OAuth credential; after that, the valid account file is authoritative, so removing an account cannot be undone by a stale credential in `auth.json`. Requests select the least recently used eligible account, skip disabled/cooling/exhausted accounts, refresh expiring OAuth tokens, and rotate to another account when an auth, rate, quota, or capacity failure occurs before response streaming begins. Cached per-model remaining quota and reset times guide selection; `/antigravity` refreshes the authoritative catalog, uses `d` to reversibly enable or disable an account, and uses `x` plus confirmation to remove one permanently.

Current public model IDs:
- `antigravity/gemini-3.7-flash`
- `antigravity/gemini-3.1-pro`
- `antigravity/claude-sonnet-4-6`
- `antigravity/claude-opus-4-6`

The provider intentionally exposes only the latest Gemini Flash and Pro generations and the latest Claude Sonnet and Opus family. `/antigravity` shows the shared five-hour and weekly limits for the Gemini and Claude pools instead of listing every upstream runtime variant.

Pi's thinking selector is normalized to Antigravity's runtime IDs: Gemini 3.7 Flash clamps `off`/`minimal` to `low` and `xhigh`/`max` to `high`; Gemini 3.1 Pro clamps to its `low`/`high` pair; Claude models use their fixed-thinking runtime regardless of the selected Pi level.

The provider id intentionally remains `antigravity`; existing `~/.pi/agent/auth.json` credentials continue to work without moving secret values. After updating `agy`, compare `agy models` with `antigravity/models.ts` before changing this deterministic catalog.
