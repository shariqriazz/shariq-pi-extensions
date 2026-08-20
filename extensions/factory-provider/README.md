# Unified Factory provider for Pi

This package module exposes exactly one Pi provider:

```text
factory/<model-id>
```

## Requirements and installation

Use Pi 0.83.0 or newer. Factory access requires either a Factory account or API key. The deterministic catalog and fallback client identity track Droid CLI 0.200.0; an installed Droid CLI can refresh machine-local version and model metadata but is not bundled with this extension.

Install it through the private suite package, then restart Pi or run `/reload` and authenticate with `/login factory`. Verify installation without making a model request:

```bash
pi --list-models factory
```

When replacing an existing installation, preserve machine-local credential state. Never copy, overwrite, or share Pi auth storage, `~/.factory/`, or the Factory API-key file. Caches and `node_modules` are not portable installation artifacts.

## Authentication

Run:

```text
/login factory
```

Pi's single Factory login entry offers **Use a subscription** or **Use an API key**. Subscription login then offers:

1. Import the existing Droid CLI Factory account from `~/.factory`.
2. Factory browser/device account login.
3. Use the rotating API keys already configured in `<agent-dir>/factory/api-keys.json` through a non-secret selector.

Use Pi's native **Use an API key** option to enter and store one Factory API key directly.

Pi stores the selected authentication method under the single `factory` provider. Consequently `/logout` shows one Factory entry and removes whichever Factory credential is active. Switching authentication method means running `/login factory` again; the model catalog does not change.

Configured multi-key mode keeps fill-first rotation and cooldown behavior. Direct API-key and OAuth requests share the same transport/model catalog while applying the appropriate organization-header behavior automatically.

## Models

The extension loads one curated catalog from the installed Droid metadata and `factory/models.ts`. Examples:

- `factory/gpt-5.6-luna`
- `factory/gpt-5.6-sol`
- `factory/claude-sonnet-5`
- `factory/grok-4.6`
- `factory/deepseek-v4-flash-0731`
- `factory/deepseek-v4-pro`
- `factory/glm-5.2`
- `factory/kimi-k3`

There are no `-oauth` or `-api-key` model duplicates. The user-curated catalog excludes every `-fast` variant and the explicit removals documented in `factory/models.ts`. The current Gemini Pro, MiniMax M3, Nemotron 3 Ultra, and Inkling entries remain hidden; reconsider each family only after its vendor releases a newer generation/model.

## Operator status and usage limits

```text
/factory-status
/factory-limits
```

`/factory-status` reports catalog and authentication state. `/factory-limits` force-refreshes Factory's authoritative billing data on demand. With multiple credentials, it opens a scalable credential picker and shows separate Standard and Droid Core limits only for the selected entry. You can filter by label with `/factory-limits <label>`.

Usage is never estimated from Pi token counts: Factory's API already applies model multipliers and cache-hit discounts. Cached records refresh at most every 15 minutes during normal sessions and after Factory runs; the manual command is the explicit force-refresh path.

Configured rotating API keys remain separate. Each label gets its own Standard and Core record, and the extension never sums or averages them. Fresh cached exhaustion can skip only that credential during rotation. Monthly exhaustion suppresses weekly and 5-hour detail; weekly exhaustion suppresses 5-hour detail. Expired windows do not block a key.

## Required request behavior

Factory requests use:

- `X-Factory-Client: cli`
- `X-Client-Version: <detected Droid version>`
- `User-Agent: factory-cli/<version>`
- OAuth: bearer token plus active Factory organization
- API key: bearer API key without OAuth-only organization metadata

The transport also sanitizes the Factory-blocked Pi identity phrase before sending requests.

## Maintenance and validation

See `REFRESH_MODELS.md` and `UPDATING.md` for catalog/client updates. After updating Droid, refresh its cached metadata explicitly:

```bash
FACTORY_DROID_REFRESH=1 pi --list-models factory
```

Normal Pi startup and `/reload` do not invoke Droid. After extension changes, run `/reload`, then `/login factory` if no unified credential is stored.

From the repository root, run `npm run validate` to typecheck and test this extension with the complete suite.
