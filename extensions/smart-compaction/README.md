# Smart Compaction

Replaces Pi's default compaction summary with a structured checkpoint and a deterministic record of file and worktree state, so a long session can continue after compaction without losing goals, constraints, or in-flight edits.

## What a checkpoint contains

The summarizer must return six numbered sections:

1. Primary goal and nuanced intent, including user constraints and negative rules.
2. Progress ledger: done, in progress (with batch counts), and blocked. Done items are closed history the next turn must not redo.
3. Code changes, with short snippets of the key changed lines of uncommitted work.
4. Errors, root causes, and fixes.
5. Key decisions and hypotheses.
6. Resume anchor and the single next action.

The summarizer aims for about 1,500 words. On a later compaction the previous checkpoint is merged with the new turns at about its previous length, condensing the oldest finished work first. Only its model-written sections are sent back; the computed sections below are regenerated each time.

After the model's text, the extension appends sections it computes itself:

- files read and files written or edited, accumulated across compactions in recency order and capped at the 40 most recently read and 60 most recently changed;
- uncommitted files from `git status`, with lockfiles, minified bundles, and build output listed separately and kept out of the diff;
- running background terminals, so the next turn does not start a duplicate server;
- background subagents that have not reported back, with a note not to poll, relaunch, or duplicate them;
- a bounded uncommitted diff (16,000 characters, shared across files) with previews of untracked files, or a marker when worktree state is unavailable.

## Validation and retries

A summary is accepted only when the model stopped normally, made no tool calls, and returned all six sections. Commit SHAs, UUIDs, URLs, and IPv4 addresses found in user messages and the previous checkpoint are protected facts; a summary that drops one is rejected. When the only defect is dropped identifiers, they are appended verbatim under a "Retained Identifiers" heading instead of failing.

Each attempt has a 10-minute timeout. The attempts are:

1. the configured model with the configured thinking level, first with the structured tail described below when it applies, then with the text transcript;
2. the same model with thinking off;
3. the session model with thinking off, when it differs.

Authentication, permission, quota, and cancellation errors stop the ladder immediately. If every attempt fails, compaction is cancelled and the full conversation is kept; the extension does not fall back to Pi's default summarizer.

The conversation is serialized for the summarizer with head and tail excerpts of long tool output, more room for failures and edits than for routine reads, bounded write and edit arguments, readable thinking cut to its first and last 2,000 characters in the 14 newest messages and 1,000 in older ones, and terminal control sequences and repeated lines removed. Session history itself is never modified.

When the summarizer is the same provider, API, and model that wrote the summarized turns, and thinking is on, the first attempt sends the newest of those turns as the original messages instead, with their thinking blocks and encrypted reasoning, so the model reads its own reasoning while it writes the checkpoint. Older turns stay in the text transcript. The structured part holds whole turns, newest first, up to 2.5 MB, and the whole request is kept under an estimated 3.5 MB, below gateway body limits of about 4.5 MB. Tools those turns called are declared with tool calls disabled. Turns written by a different model than the summarizer (including a configured compaction model that differs from the session model), the later attempts, and a rejected structured request all use the text transcript.

Each compaction entry records its source, serialized, and summary sizes, attempt count, duration, and, when the structured tail was used, its message count and size in `details`.

## Threshold

Pi's own reserve-token threshold still applies. Smart Compaction adds an upper bound, checked before each provider request:

- `percent`: a percentage of the model's context window;
- `hard`: an absolute token count;
- `hybrid` (default): whichever comes first of 95% and 400,000 tokens.

When the bound is reached, the extension starts compaction and then sends "Continue." as a follow-up so the run resumes. Manual `/compact` input is routed through the same compaction path.

## Commands

- `/compaction-model`: pick the compaction model, or `inherit` to use the session model.
- `/compaction-model <provider/model>`: set it directly.
- `/smart-compaction`: show status and settings.
- `/smart-compaction enable | disable`
- `/smart-compaction threshold percent | hard | hybrid`
- `/smart-compaction percent <1-100>`
- `/smart-compaction hard-limit <tokens>`

## Configuration

Settings live in `<agent-dir>/smart-compaction.json`:

```json
{
  "version": 1,
  "enabled": true,
  "model": "inherit",
  "thinkingLevel": "inherit",
  "thresholdMode": "hybrid",
  "thresholdPercent": 95,
  "hardLimitTokens": 400000
}
```

`maxSummaryTokens` is optional. Without it, the summary may use the model's full output limit.