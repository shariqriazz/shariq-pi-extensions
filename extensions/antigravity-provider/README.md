# Antigravity Provider

Local persistent Pi provider for Google Antigravity-compatible models.

- Package module: `extensions/antigravity-provider/`
- Provider id: `antigravity`
- Login command: `/login antigravity`
- Doctor command: `/antigravity.doctor`

The provider includes an IPv4 OAuth token-exchange fallback for Node environments where the default request fails. Its deterministic catalog follows Antigravity CLI 1.1.13 model identifiers and runtime behavior.

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
