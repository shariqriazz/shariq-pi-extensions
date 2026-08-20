# Pi background terminals

Session-scoped background pseudo-terminals for Pi. The extension combines Codex-style PTY input and cursor reads with bounded capture, private full logs, automatic completion delivery, process-group shutdown, and a live Pi control center.

## Model tools

- `start_terminal` — start a long-running or interactive command in a PTY.
- `read_terminal` — read retained or incremental output, with optional long polling.
- `write_terminal` — send input or control characters and collect the response.
- `list_terminals` — list running and settled terminals.
- `stop_terminal` — stop complete process groups with TERM-to-KILL escalation.

Each output response carries a byte cursor. Pass it to the next read/write operation to avoid repeating output. Long or uncertain commands should use `start_terminal` instead of a large blocking `bash` timeout. Completion wakes the parent automatically, so it can continue other work or end its turn rather than poll.

## User interface

`/term`, `/term list`, and `/ps` open the fullscreen control center. `/term start <command>` starts the process and immediately returns to the editor; `/term stop <id> [id…]` stops exact processes. The control center provides:

- live counts and status;
- terminal list with a selected-session inspector;
- live output, elapsed time, dimensions, command, cwd, and full-log size;
- real PTY input;
- Ctrl+C delivery to the PTY;
- scrolling and top/bottom navigation;
- two-press process-stop guard.

## Lifecycle and safety

- Maximum eight concurrent terminals and 32 tracked entries.
- Newest 2 MiB retained in memory per terminal.
- Complete raw output spills to a mode-`0600` file under a mode-`0700` temporary session directory.
- Output is sanitized before TUI or model rendering.
- Processes run in their own PTY process group and are stopped on session shutdown, replacement, or reload.
- Shutdown and stop operations are bounded and escalate from SIGTERM to SIGKILL.
- Completion delivery is keyed by terminal id to prevent duplicate follow-ups.

## Validation

From the repository root, run `npm run validate`.
