# Pi Memory

Optional persistent memory for Pi. It is deliberately absent from the root package manifest so installing the default extension suite never enables memory implicitly.

## Enable from a trusted clone

```bash
pi install <repo>/packages/pi-memory
```

Run `/reload` after installation.

## Disable

Remove the same local package source through `pi remove` or `pi config`, then run `/reload`. Removing the package stops memory capture but does not delete its database. Runtime data remains under `<agent-dir>/pi-memory`, independent of the Git checkout.

If an existing database was archived elsewhere while memory was disabled, restore that directory to `<agent-dir>/pi-memory` before enabling the package. Keep the directory mode `0700` and database/config files `0600`.

## Data and configuration

The extension stores its SQLite database, projections, and model selection under the active Pi agent directory. It uses Pi's `getAgentDir()` API instead of assuming a particular home directory or operating-system layout.

See [`extensions/pi-memory/README.md`](extensions/pi-memory/README.md) for tools, extraction behavior, and recovery details.
