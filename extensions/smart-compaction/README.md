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

Each attempt has a 10-minute timeout. The first is the cached conversation described below, when it applies. The others are:

1. the configured model with the configured thinking level, first with the structured tail described below when it applies, then with the text transcript;
2. the same model with thinking off;
3. the session model with thinking off, when it differs.

Authentication, permission, quota, and cancellation errors stop the ladder immediately. If every attempt fails, compaction is cancelled and the full conversation is kept; the extension does not fall back to Pi's default summarizer.

The conversation is serialized for the summarizer with head and tail excerpts of long tool output, more room for failures and edits than for routine reads, bounded write and edit arguments, readable thinking cut to its first and last 2,000 characters in the 14 newest messages and 1,000 in older ones, and terminal control sequences and repeated lines removed. An entry repeated exactly (the same tool call, the same tool result, a resent prompt) appears once, with the number of copies and the time of the last one. Session history itself is never modified.

When the transcript does not fit one summarizer request, it is summarized in stretches of whole messages, oldest first, and each stretch is folded into the running checkpoint; every message is still summarized. A stretch holds at most an estimated 3.5 MB including the prompt, and no more than the summarizer's context window allows after its output allowance, counting three bytes per token. Each stretch goes through the attempts above and is checked for its own protected facts; the last stretch must carry all of them. If any stretch fails every attempt, compaction is cancelled.

### Cached conversation

The first attempt sends the live conversation again exactly as the last request sent it (system prompt, tools, and every message in full) and asks for the checkpoint as the next turn. The provider reads almost all of it from its prompt cache, and the summarizer sees full tool output, reasoning, and images instead of excerpts. The instruction quotes the start of the first kept message, and the checkpoint covers only what came before it.

It applies when the last request was the session model's own, under five minutes ago, the summarizer is that model, the conversation has only grown since, the compaction is not for a context overflow, and the conversation is under `maxRequestBytes`. Before anything is sent, the rebuilt request must repeat the last one field for field and message for message up to its new part. When any condition fails, or the checkpoint fails validation, the attempts above run as before. `details.cachedRequest` records whether the cached conversation was used, its cache-read and other input tokens, or why it was not.

### Structured tail

When the summarizer is the same provider, API, and model that wrote the summarized turns, and thinking is on, the first attempt sends the newest of those turns as the original messages instead, with their thinking blocks and encrypted reasoning, so the model reads its own reasoning while it writes the checkpoint. Older turns stay in the text transcript. The structured part holds whole turns, newest first, up to 2.5 MB, and the whole request is kept under an estimated 3.5 MB, below gateway body limits of about 4.5 MB. Tools those turns called are declared with tool calls disabled. Turns written by a different model than the summarizer (including a configured compaction model that differs from the session model), the later attempts, and a rejected structured request all use the text transcript.

Only the last stretch may use the structured tail. Each compaction entry records its source, serialized, and summary sizes, attempt count, duration, the number of stretches, collapsed repeats, and messages summarized to fit the byte ceiling when there were any, and, when the structured tail was used, its message count and size in `details`.

## Threshold

Pi's own reserve-token threshold still applies. Smart Compaction adds an upper bound, checked before each provider request:

- `percent`: a percentage of the model's context window;
- `hard`: an absolute token count;
- `hybrid` (default): whichever comes first of 95% and 400,000 tokens.

The size checked is the larger of the usage the provider last reported and Pi's local estimate of the messages about to be sent, so usage a provider misreports cannot hide growth. The optional `maxRequestBytes` also starts compaction when the serialized messages reach that many bytes, for gateways whose body limit is hit before the token bound, for example by encrypted reasoning.

With `maxRequestBytes` set, the messages kept after compaction must fit in half of it. Pi keeps recent messages by estimated tokens, and an image counts for about 1,200 there however many bytes it holds, so when the kept messages are larger, the cut moves to a later message (never a tool result) and the messages passed over are summarized too.

If a request is still over the limit right after a compaction, or Pi had nothing to summarize, compacting again cannot help, so the extension warns once and does not compact again until the context is back under the limit or Pi's estimate has grown by 20,000 tokens. When Pi had nothing to summarize, the interrupted run resumes. While the context stays over `maxRequestBytes`, each request leaves out its oldest images, replaced by a short note, until it fits; the session keeps them.

When the bound is reached, the extension starts compaction and then sends "Continue." as a follow-up so the run resumes. Manual `/compact` input is routed through the same compaction path.

## Commands

- `/compaction-model`: pick the compaction model, or `inherit` to use the session model.
- `/compaction-model <provider/model>`: set it directly.
- `/smart-compaction`: show status and settings.
- `/smart-compaction enable | disable`
- `/smart-compaction threshold percent | hard | hybrid`
- `/smart-compaction percent <1-100>`
- `/smart-compaction hard-limit <tokens>`
- `/smart-compaction max-bytes <bytes|off>`

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

`maxSummaryTokens` is optional. Without it, the summary may use the model's full output limit. `maxRequestBytes` is optional and off by default.