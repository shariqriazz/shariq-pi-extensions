# Pi Context Usage

Displays a startup `[Context Usage]` panel showing the estimated context-window cost of Pi's runtime system prompt, AGENTS.md files, skill index, active tool schemas, and session material.

## Use

- `Ctrl+O` cycles summary, compact, and expanded views.
- `/context-usage` cycles views.
- `/context-usage summary|compact|expanded` selects a view directly.
- `/reload` activates source changes in an existing Pi session.

Numbers prefixed with `~` are model-aware estimates. `Total request` uses Pi's own context count.

## Configuration

Optional JSON configuration is loaded from `pi-context-usage.json` in Pi's global or trusted project configuration directories. `PI_CONTEXT_USAGE_CONFIG` can provide additional paths separated by the operating system's path delimiter.

## License

See `LICENSE`.
