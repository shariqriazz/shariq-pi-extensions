# Shared Extension Helpers

Internal runtime utilities used by more than one extension. This directory is not a Pi extension and has no `index.ts` entrypoint in the package manifest.

## Modules

- `activity-status.ts` formats compact running/completed/failed status counts.
- `child-session.ts` owns trust-aware child resources and bounded session shutdown.
- `context-utilization.ts` formats model-context usage and capacity.
- `dashboard-state.ts` keeps list selection stable as live rows change.
- `settlement-delivery.ts` immediately hands asynchronous results to Pi as turn-triggering follow-ups.
- `tool-call-timeout.ts` applies cancellation-aware execution limits to registered tools.
- `tui-dashboard.ts` provides bounded, sanitized terminal-dashboard rendering helpers.

Keep extension-specific behavior in its owning `extensions/<name>` directory. Move code here only when multiple extensions genuinely share the same runtime contract.

## Validation

From the repository root, run `npm run validate`.
