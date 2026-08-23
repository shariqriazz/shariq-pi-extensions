# Input mode

Controls what ordinary **Enter** does when the interactive Pi agent is already running:

- `steer` (default) queues the message before the agent's next model step.
- `interrupt` signals Pi's active abort controller immediately, retains the submitted text and images, then starts a fresh turn at Pi's safe `agent_settled` boundary. Multiple inputs received during cancellation are preserved in order in that replacement turn.
- `follow-up` queues the message until the active run finishes.

Use `/input-mode` for the picker or `/input-mode steer|interrupt|follow-up` for direct selection. The global choice is stored with restrictive permissions in `<agent-dir>/input-mode.json`; non-default modes appear in Pi's status area.

Pi does not expose an extension API for adding rows to its built-in `/settings` selector, so this extension owns a dedicated settings command rather than patching private TUI internals. The existing core **Steering mode** and **Follow-up mode** settings remain batching controls (`all` versus `one-at-a-time`).

Explicit Alt+Enter follow-ups, extension-originated messages, commands, idle input, compaction input, and RPC input retain Pi's native behavior. Interrupt cancellation is cooperative: Pi stops model streaming and abort-aware tools, but it cannot undo an external side effect that already completed or force a third-party operation that ignores its abort signal to stop.
