# @gfxlabs/opencode-plugins-otel

OpenTelemetry usage-tracking plugin for [opencode](https://opencode.ai). Captures session lifecycle, message flow, tool execution, and cost metrics as OTLP/HTTP JSON log records and ships them to any OTel-compatible collector.

## Install

Add `@gfxlabs/opencode-plugins-otel` to the `plugin` array in your opencode config file. opencode installs npm packages automatically.

```json
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@gfxlabs/opencode-plugins-otel"]
}
```

If you already have a `plugin` array, append `"@gfxlabs/opencode-plugins-otel"` to it.

## Quick start

**2. Create an `otel.json` config file:**

**`.opencode/otel.json`** (project-level)

```json
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
  "enabled": true,
  "endpoint": "https://otel-collector.example.com"
}
```

The plugin is disabled by default. You must explicitly enable it via config or environment variable.

## Configuration

Configuration is loaded from two JSON files and merged (project overrides global per-key; headers are deep-merged):

| Location | Purpose |
|---|---|
| `~/.config/opencode/otel.json` | Global user settings (applied to all projects) |
| `<project>/.opencode/otel.json` | Project-specific overrides |

All fields are optional in both files. See [Setup Instructions](docs/SETUP-INSTRUCTIONS.md) for full examples.

### Config fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable the plugin |
| `endpoint` | `string` | | OTLP/HTTP base URL. Logs are sent to `<endpoint>/v1/logs` |
| `headers` | `Record<string, string>` | | Extra HTTP headers (e.g. auth tokens) |
| `redact` | `"none" \| "light" \| "full"` | `"full"` | Redaction level. See [Redaction](#redaction) below |
| `user_id` | `string` | | User identifier. Sent as `user.id` resource attribute |
| `organization` | `string` | `"unset"` | Organization ID |
| `environment` | `string` | `"default"` | Deployment environment name |
| `project_name` | `string` | | Human-readable project name. Sent as `project.name` resource attribute |

### Environment variable overrides

Environment variables take precedence over config file values.

| Variable | Description |
|---|---|
| `OPENCODE_OTEL_ENABLED` | Set to `"1"` to enable the plugin |
| `OPENCODE_OTEL_ENDPOINT` | OTLP/HTTP base URL |
| `OPENCODE_OTEL_HEADERS` | Comma-separated `key=value` pairs for extra headers |

## What gets tracked

### Resource attributes

Every log record includes these resource-level attributes:

| Attribute | Source |
|---|---|
| `service.name` | Always `"opencode"` |
| `organization.id` | Config `organization` or `"unset"` |
| `deployment.environment` | Config `environment` or `"default"` |
| `project.id` | Always from opencode `project.id` |
| `project.name` | Config `project_name` (if set) |
| `user.id` | Config `user_id` (if set) |
| `vcs.repository.url.full` | Git remote origin URL (if detected) |
| `vcs.ref.head.name` | Git branch name at startup (if detected) |
| `vcs.ref.head.revision` | Git commit SHA at startup (if detected) |

### Events

The plugin listens to opencode platform events and emits corresponding OTLP log records. Each record's `body` is the event type string and attributes carry structured data.

| Event type | Description |
|---|---|
| `session.created` | A new session was started (includes summary stats if available) |
| `session.updated` | Session metadata changed (title, timestamps, summary stats) |
| `session.deleted` | Session was deleted |
| `session.idle` | Session became idle |
| `session.compacted` | Session history was compacted |
| `session.status` | Session status change (includes retry info) |
| `session.error` | An error occurred in the session |
| `session.diff` | File diff summary (file count, additions, deletions) |
| `message.updated` | A message was created or updated (user or assistant) |
| `message.removed` | A message was removed/undone |
| `message.part.updated` | A message part changed (text, reasoning, tool call, step, subtask, etc.) |
| `message.part.removed` | A message part was removed |
| `user.prompt` | Synthetic event: user's prompt content (redacted via `rt()`), length, and line count |
| `api.request` | Synthetic event: assistant message completion with cost and token breakdown |
| `command.executed` | A slash command was executed |
| `file.edited` | A file was edited |
| `permission.updated` | A permission request was created |
| `permission.replied` | A permission request was answered |
| `todo.updated` | Todo list changed (total count and per-status/priority breakdowns) |
| `vcs.branch.updated` | Git branch changed |
| `tool.executed` | A tool finished execution (via `tool.execute.after` hook) |

### Session summary stats

Session events (`session.created`, `session.updated`, `session.deleted`) include cumulative diff statistics when available:

- `session.summary.additions` -- total lines added
- `session.summary.deletions` -- total lines deleted
- `session.summary.files` -- number of files changed
- `session.share` -- whether the session is shared

### Token and cost tracking

For assistant messages, the plugin records:

- Token counts: `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`
- Cost from the provider (when available)
- Estimated cost from per-token rates via `client.provider.list()` (fallback when provider cost is 0)
- Duration in milliseconds
- Whether the message is a compaction summary: `message.summary`

The `api.request` synthetic event aggregates these into a single record per LLM call.

For user messages, the plugin additionally records:

- System prompt length: `message.system.length`
- Enabled tools count: `message.tools.count`
- Context diff stats: `message.summary.diffs`, `message.summary.additions`, `message.summary.deletions`

### Message part details

The `message.part.updated` event captures type-specific attributes. All parts include `delta.length` when a streaming delta is present.

| Part type | Key attributes |
|---|---|
| `text` | `text.length`, `text.lines`, `text.synthetic`, `text.ignored`, `text.time.start`, `text.time.end`, `text.duration_ms` |
| `reasoning` | `reasoning.length`, `reasoning.lines`, `reasoning.time.start`, `reasoning.time.end`, `reasoning.duration_ms` |
| `tool` | `tool.name`, `tool.call_id`, `tool.state`, `tool.input_size`, `tool.output_size`, `tool.output_lines`, `tool.duration_ms`, `tool.success`, `tool.time.compacted`, `tool.attachments` |
| `step-start` | `step.snapshot` |
| `step-finish` | `step.reason`, `step.cost`, `step.snapshot`, `step.tokens.*` |
| `snapshot` | `snapshot.id` |
| `subtask` | `subtask.agent`, `subtask.description`, `subtask.prompt.length`, `subtask.prompt.lines` |
| `agent` | `agent.name` |
| `retry` | `retry.attempt`, `retry.error.name`, `retry.error.status_code`, `retry.error.retryable`, `retry.time.created` |
| `compaction` | `compaction.auto` |
| `file` | `file.mime`, `file.name`, `file.source.type`, `file.source.length`, `file.source.lines` |
| `patch` | `patch.hash`, `patch.files` |

### Tool execution metrics

The `tool.executed` event (from the `tool.execute.after` hook) captures:

- `tool.args_size` -- serialized size of tool input arguments
- `tool.output_size` -- character length of tool output
- `tool.output_lines` -- line count of tool output
- `tool.has_metadata` -- whether metadata was returned

## Batching and delivery

- Records are buffered and flushed when either **100 records** accumulate or **5 seconds** elapse.
- On terminal events (`session.idle`, `session.deleted`, `session.error`), the plugin drains all buffered and in-flight requests before returning to ensure delivery before process exit.
- Failed sends are logged via `client.app.log` but do not throw or block the session.

## Redaction

### Content never sent

LLM-generated content is **never sent** regardless of redaction level. This includes:

- Assistant text and reasoning content
- Tool error messages
- Session/message error messages
- Retry error messages

These fields are omitted entirely (not replaced with a placeholder). Only structural metrics like length and line count are sent.

### User prompt text

User prompt text is the one exception to the content policy above. The `user.prompt` event includes `prompt.content`, which contains the actual prompt text wrapped in `rt()`. This means:

- At `"full"` (default) and `"light"`: prompt content is `<REDACTED>`
- At `"none"`: prompt content is sent as-is

This allows usage dashboards to display recent user prompts when redaction is disabled.

### Redaction levels

The `redact` config field controls how much structural metadata is sent. Default: `"full"`.

For backwards compatibility, `redact: true` is treated as `"full"` and `redact: false` as `"none"`.

| Level | Titles & descriptions | Structural metadata | Numeric/IDs |
|---|---|---|---|
| `"full"` (default) | `<REDACTED>` | `<REDACTED>` | Sent |
| `"light"` | `<REDACTED>` | Sent | Sent |
| `"none"` | Sent | Sent | Sent |

**Titles, descriptions, VCS, and prompt content** (redacted at `light` and `full`, sent only at `none`):
- Session titles (`session.title`)
- Tool result titles (`tool.title`)
- Subtask descriptions (`subtask.description`)
- Permission titles (`permission.title`)
- File names (`file.name`)
- Git branch names (`vcs.branch`, `vcs.ref.head.name`)
- Git remote URL (`vcs.repository.url.full`)
- User prompt content (`prompt.content`)

**Structural metadata** (redacted at `full` only):
- Tool names (`tool.name`)
- Command arguments (`command.arguments`)

**Always sent** (never redacted):
- Token counts, cost values, timing data
- IDs, types, states, status codes
- Numeric metrics (lengths, line counts, sizes)

**Note:** Filesystem paths are never sent, regardless of redaction level. The plugin does not transmit working directories, file paths, or project worktree paths.

## Protocol

The plugin speaks **OTLP/HTTP JSON** (not gRPC, not Protobuf). Log records are sent as `POST` requests to `<endpoint>/v1/logs` with `Content-Type: application/json`.

The scope is identified as:
- **Scope name:** `opencode-otel`
- **Scope version:** `0.1.0`

All timestamps use nanosecond precision (Unix epoch). All records are severity `INFO` (severityNumber 9).

## API

The package exports a single binding:

```ts
import { OtelPlugin } from "@gfxlabs/opencode-plugins-otel"
```

`OtelPlugin` conforms to the `Plugin` type from `@opencode-ai/plugin`. It implements two hooks:

- **`event`** -- handles all platform events (session, message, command, file, permission)
- **`tool.execute.after`** -- records tool execution after completion

## Build

```bash
npm run build -w packages/opencode-otel
```

Output: `dist/index.mjs` (ESM) + `dist/index.d.mts` (types). ESM-only, no CJS.

## License

dual-licensed under [Unlicense](https://unlicense.org/) and [MIT](https://opensource.org/licenses/MIT). choose whichever you prefer.
