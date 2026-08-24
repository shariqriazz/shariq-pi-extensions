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
3. **🛠️ Code Changes & In-Progress Snippets** — Captures verbatim code snippets of active work and recent edits so a successor agent resumes without re-reading or guessing.
4. **💥 Errors, Root Causes & Fixes** — Full error traces, root cause diagnostics, and verified solutions.
5. **🧠 Key Decisions & Hypotheses** — Architectural choices, trade-offs, and discarded hypotheses.
6. **📍 Resume Anchor & Immediate Next Action** — Verbatim quote or exact resume state with the single immediate next action.
7. **📂 Deterministic File Ledger** — Programmatic `<read-files>` and `<modified-files>` XML blocks merged deterministically across cycles in `details.readFiles` and `details.modifiedFiles`.

## Defensive Reliability & Multi-Stage Retry Ladder

- **Fail-Closed Validation**: Rejects `stopReason === "length"`, `stopReason === "error"`, accidental tool calls, or partial summaries missing required section headers.
- **Retry Ladder**: If an attempt encounters output limits or transient reasoning timeouts:
  1. Primary configured model with requested reasoning.
  2. Primary model with reasoning off (unblocks reasoning/token caps).
  3. Session model with reasoning off.
  4. Graceful fallback to Pi's default compactor if all stages fail.
- **Two-Ended Head & Tail Truncation**: Preserves both the beginning (context) and end (stack traces, compiler errors, exit codes, test summaries) of tool results and command logs.
- **Deterministic 10+ Cycle Stability**: Persists machine-readable file and cycle ledgers in `CompactionEntry.details` so file states survive indefinitely across successive compactions.

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
