# pi-memory

Pi-native durable memory built only from work performed inside Pi.

## Boundaries

- Captures Pi session messages, project identity, compaction summaries, explicit memory edits, and only an allowlist of Pi-native coding/terminal/subagent tool events.
- Does not ingest web/browser/search, screenshot/OCR, screen, audio, camera, application-observation, Chronicle, Skysight, or passive computer-recording tool events.
- Uses SQLite as the source of truth. The two generated `MEMORY.md` surfaces are read-only projections for people:
  - `<agent-dir>/pi-memory/global/MEMORY.md`
  - `<agent-dir>/pi-memory/projects/<project-id>/MEMORY.md`
- Runs only in TUI/RPC sessions, so headless children and print/JSON jobs do not create memory.
- Persists its extraction provider, model, and reasoning in `<agent-dir>/pi-memory/config.json`; `/memory-model` changes all three. The initial default is `openai-codex/gpt-5.6-luna` at `max` reasoning.

## Architecture

- `src/database.ts` — schema, FTS5 search, ranking, leases, retries, provenance, and lifecycle.
- `src/session.ts` — branch-aware Pi session capture with bounded tool output.
- `src/extraction.ts` — no-tool structured extraction through Pi's model registry.
- `src/retrieval.ts` — scoped retrieval and token-bounded prompt injection.
- `src/projection.ts` — generated global/project Markdown views.
- `src/service.ts` — lifecycle and queue ownership.

The completed bootstrap import is detached from its former sources. Imported knowledge is owned by Pi Memory as `bootstrap-import` provenance with Pi-local opaque identifiers. Runtime code never scans or reads another agent's memory directories.

## Commands

- `/memory-status`
- `/memory-model` (interactive provider → model → reasoning selector)
- `/memory-model <provider>/<model> <reasoning>`
- `/memory-search <query>`
- `/memory-review [query]`
- `/memory-save [global|project] <text>`
- `/memory-correct <id> <replacement text>`
- `/memory-forget <id>`
- `/memory-rebuild`
- `/memory-process`

## Tools

- `pi_memory_search`
- `pi_memory_read`
- `pi_memory_save`
- `pi_memory_correct`
- `pi_memory_forget`
- `pi_memory_status`

## Validation

```bash
npm run check
npm test
```
