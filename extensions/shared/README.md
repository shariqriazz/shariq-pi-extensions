# Shared extension helpers

Runtime helpers used by more than one extension. This directory is not an extension and has no entry in the package manifest.

## Modules

- `activity-dock.ts`: one bounded **Active work** widget that merges live rows from Task List, Background Terminals, and Subagents, ordered by urgency. Headless child sessions never touch it.
- `child-session.ts`: trust-aware resource loading for child sessions, the tool denylist for children, and bounded child shutdown.
- `context-utilization.ts`: context usage and capacity formatting.
- `model-picker.ts`: searchable model picker overlay.
- `settlement-delivery.ts`: one queue per Pi session for asynchronous results. While the parent runs, results wait privately; at the idle edge they are delivered as custom messages and the last one starts a single model turn. A sender can key a result and withdraw it before delivery when the model already saw it through a tool.
- `tool-call-timeout.ts`: cancellation-aware time limits for registered tools; an already-cancelled call never starts, and tools that wait for a person can be exempted.
- `tool-card.ts`: compact tool call and result cards with expandable output.
- `tui-dashboard.ts`: width-safe, sanitized drawing helpers for terminal dashboards.

Pi loads each extension entrypoint as its own module instance, so state that several extensions share (the dock and the settlement queue) lives on a process-wide `globalThis` registry rather than in module variables.

Keep behavior that only one extension uses inside that extension. Move code here only when several extensions share the same contract, and delete a module here once nothing imports it.
