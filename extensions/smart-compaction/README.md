# Smart Compaction Extension

A high-fidelity context continuity synthesizer for Pi sessions that replaces standard compaction with an advanced multi-phase checkpoint engine and deterministic state tracking.

## Overview

When long-running agent sessions reach context thresholds, standard compaction frequently suffers from:
- Information decay over repeated compactions ("the telephone game");
- Dropping active, uncommitted code snippets and subtle compiler diagnostics;
- Forgetting explicit user negative constraints ("never modify X");
- Output length truncation resulting in broken or partial summaries.

**Smart Compaction** resolves these issues through a 6-dimensional checkpoint architecture, fail-closed validation, deterministic file-ledger accumulation, and a multi-stage retry ladder:

1. **🎯 Primary Goal & Nuanced Intent** — Retains full user objectives, styling preferences, scope boundaries, and explicit negative constraints.
2. **📋 Progress Ledger** — Strict `[x] Done`, `[ ] In Progress`, and `[!] Blocked` tracking.
3. **🛠️ Code Changes & In-Progress Snippets** — Captures verbatim code snippets of active work and recent edits, supplemented by a bounded worktree patch so a successor can recover the current engineering state.
4. **💥 Errors, Root Causes & Fixes** — Full error traces, root cause diagnostics, and verified solutions.
5. **🧠 Key Decisions & Hypotheses** — Architectural choices, trade-offs, and discarded hypotheses.
6. **📍 Resume Anchor & Immediate Next Action** — Verbatim quote or exact resume state with the single immediate next action.
7. **📂 Deterministic Engineering Ledger** — Programmatic `<read-files>`, `<touched-files>`, `<uncommitted-dirty-files>`, and bounded `<uncommitted-diff>` blocks. Historical touch state, current NUL-delimited porcelain status, and redacted patch data are persisted in versioned compaction details; sensitive paths are omitted.

## Defensive Reliability & Multi-Stage Retry Ladder

- **Fail-Closed Validation**: Accepts only `stopReason === "stop"` and rejects tool calls, empty output, or summaries missing required section headers.
- **Retry Ladder**: If an attempt encounters output limits or transient reasoning timeouts:
  1. Primary configured model with requested reasoning.
  2. Primary model with reasoning off (unblocks reasoning/token caps).
  3. Session model with reasoning off.
  4. Graceful fallback to Pi's default compactor if all stages fail.
- **Two-Ended Head & Tail Truncation**: Preserves both the beginning (context) and end (stack traces, compiler errors, exit codes, test summaries) of tool results and command logs.
- **Secret-Safe Persistence**: Redacts credential-shaped values and omits sensitive tool paths, results, dirty files, and patches before durable compaction state is created.
- **Deterministic 10+ Cycle Stability**: Persists machine-readable touch, dirty-file, bounded-patch, and cycle ledgers in `CompactionEntry.details`; hierarchical delta merging keeps immutable constraints while condensing obsolete history.

## Model Selection

Smart Compaction uses the **active session model** by default (`model: "inherit"`, `thinkingLevel: "inherit"`), or can be routed to any dedicated model (e.g. `factory/gemini-3.7-flash`, `antigravity/gemini-2.5-flash`, `cursor/cursor-grok-4.5-fast`).

## Commands

- `/compaction-model` — Open interactive model picker to select the compaction model, or switch back to `inherit`.
- `/compaction-model <provider/model>` — Set a specific compaction model directly.
- `/smart-compaction` — View status and settings.
- `/smart-compaction enable | disable` — Toggle smart compaction on or off.

## Configuration

Settings are persisted in `~/.pi/agent/smart-compaction.json`:

```json
{
  "version": 1,
  "enabled": true,
  "model": "inherit",
  "thinkingLevel": "inherit",
  "maxSummaryTokens": 8192
}
```
