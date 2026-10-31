# Pi background terminals

Session-scoped background pseudo-terminals for Pi. The extension combines Codex-style PTY input and cursor reads with bounded capture, size-limited private logs, automatic completion delivery, process-group shutdown, and a live Pi control center.

## Model tools

- `start_terminal` — start a long-running or interactive command in a PTY.
- `read_terminal` — read retained or incremental output, with optional long polling.
- `write_terminal` — send input or control characters and collect the response.
- `list_terminals` — list running and settled terminals.
- `stop_terminal` — stop complete process groups with TERM-to-KILL escalation.

`read_terminal` and `list_terminals` are read-only and callable from codemode scripts, so a script can filter a long log down to what matters; the tools that start, write to, or stop processes use `model-only` exposure. Each output response carries a byte cursor; pass it to the next read or write to get only new output. The tools render as compact cards with expandable output, and running terminals appear in the shared **Active work** dock with elapsed time and the latest output line.

When a model-started terminal exits, its status and a bounded output tail are delivered as a custom message. An idle parent starts a new turn for it; a busy parent receives it, together with any other pending results, just before its run would settle, and the run continues with them. Hosts that treat Pi's `agent_settled` as "done", such as Paseo schedules, therefore never stop between a result and its follow-up turn. The message never appears as user-authored or follow-up input. A terminal stopped with `stop_terminal` or `/term stop`, or whose exit a `read_terminal` call already returned, sends no message, because the model has already seen how it ended; reading a terminal that is still running does not suppress its later result.

`start_terminal` with `hold: true` keeps the run open after the model's last turn until that terminal exits, then continues with its result, so scheduled runs finish the job before they end. Use it for finite jobs, never servers or watchers. The hold ends early when the user sends a message, which cancels every hold, or when the terminal is stopped with `/term stop`. Escape cannot end it sooner, because Pi gives extensions no abort signal at that point; the abort takes effect when the terminal exits.

## User interface

`/term`, `/term list`, and `/ps` open the fullscreen control center. `/term start <command>` starts the process and immediately returns to the editor; `/term stop <id> [id…]` stops exact processes. The control center provides:

- live counts and status;
- terminal list with a selected-session inspector;
- live output, elapsed time, dimensions, command, cwd, and full-log size;
- real PTY input: every printable key goes to the process;
- Ctrl+C delivery to the PTY;
- PgUp/PgDn scrolling;
- a two-press Ctrl+X process-stop guard in the detail view.

## Lifecycle and safety

- Maximum eight concurrent terminals and 32 tracked entries.
- Newest 2 MiB retained in memory per terminal.
- Raw output spills to a mode-`0600` file under a mode-`0700` temporary session directory, capped at 64 MiB per terminal.
- Under Node, spill backpressure pauses and resumes the PTY. Bun's terminal API has no pause, so the 64 MiB cap is the only bound there. Reaching the cap stops log growth while retaining the newest live-output tail.
- Pruning an old settled terminal deletes its spill file immediately; session shutdown removes the complete temporary directory.
- Output is sanitized before TUI or model rendering.
- Processes run in their own PTY process group and are stopped on session shutdown, replacement, or reload.
- Shutdown and stop operations are bounded and escalate from SIGTERM to SIGKILL. A stop finishes only when the whole process group is gone, including descendants that outlive the shell and ignore hangup.
- Completion delivery is keyed by terminal id, so each terminal produces at most one result message.
