# Antigravity OAuth

Local persistent Pi provider for Google Antigravity-compatible models.

- Package module: `extensions/antigravity-oauth/`
- Provider id: `antigravity`
- Login command: `/login antigravity`
- Doctor command: `/antigravity.doctor`

This is based on `npm:@raquezha/antigravity` 0.0.10 with the local IPv4 OAuth token exchange fix applied so Google OAuth does not fail with Node `fetch failed` on this machine. The catalog follows `agy models` from Antigravity CLI 1.1.13. Wire routing, model enums, thinking budgets, request labels, CLI identity, and the production Daily Cloud Code endpoint were cross-checked against AGY 1.1.13 captures in `cortexkit/antigravity-auth` 2.1.0.

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
