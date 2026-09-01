# Smart Compaction Extension

A high-fidelity context continuity synthesizer for Pi sessions that replaces standard compaction with an advanced multi-phase checkpoint engine and deterministic state tracking.

## Overview

When long-running agent sessions reach context thresholds, standard compaction frequently suffers from:
- Information decay over repeated compactions ("the telephone game");
- Dropping active, uncommitted code snippets and subtle compiler diagnostics;
- Forgetting explicit user negative constraints ("never modify X");
- Output length truncation resulting in broken or partial summaries.

**Smart Compaction** resolves these issues through a 6-dimensional checkpoint architecture, fail-closed validation, deterministic file-ledger accumulation, and a multi-stage retry ladder:

1. **🎯 Primary Goal & Nuanced Intent** — Retains full user objectives, styling preferences, scope boundaries, explicit negative constraints, and full opaque identifiers (full 40-char commit SHAs, UUIDs, hostnames, IPs, ports, URLs).
2. **📋 Progress Ledger** — Strict `[x] Done`, `[ ] In Progress` (including exact batch counts `Batch: X/Y completed`), and `[!] Blocked` tracking. Items under `Done` are marked as closed historical milestones that must not be re-executed.
3. **🛠️ Code Changes & In-Progress Snippets** — Captures verbatim code snippets of active work and recent edits, supplemented by a bounded worktree patch so a successor can recover the current engineering state.
4. **💥 Errors, Root Causes & Fixes** — Full error traces, root cause diagnostics, and verified solutions.
5. **🧠 Key Decisions & Hypotheses** — Architectural choices, trade-offs, and discarded hypotheses.
6. **📍 Resume Anchor & Immediate Next Action** — Verbatim quote or exact resume state with the single immediate next action.
7. **📂 Deterministic Engineering Ledger** — Programmatic `<read-files>`, `<touched-files>`, `<uncommitted-dirty-files>`, `<modified-lockfiles-and-assets>`, `<active-background-processes>`, and bounded `<uncommitted-diff>` blocks. Lockfiles and minified bundles are automatically excluded from raw diffing to preserve token budgets for real source code, while active background terminals/daemons are recorded to prevent port conflicts.

## Defensive Reliability & Multi-Stage Retry Ladder

- **Fail-Closed Validation**: Accepts only `stopReason === "stop"` and rejects tool calls, empty output, or summaries missing required section headers.
- **Lockfile & Bundle Diff Exclusion**: Automatically excludes `package-lock.json`, `Cargo.lock`, `yarn.lock`, `pnpm-lock.yaml`, and minified assets from raw diffs, recording their status under `<modified-lockfiles-and-assets>` to preserve 100% of diff token headroom for source code.
- **Background Daemon & Terminal Awareness**: Automatically detects running background terminals/processes and injects their status into `<active-background-processes>` so the successor agent never launches duplicate services.
- **Retry Ladder & Extended Prefill Timeout**: Compaction requests receive an extended 10-minute timeout (600,000ms) to accommodate large 1M context prefills. If an attempt encounters output limits or transient reasoning timeouts:
  1. Primary configured model with requested reasoning.
  2. Primary model with reasoning off (unblocks reasoning/token caps).
  3. Session model with reasoning off.
  4. Strict Fail-Closed Protection: If all stages fail, compaction is cancelled to preserve 100% of the conversation transcript rather than silently degrading to Pi's generic compactor.
- **Bounded High-Fidelity Preservation**: Preserves user-provided constraints, identifiers, tool inputs, and code evidence within explicit serializer and patch budgets; protected facts are validated before a checkpoint is accepted.
- **Tool-Aware Head & Tail Truncation**: Records tool identity and success/error state, gives failures and mutations more space than routine reads/searches, bounds large write/edit arguments, and preserves both the beginning and end of useful output.
- **Terminal Noise Cleanup**: Removes ANSI/OSC control sequences, carriage-return progress rewrites, and consecutive duplicate lines from the one-off summarizer input without mutating session history or its prompt-cache prefix.
- **Selectable Threshold Policy**: Supports percentage, hard-token, or hybrid thresholds; the default hybrid policy compacts at the earlier of 95% or 400,000 tokens without changing model catalogue context windows.
- **Compaction Telemetry**: Stores source/serialized/summary character counts, attempt count, and elapsed time in `CompactionEntry.details`.

## Model Selection

Smart Compaction uses the **active session model** by default (`model: "inherit"`, `thinkingLevel: "inherit"`), or can be routed to any dedicated model (e.g. `factory/gemini-3.7-flash`, `antigravity/gemini-2.5-flash`, `cursor/cursor-grok-4.5-fast`).

## Commands

- `/compaction-model` — Open interactive model picker to select the compaction model, or switch back to `inherit`.
- `/compaction-model <provider/model>` — Set a specific compaction model directly.
- `/smart-compaction threshold percent | hard | hybrid` — Choose the optional threshold policy.
- `/smart-compaction percent <1-100>` — Set the percentage threshold.
- `/smart-compaction hard-limit <tokens>` — Set the absolute token ceiling.
- `/smart-compaction` — View current status and settings.
- `/smart-compaction enable | disable` — Toggle smart compaction on or off.

## Configuration

Settings are persisted in `~/.pi/agent/smart-compaction.json`:

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
*Threshold behavior:* `percent` uses the configured percentage of the active model's declared context window, `hard` uses the absolute token limit, and `hybrid` uses whichever limit is reached first. The extension checks this safeguard immediately before a provider request, when completed tool results are present. Pi's native reserve-token compaction can still run earlier. Threshold-triggered extension compaction uses Pi's manual compaction API and automatically resumes with a follow-up because Pi does not currently expose model-aware native threshold configuration to extensions.

*Summary output behavior:* `maxSummaryTokens` defaults to `undefined`, allowing the summarizer model to use its native output capacity. The generated checkpoint remains subject to validation and the selected model's limits.
