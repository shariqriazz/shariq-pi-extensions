# Pi ContextScope

Displays a startup `[ContextScope]` panel showing the estimated context-window cost of Pi's runtime system prompt, AGENTS.md files, skill index, active tool schemas, and session material.

## Use

- `Ctrl+O` cycles summary, compact, and expanded views.
- `/contextscope` cycles views.
- `/contextscope summary|compact|expanded` selects a view directly.
- `/reload` activates source changes in an existing Pi session.

Numbers prefixed with `~` are model-aware estimates. `Total request` uses Pi's own context count.

## Configuration

Optional JSON configuration is loaded from `pi-contextscope.json` through the same global/project config lookup used by the original extension. `PI_CONTEXTSCOPE_CONFIG` can provide additional path-delimited config files.

## Provenance

This extension is derived from `pi-contextimate` in `pine-of-glass` 0.8.1 by Thomas Mustier. It vendors only the required extension code and helpers, with imports adapted and the user-facing name changed for independent package loading. See `LICENSE`.
