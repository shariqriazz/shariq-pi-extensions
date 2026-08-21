# Antigravity Provider

Local persistent Pi provider for Google Antigravity-compatible models.

- Package module: `extensions/antigravity-provider/`
- Provider id: `antigravity`
- Login command: `/login antigravity` (repeat once per Google account)
- Account and quota dashboard: `/antigravity`
- Doctor command: `/antigravity.doctor`

The provider includes an IPv4 OAuth token-exchange fallback for Node environments where the default request fails. Its deterministic catalog follows Antigravity CLI 1.1.13 model identifiers and runtime behavior.

Successful logins are added to `<agent-dir>/antigravity/accounts.json`, written with owner-only permissions. Existing Pi OAuth credentials are migrated into that pool without exposing token values. Requests select the least recently used eligible account, skip disabled/cooling/exhausted accounts, refresh expiring OAuth tokens, and rotate to another account when an auth, rate, quota, or capacity failure occurs before response streaming begins. Cached per-model remaining quota and reset times guide selection; `/antigravity` refreshes the authoritative catalog and can reversibly enable or disable accounts.

Current public model IDs:
- `antigravity/gemini-3.7-flash`
- `antigravity/gemini-3.6-flash`
- `antigravity/gemini-3.5-flash`
- `antigravity/gemini-3.1-pro`
- `antigravity/claude-sonnet-4-6`
- `antigravity/claude-opus-4-6`
- `antigravity/gpt-oss-120b`

Pi's thinking selector is normalized to Antigravity's runtime IDs: Flash models clamp `off`/`minimal` to `low` and `xhigh`/`max` to `high`; Gemini 3.1 Pro clamps to its `low`/`high` pair; Claude and GPT-OSS use their single fixed-thinking runtime regardless of the selected Pi level.

The provider id intentionally remains `antigravity`; existing `~/.pi/agent/auth.json` credentials continue to work without moving secret values. After updating `agy`, compare `agy models` with `antigravity/models.ts` before changing this deterministic catalog.
