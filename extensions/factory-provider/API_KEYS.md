# Factory API keys

Factory API keys are an authentication method of the single `factory` provider; they are not a separate provider or duplicate model catalog.

Configure rotating keys in:

```text
<agent-dir>/factory/api-keys.json
```

Then run `/login factory` and select **Factory API keys — use configured keys**. Pi stores a non-secret selector while the extension keeps keys in the permission-restricted JSON file and applies fill-first rotation/cooldowns.

Alternatively choose Pi's top-level **Use an API key** authentication method to store one key through normal credential storage.

Use `/logout` to remove the active Factory authentication selection. The configured key file is intentionally not deleted by logout.

Check status with `/factory-status`. For a smoke test, use the current `factory/kimi-k3` model.
