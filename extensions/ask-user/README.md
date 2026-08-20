# Ask User

Presents one structured decision to the user when an unresolved choice materially blocks safe progress.

## Tool

`ask_user` accepts one question and two to five distinct options. Each option has a concise label and may include a short consequence or clarification. The interface also lets the user write a custom answer.

The tool is deliberately narrow: agents should first inspect available context and use a reversible low-risk default when that would not change scope or authority. It should not be used for discoverable answers, routine confirmation, or a choice the user already made.

## Interface behavior

- Available interactively in Pi's TUI as a centered decision overlay.
- Supports arrow keys, `j`/`k`, number keys, Enter, and a custom-answer editor.
- Escape or Ctrl+C dismisses the question without inventing an answer.
- In non-TUI modes, returns an unavailable result so the agent can ask plainly only if still blocked.
- Questions, labels, descriptions, and custom answers are bounded and sanitized before display.

## Validation

From the repository root, run `npm run validate`.
