# Cursor provider

Registers Cursor-hosted Composer and Cursor Grok models in Pi through the official native `@cursor/sdk`. It does not use ACP, a Cursor CLI subprocess, prompt-encoded tool markers, or third-party model families.

## Authentication

Run:

```text
/login cursor
```

Choose either:

- **Cursor browser login:** Cursor signs in through the browser and mints a named 90-day user API key. Pi stores the key in its normal OAuth credential store; the Cursor SDK's own credential file is not used.
- **Existing Cursor user API key:** set a `crsr_…` key in `CURSOR_API_KEY`. Pi resolves it directly without creating duplicate models; `/login cursor` can validate the configured environment key and copy it into Pi auth storage. Non-expiring user keys remain valid until revoked.

Secrets are passed directly to the SDK and are never placed in command arguments, diagnostics, model metadata, or the repository.

## Provider behavior

- Refreshes Cursor's authenticated model catalog and caches only Composer and Cursor Grok metadata for the next extension reload.
- Exposes image input for every registered Cursor model.
- Maps Composer fast mode and Cursor Grok reasoning effort to native model parameters.
- Uses the SDK's local hosted-model runtime in an isolated temporary workspace with ambient Cursor settings disabled.
- Disables Cursor's built-in workspace tools and exposes Pi's active tools as native SDK custom tools. Tool execution remains owned by Pi.
- Streams native text and thinking deltas, structured tool calls, stop reasons, and Cursor-reported input/output/cache/reasoning usage.
- Propagates cancellation and timeouts, enables safe SDK transport retries, and maps common authentication, rate-limit, quota, capacity, timeout, and context failures to actionable Pi errors.
- Forwards base64 image payloads separately from the textual conversation transcript.
- Removes temporary workspace and SDK state after each request.

## Cursor dashboard

Run `/cursor` for a Cursor-specific account dashboard. It reads Cursor's current billing-period APIs and shows:

- account and plan
- monthly total usage
- purchased and bonus usage
- Cursor Auto/Composer and named/API percentages
- billing-cycle reset time
- on-demand availability and configured/recommended limits
- authenticated Cursor-owned model count

It intentionally does not display Factory's 5-hour, weekly, Standard, or Core buckets. Press `r` to refresh and Escape to close.

Use `/cursor.doctor` for sanitized provider, authentication, transport, and model diagnostics.

## Current protocol boundary

Cursor documents the SDK as an agent API rather than a raw chat-completions API. Pi sends its full current conversation to a native SDK run. When Cursor selects a Pi custom tool, the run is cancelled after the structured invocation is captured; Pi executes the tool and the next native run receives the resulting conversation state. Cursor never receives direct filesystem or shell authority from this provider.
