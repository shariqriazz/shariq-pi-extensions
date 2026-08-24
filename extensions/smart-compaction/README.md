# Smart Compaction Extension

A high-fidelity context continuity synthesizer for Pi sessions that replaces standard compaction with an advanced multi-phase checkpoint engine.

## Overview

When a coding agent session reaches context limits, standard compaction often degrades in subtle code nuances, drops uncommitted code snippets, or suffers from "telephone game" information loss across successive compactions.

**Smart Compaction** solves this by generating structured, high-density checkpoint summaries organized into 6 vital engineering dimensions:

1. **🎯 Primary Goal & Nuanced Intent** — Retains full user objectives, styling preferences, scope boundaries, and explicit negative constraints.
2. **📋 Progress Ledger** — Strict `[x] Done`, `[ ] In Progress`, and `[!] Blocked` tracking.
3. **🛠️ Code Changes & In-Progress Snippets** — Captures verbatim code snippets of active work and recent edits so a successor agent resumes without re-reading or guessing.
4. **💥 Errors, Root Causes & Fixes** — Full error traces, root cause diagnostics, and verified solutions.
5. **🧠 Key Decisions & Hypotheses** — Architectural choices, trade-offs, and discarded hypotheses.
6. **📍 Resume Anchor & Immediate Next Action** — Verbatim quote or exact resume state with the single immediate next action.
7. **📂 Programmatic File Operations** — Append deterministic `<read-files>` and `<modified-files>` XML blocks extracted from tool calls.

## Incremental Delta-Merging

When multiple compactions occur in a single long-running session, Smart Compaction utilizes a **Delta-Merge** pipeline that carries forward historical foundations while accumulating new progress, code modifications, and error solutions—eliminating context bleed over 5+ compaction cycles.

## Model Selection

Smart Compaction can use the **active session model** (default: `inherit`) or any dedicated fast/cost-effective model (e.g. `factory/gemini-3.7-flash`, `antigravity/gemini-2.5-flash`, `cursor/cursor-grok-4.5-fast`).

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
  "thinkingLevel": "inherit"
}
```

- `model`: `"inherit"` (uses current active session model) or explicit `"provider/model-id"`.
- `thinkingLevel`: `"inherit"` (uses current session's thinking level) or `"off" | "low" | "medium" | "high" | "max"`.
- `maxSummaryTokens`: optional override integer; if omitted, dynamically defaults to the model's full native output capacity (65,536–128,000+ tokens) so summaries are never artificially truncated.
