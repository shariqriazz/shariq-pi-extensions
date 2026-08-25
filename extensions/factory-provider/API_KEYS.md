# Factory API keys

Factory API keys are an authentication method of the single `factory` provider; they are not a separate provider or duplicate model catalog.

Configure rotating keys in:

```text
<agent-dir>/factory/api-keys.json
```

Then run `/login factory` and select **Factory API keys — use configured keys**. Pi stores a non-secret selector while the extension keeps keys in the permission-restricted JSON file. Rotation filters keys through the selected model pool's monthly → weekly → 5-hour availability waterfall, chooses the least recently used eligible key, and applies error-specific cooldown/failover behavior.

Alternatively choose Pi's top-level **Use an API key** authentication method to store one key through normal credential storage.

Use `/logout` to remove the active Factory authentication selection. The configured key file is intentionally not deleted by logout.

Open `/factory` to inspect every account, its Standard/Core usage, and rotation status. File-backed keys remain visible when disabled: select one and press `d` to enable/disable it, or press `x` and confirm to remove it permanently from `api-keys.json`. Environment-provided keys are read-only. For a smoke test, use the current `factory/kimi-k3` model.
