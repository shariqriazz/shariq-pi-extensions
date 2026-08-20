# Copy All

Copies a readable transcript of the active Pi conversation branch to the system clipboard.

## Command

`/copy-all` waits for the current agent run to settle, then copies visible user and assistant messages from the active branch. Messages are labeled `USER` and `ASSISTANT` and separated with a horizontal divider.

The exported transcript intentionally excludes system messages, tool calls, tool results, and hidden reasoning. Image blocks are represented as `[image]`. Empty branches produce an informational notification instead of changing the clipboard.

Clipboard access uses Pi's cross-platform clipboard helper. A clipboard failure is shown in the interface and does not alter the session.

## Validation

From the repository root, run `npm run validate`.
