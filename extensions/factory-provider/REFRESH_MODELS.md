# Refreshing Factory/Droid models and capabilities

Normal Pi startup/reload must stay fast and deterministic. The runtime extension should not inspect the Droid binary, call `droid exec --help`, or probe Factory endpoints on every load.

Use this guide only when you explicitly want to refresh the local Factory catalog after Droid/Factory changes.

## When to refresh

Refresh when one of these happens:

- Factory adds/removes models.
- Droid updates and `droid exec --help` shows a changed model list.
- A model starts failing because its endpoint family changed.
- Context windows, max output tokens, image/PDF support, or reasoning levels change.
- Factory changes required headers or client-version behavior.

## Current runtime source of truth

The extension currently reads deterministic local code at startup:

- `factory/models.ts` — model catalog, capabilities, endpoint family routing.
- `factory/constants.ts` — Factory/WorkOS constants and Droid fallback version.
- `factory/responses.ts` — per-family routing and request compatibility fixes.

Normal `/reload` should not run Droid.

## Manual refresh checklist

When you ask to refresh models, inspect the installed Droid binary/CLI locally and update the deterministic catalog.

### 1. Check Droid version and help output

```bash
which droid
droid --version
droid exec --help
```

Capture:

- model IDs
- display names
- default model
- reasoning support/defaults from `Model details`
- deprecated markers

### 2. Inspect embedded registry for capabilities

Use binary strings around the model registry instead of guessing:

```bash
DROID_BIN="$(command -v droid)" python3 - <<'PY'
import os
from pathlib import Path
s = Path(os.environ['DROID_BIN']).read_bytes().decode('utf-8', 'ignore')
for model in [
    'gpt-5.6-sol',
    'claude-opus-5',
    'gemini-3.1-pro-preview',
    'gemini-3.7-flash',
    'grok-4.6',
    'minimax-m3',
    'glm-5.2-fast',
    'kimi-k3',
    'inkling',
    'glm-5.2',
    'deepseek-v4-flash-0731',
    'deepseek-v4-pro',
]:
    pat = f'"{model}":{{id:"{model}"'
    i = s.find(pat)
    print('\n###', model, i)
    if i != -1:
        j = s.find('},"', i + len(pat))
        print(s[i:j+1].replace('\x00', ' ')[:2000])
PY
```

Look for fields like:

- `contextLimits`
- `maxInputTokens`
- `maxOutputTokens`
- `images`
- `pdf`
- `apiProviders`
- `apiModelProvider`
- `reasoningEffort`
- `baseVariant`
- `availableInCLI`
- `deprecation`

### 3. Check helper constants in the binary

Some models point at shared helper variables. Inspect those too:

```bash
DROID_BIN="$(command -v droid)" python3 - <<'PY'
import os
from pathlib import Path
s = Path(os.environ['DROID_BIN']).read_bytes().decode('utf-8', 'ignore')
for name in ['zuT=', 'zNr=', 'YNr=', 'PTT=', 'aiA=', 'S4T=']:
    i = s.find(name)
    print('\n', name, i)
    if i != -1:
        print(s[i-300:i+600].replace('\x00', ' '))
PY
```

### 4. Update deterministic catalog

Edit:

```text
extensions/factory-provider/factory/models.ts
```

Update:

- `BINARY_CAPABILITIES`
- `FALLBACK_REASONING`
- `familyForModel()` if endpoint family changes
- `toPiModel()` only if Pi model shape needs adjustment

Preserve the user-curated visibility policy during every refresh:

- Never expose model IDs ending in `-fast`.
- Keep Haiku 4.5, Opus 5, Gemini 3.1 Pro Preview, GLM 5.2 Fast, Inkling, MiniMax M3, and Nemotron 3 Ultra hidden.
- Do not restore the current Gemini Pro, MiniMax M3, Nemotron 3 Ultra, or Inkling entries. Reconsider each family only after its vendor releases a newer generation/model.
- A model reappearing in Droid metadata is not authorization to publish it in Pi.

Endpoint family routing currently means:

- GPT family: `openai-responses` via `https://api.factory.ai/api/llm/o/v1`
- Kimi / GLM / DeepSeek / Nemotron: `openai-completions` via `https://api.factory.ai/api/llm/o/v1`
- Claude / MiniMax: `anthropic-messages` via `https://api.factory.ai/api/llm/a`
- Gemini: custom Factory Gemini route `https://api.factory.ai/api/llm/g/v1/generate`

### 5. Update constants only if changed

Edit:

```text
extensions/factory-provider/factory/constants.ts
```

Check/update:

- `FACTORY_CLIENT_PROTOCOL`
- `FALLBACK_DROID_VERSION`
- `FACTORY_API_BASE_URL`
- `WORKOS_BASE_URL`
- `WORKOS_CLIENT_ID`

### 6. Validate locally

Typecheck:

```bash
npx --yes -p typescript tsc --noEmit -p /tmp/factory-tsconfig.json
```

Then test representative non-fast models only:

```bash
PI_OFFLINE=1 pi -p --no-tools --no-context-files --no-skills --no-prompt-templates --model factory/gpt-5.6-sol 'Reply with exactly: OK'
PI_OFFLINE=1 pi -p --no-tools --no-context-files --no-skills --no-prompt-templates --model factory/claude-sonnet-5 'Reply with exactly: OK'
PI_OFFLINE=1 pi -p --no-tools --no-context-files --no-skills --no-prompt-templates --model factory/gemini-3.7-flash 'Reply with exactly: OK'
PI_OFFLINE=1 pi -p --no-tools --no-context-files --no-skills --no-prompt-templates --model factory/kimi-k3 'Reply with exactly: OK'
PI_OFFLINE=1 pi -p --no-tools --no-context-files --no-skills --no-prompt-templates --model factory/glm-5.2 'Reply with exactly: OK'
```

Avoid fast variants unless specifically debugging them to reduce spend.

## Known gotchas

- Do not run Droid inspection during normal extension load.
- OAuth requests require `X-Factory-Org-Id` and organization-scoped token refreshes include `organization_id`; direct API-key requests use their own account scope without OAuth-only organization metadata.
- Factory may block specific Pi system-prompt phrases; compatibility fixes live in `factory/responses.ts`.
- Factory Anthropic currently rejects system prompts on this OAuth path; `factory/responses.ts` omits Pi's system prompt for Anthropic-family models.
- Some Factory models use OpenAI Chat rather than Responses even though they are under the same `/api/llm/o/v1` base.
- Droid 0.199.0 embeds a conservative 262,144/65,536 Kimi K3 proxy limit; the deterministic catalog intentionally uses Kimi's documented 1,048,576 context and 131,072 default completion limit.
- Explicitly approved feature-gated models are merged from the deterministic fallback catalog when Droid omits them from help. Catalog visibility does not bypass Factory account/org entitlement; gated endpoints may still reject live requests.
- Core-model `fireworks`/`baseten` overrides are selected per model from current OpenRouter throughput, latency, uptime, and context data; re-check them when Droid or provider telemetry changes.
- Gemini uses Factory's custom `/api/llm/g/v1/generate` shape, not the standard Google SDK URL layout.
