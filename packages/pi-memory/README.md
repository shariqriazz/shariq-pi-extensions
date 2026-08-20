# Pi Memory

Optional persistent memory for Pi. It is intentionally shipped as a separate package so the main extension suite never enables memory implicitly.

## Install or enable

```bash
pi install npm:@shariqriazz/pi-memory
```

Reload Pi after installation:

```text
/reload
```

## Disable

```bash
pi remove npm:@shariqriazz/pi-memory
```

Then run `/reload`. Removing the package stops memory capture but does not delete its database. Runtime data stays under Pi's agent directory in `pi-memory/`, independent of the package checkout.

If an existing database was archived elsewhere while memory was disabled, restore that directory to `<agent-dir>/pi-memory` before reinstalling. Keep the directory mode `0700` and database/config files `0600`.

## Data and configuration

The extension stores its SQLite database, projections, and model selection under the active Pi agent directory. It uses Pi's `getAgentDir()` API instead of assuming a specific home directory or operating system layout.

See [`extensions/pi-memory/README.md`](extensions/pi-memory/README.md) for tools, extraction behavior, and recovery details.
