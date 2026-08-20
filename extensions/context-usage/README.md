# Pi Context Usage

Displays a compact startup context-budget card showing total request/harness usage and the system, AGENTS.md, skill-index, and active-tool contributions. Detailed audit views expose session material and per-resource estimates.

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
