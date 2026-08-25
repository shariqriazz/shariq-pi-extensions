# Shared Extension Helpers

Internal runtime utilities used by more than one extension. This directory is not a Pi extension and has no `index.ts` entrypoint in the package manifest.

## Modules

- `activity-dock.ts` aggregates bounded urgency-ordered live rows from Task List, Background Terminals, Subagents, and Orchestration into one automatic widget.
- `activity-status.ts` formats compact running/completed/failed status counts.
- `child-session.ts` owns trust-aware child resources and bounded session shutdown.
- `context-utilization.ts` formats model-context usage and capacity.
- `dashboard-state.ts` keeps list selection stable as live rows change.
- `settlement-delivery.ts` coordinates asynchronous output in a private package-wide queue and starts one custom-result turn at Pi's safe idle edge, guaranteeing model-visible context without user-authored or follow-up rendering.
- `tool-call-timeout.ts` applies cancellation-aware execution limits to registered tools.
- `tool-card.ts` provides compact lifecycle call/result cards with expandable tool output.
- `tui-dashboard.ts` provides bounded, sanitized terminal-dashboard rendering helpers.

Keep extension-specific behavior in its owning `extensions/<name>` directory. Move code here only when multiple extensions genuinely share the same runtime contract.

## Validation

From the repository root, run `npm run validate`.
