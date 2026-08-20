# Factory authentication

Provider ID: `factory`

Use one login entry for every authentication method:

```text
/login factory
```

Choose Pi's **Use a subscription** path for account import, browser/device login, or the configured rotating-key selector. Choose Pi's native **Use an API key** path to enter one key directly. The chosen credential is stored under `factory`, so it appears once in `/logout`.

OAuth account credentials refresh through WorkOS. Configured API-key mode stores only a non-secret selector in Pi auth; actual keys remain in the permission-restricted `factory-api-keys.json`. Direct API-key mode stores the key through Pi's normal credential storage.

To switch methods, run `/login factory` again. To disable the selected method, use `/logout` and choose Factory.
