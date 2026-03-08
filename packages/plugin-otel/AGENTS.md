# AGENTS.md -- opencode-otel

## Package overview

`@gfxlabs/opencode-plugins-otel` is an OpenTelemetry usage-tracking plugin for the
opencode-ai platform. It captures session lifecycle, message flow, tool execution,
and cost metrics as OTLP/HTTP JSON log records and ships them to any OTel-compatible
collector.

- **Source files:** `src/index.ts`, `src/config.ts`, `src/handlers.ts`, `src/otel.ts`, `src/git.ts`
- **Single export:** `OtelPlugin` (type: `Plugin` from `@opencode-ai/plugin`)
- **Build:** `pkgroll` producing ESM-only output (`dist/index.mjs` + `dist/index.d.mts`)
- **No runtime dependencies** -- only a peer dep on `@opencode-ai/plugin >=1.0.0`

## Architecture

The plugin is structured as a single async factory function (`OtelPlugin`) that:

1. Loads and merges config from two JSON files (project + global)
2. Resolves env var overrides (`OPENCODE_OTEL_ENABLED`, `OPENCODE_OTEL_ENDPOINT`, `OPENCODE_OTEL_HEADERS`)
3. Detects git repo info (remote URL, branch, commit SHA) by reading `.git` files
4. Builds OTLP resource attributes (including git info when available)
5. Returns two hooks: `event` and `tool.execute.after`

### Key internal components

| Component | Lines (approx) | Purpose |
|---|---|---|
| `OtelConfig` interface + `parseConfig` / `loadConfig` | 1-100 | Config loading, validation, two-layer merge |
| `OtelLogRecord` / `OtelExportLogsRequest` interfaces | 20-50 | OTLP/HTTP JSON wire format types |
| `detectGitInfo` | ~80 | Reads `.git` directory to detect remote URL, branch, commit SHA (no subprocesses) |
| Helper functions (`attrs`, `makeLogRecord`, `buildExportRequest`, `str`, `bool`, `strRecord`, `lineCount`, `safeStringifyLength`) | 50-160 | Type-safe attribute construction, record building, size/line measurement |
| Buffer/flush/drain system (`enqueue`, `flush`, `drain`, `send`) | ~50 | Batched delivery: 100-record or 5-second flush, drain on terminal events |
| `getModelCosts` / `estimateCost` | ~40 | Lazy-loaded per-token cost rates from `client.provider.list()` |
| Event handler (`event` hook) | ~350 | Switch over 20 event types, emitting OTLP records |
| `tool.execute.after` hook | ~10 | Post-tool-execution telemetry |

### Event types handled

`session.created`, `session.updated`, `session.deleted`, `session.idle`,
`session.compacted`, `session.status`, `session.error`, `session.diff`,
`message.updated`, `message.removed`, `message.part.updated`, `message.part.removed`,
`command.executed`, `file.edited`, `permission.updated`, `permission.replied`,
`todo.updated`, `vcs.branch.updated`

Plus two synthetic events derived from message data:
- `user.prompt` -- emitted when a user text part is matched to its message (root sessions only, not subtask/subagent sessions)
- `api.request` -- emitted when an assistant message finishes, with cost/token summary

### Message part types handled

All part types from the SDK union are handled: `text`, `reasoning`, `tool`,
`step-start`, `step-finish`, `snapshot`, `subtask`, `agent`, `retry`,
`compaction`, `file`, `patch`.

### Size and line tracking

The plugin computes derived metrics for telemetry:
- `lineCount(text)` -- counts newlines in strings for text, reasoning, tool output, prompts
- `safeStringifyLength(value)` -- serialized JSON size of tool inputs/args
- Output sizes on completed tool parts and `tool.execute.after` hook
- Streaming delta lengths on `message.part.updated` events
- System prompt length and tools count on user messages
- Session summary stats (additions, deletions, files) on session events

### Batching and delivery

- Records are buffered in-memory (array splice pattern)
- Flush triggers: buffer reaches 100 records OR 5-second timer fires
- `drain()` is called on terminal events (`session.idle`, `session.deleted`, `session.error`)
  to await all in-flight `fetch` calls before the process exits
- Failed sends log via `client.app.log` but never throw

### Content policy

LLM-generated content is never sent. This includes assistant text, reasoning content,
tool error text, session/message error messages, and retry messages. These fields are
omitted entirely from telemetry records. Only structural metrics (length, line count)
are emitted for these fields.

**Exception: user prompt text.** The `user.prompt` event includes `prompt.content`,
which is the actual prompt text wrapped in `rt()`. At `"light"` and `"full"` redaction
levels it is `<REDACTED>`; at `"none"` it is sent as-is. This is the only LLM content
that can be sent. Only prompts from root sessions are emitted -- subtask/subagent
sessions (those with `session.parentID`) are excluded to avoid capturing
system-generated prompts as user input.

### Redaction levels

The `redact` config field accepts `"none"`, `"light"`, or `"full"` (default: `"full"`).
Boolean `true`/`false` is accepted for backwards compat (`true` -> `"full"`, `false` -> `"none"`).
Any unrecognized value falls back to `"full"`.

Two internal helpers implement the tiered redaction:
- `rt(value)` -- redacts at `"light"` and `"full"`. Used for titles, descriptions,
  VCS info, file names, and user prompt content (session titles, tool titles,
  subtask descriptions, permission titles, git branch/URL, file names, prompt content).
- `rs(value)` -- redacts at `"full"` only. Used for structural metadata
  (tool names, command arguments).

Numeric values, IDs, types, status codes, timestamps, token counts, and costs are
never redacted at any level.

**No filesystem paths are ever sent**, regardless of redaction level. The following
fields were removed: `project.worktree`, `session.directory`, `message.path.cwd`,
`message.path.root`, `file.path`, `file.source.path`.

### Cost estimation

If `msg.cost` is 0 or missing on a completed assistant message, the plugin falls back to
computing cost from per-token rates fetched once via `client.provider.list()` and cached
in a `Map<string, ModelCost>`.

## Config resolution order

1. Load `<project-dir>/.opencode/otel.json` (project-level)
2. Load `~/.config/opencode/otel.json` (global/user-level)
3. Merge: project values override global values per-key; headers are deep-merged
4. Env vars override merged config: `OPENCODE_OTEL_ENDPOINT`, `OPENCODE_OTEL_HEADERS`
5. `OPENCODE_OTEL_ENABLED=1` can enable the plugin even if config says `enabled: false`

## Build and typecheck

```bash
# Build this package only
npm run build -w packages/opencode-otel

# Typecheck the whole monorepo (includes this package via project references)
npm run typecheck

# Clean build artifacts
npm run clean -w packages/opencode-otel
```

## Documentation maintenance rule

**When changing the behavior of this plugin, you MUST update both documentation files
to reflect the new behavior:**

- `packages/opencode-otel/README.md` -- user-facing docs (config, events, usage)
- `packages/opencode-otel/AGENTS.md` -- this file (architecture, internals, agent context)

This applies to any change that affects:

- Config fields or config resolution logic
- Event types handled or attributes emitted
- Batching, flushing, or delivery behavior
- Redaction scope
- Cost estimation logic
- Hooks implemented or their signatures
- Environment variable support
- Resource attributes or scope metadata
- The exported API surface

Do not let implementation drift from documentation. Treat docs as part of the
implementation -- if the code changes, the docs change in the same commit.
When in doubt, update both files. A stale doc is worse than no doc.
