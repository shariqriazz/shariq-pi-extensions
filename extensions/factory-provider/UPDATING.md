# Updating Factory Droid OAuth provider

## Routine update flow

Factory's model list and required client version should follow the installed Droid CLI.

```bash
droid --version
droid exec --help
```

Refresh the deterministic Droid cache explicitly, then reload Pi:

```bash
FACTORY_DROID_REFRESH=1 pi --list-models factory
```

```text
/reload
```

Normal startup and reload do not invoke Droid; they use the refreshed cache or deterministic fallback catalog.

## Files to update manually if needed

- `factory/constants.ts`
  - `FACTORY_CLIENT_PROTOCOL`
  - `FALLBACK_DROID_VERSION`
  - WorkOS/API base URLs if Factory changes them.
- `factory/models.ts`
  - `parseModelsFromDroidHelp()` if Droid help formatting changes.
  - `BINARY_CAPABILITIES` for context window, max output tokens, image support, and PDF support.
  - `DROID_MODELS_FALLBACK` if parser fails or Droid is unavailable.
- `factory/auth.ts`
  - WorkOS device/refresh flow and Droid encrypted auth import.

## Updating Droid

Try Droid's updater first:

```bash
droid update
```

If unavailable, reinstall via Factory's current installer:

```bash
curl -fsSL https://app.factory.ai/cli | sh
```

Then verify:

```bash
which droid
droid --version
droid exec --help
```

## Binary inspection checklist

If Factory changes endpoints or headers, inspect the installed binary locally:

```bash
strings "$(which droid)" | rg 'api/llm/o/v1|X-Factory-Client|X-Client-Version|workos|authorize/device|client_01HNM'
```

Known current values:

- Model registry values are embedded near the Droid binary strings for `$o={...}` with fields like `contextLimits`, `images`, and `pdf`.
- Examples verified through Droid 0.200.0:
  - Gemini 3.7 Flash: `maxInputTokens: 1000000`, `maxOutputTokens: 65536`, PDF and image input enabled, with `low`, `medium`, and `high` reasoning.
  - Inkling: `maxInputTokens: 1040000`, `maxOutputTokens: 32768`, images enabled, PDF disabled, Fireworks and Baseten routes.
  - DeepSeek V4 Flash 0731: `maxInputTokens: 1040000`, `maxOutputTokens: 131072`, images/PDF disabled, Fireworks route.
  - Claude Opus 4.8: `contextLimits: zuT` => `maxInputTokens: 867000`, `maxOutputTokens: 128000`, `pdf: true`, images enabled.
  - Claude Sonnet 4.6: `maxInputTokens: 931000`, `maxOutputTokens: 64000`.
  - GPT-5.6/GPT-5.5 Pro: `maxInputTokens: 1050000`, `maxOutputTokens: 128000`.
  - Grok 4.6: `maxInputTokens: 200000`, `maxOutputTokens: 63356`, images enabled, PDF disabled.
  - MiniMax M3: `maxInputTokens: 512000`, `maxOutputTokens: 64000`, images enabled, PDF disabled.
  - GLM-5.2: `maxInputTokens: 1040000`, `maxOutputTokens: 131072`, no images/PDF.
  - GLM-5.2 Fast: `maxInputTokens: 524288`, `maxOutputTokens: 131072`, no images/PDF.
  - DeepSeek V4 Pro: `maxInputTokens: 1040000`, `maxOutputTokens: 65536`, no images/PDF.
- Responses base: `https://api.factory.ai/api/llm/o/v1`
- Required headers:
  - `X-Factory-Client: cli`
  - `X-Client-Version: <droid --version>`
- WorkOS base: `https://api.workos.com/user_management`
- Production WorkOS client ID: `client_01HNM792M5G5G1A2THWPXKFMXB`

## Smoke test after updates

1. `/reload`
2. `/login factory` if not logged in.
3. Run `/factory-status` and `/factory-limits`.
4. Confirm Standard and Droid Core usage appears separately for each configured credential.
5. Send a tiny prompt with `factory/gpt-5.6-sol` or another known model.

If Factory responds with `Unable to determine client version`, inspect/update `FACTORY_CLIENT_PROTOCOL` or Droid version detection.
