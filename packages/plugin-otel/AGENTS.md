# AGENTS.md -- opencode-otel

## Package overview

`@gfxlabs/opencode-plugins-otel` is an OpenTelemetry usage-tracking plugin for the
opencode-ai platform. It captures session lifecycle, message flow, tool execution,
and cost metrics as OTLP/HTTP JSON log records and ships them to any OTel-compatible
collector.

- **Source files:** `src/index.ts`, `src/context.ts`, `src/events.ts`, `src/handlers.ts`, `src/config.ts`, `src/otel.ts`, `src/git.ts`
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

### File layout and import graph

```
index.ts        Entry point. Config loading, resource attrs, EmitContext construction, hook wiring.
context.ts      EmitContext class. Owns transport, buffering, tracking, dedup, redaction, cost state.
events.ts       21 typed builder functions (sessionCreated, textPart, apiRequest, etc.), OtelEvent union, flattenEvent().
handlers.ts     createHandlers() and DRAIN_EVENTS. Switches over event types, calls builders, delegates to EmitContext.
config.ts       OtelConfig, RedactLevel, parseConfig, loadConfig, CONFIG_FIELDS.
otel.ts         OTLP types, attrs(), makeLogRecord(), buildExportRequest(), lineCount(), safeStringifyLength().
git.ts          GitInfo, detectGitInfo(). Reads .git files directly, no subprocesses.
```

Import DAG (no cycles):
```
index → context, handlers, events, otel, config, git
handlers → context, events, otel
context → events, otel, config
events → otel
```

### Key internal components

| Component | File | Purpose |
|---|---|---|
| `OtelPlugin` factory | `index.ts` | Async plugin factory: loads config, builds resource attrs, constructs `EmitContext`, returns hooks |
| `EmitContext` class | `context.ts` | Central state holder: transport (URL, headers), buffer/flush/drain, session/message tracking, dedup sets, redaction helpers (`rt`/`rs`), cost estimation |
| Typed event builders | `events.ts` | 21 named functions (`sessionCreated()`, `apiRequest()`, `textPart()`, etc.) returning `OtelEvent` discriminated union members. `flattenEvent()` converts to `{ type, attrs }` |
| `createHandlers` | `handlers.ts` | Returns `{ event, toolExecuteAfter }` hooks. The event hook switches over ~20 event types and calls builders + `EmitContext.emit()` |
| `OtelConfig` + `loadConfig` | `config.ts` | Config loading, validation, two-layer merge (project + global) |
| OTLP wire types + helpers | `otel.ts` | `attrs()`, `makeLogRecord()`, `buildExportRequest()`, `lineCount()`, `safeStringifyLength()` |
| `detectGitInfo` | `git.ts` | Reads `.git` directory for remote URL, branch, commit SHA |

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

- Records are buffered in-memory (array splice pattern) inside `EmitContext`
- Flush triggers: buffer reaches 100 records OR 5-second timer fires
- `flush()` is also called at natural boundaries: after `user.prompt` emission,
  on `session.status` transitions
- `drain()` is called on terminal events (`session.idle`, `session.deleted`, `session.error`)
  to await all in-flight `fetch` calls before the process exits
- `process.on("beforeExit")` calls `flush()` as a safety net -- opencode disposes
  without awaiting async event handlers, so `drain()` may not complete
- `fetch` uses `keepalive: true` so in-flight requests survive process exit
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
# Build this package only (from repo root)
yarn workspace @gfxlabs/opencode-plugins-otel build

# Typecheck the whole monorepo (includes this package via project references)
yarn typecheck

# Clean build artifacts
yarn workspace @gfxlabs/opencode-plugins-otel clean
```

## Documentation maintenance rule

**When changing behavior, update the relevant documentation files in the same commit:**

- `packages/plugin-otel/docs/SETUP-INSTRUCTIONS.md` -- canonical source for config fields,
  examples, env var overrides, and redaction levels
- `packages/plugin-otel/README.md` -- install, events, protocol, API overview. Links to
  the setup guide for config/redaction details instead of duplicating them.
- `packages/plugin-otel/AGENTS.md` -- this file (architecture, internals, agent context)

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
When in doubt, update the relevant files. A stale doc is worse than no doc.
