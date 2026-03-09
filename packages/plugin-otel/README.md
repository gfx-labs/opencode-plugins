# @gfxlabs/opencode-plugins-otel

OpenTelemetry usage-tracking plugin for [opencode](https://opencode.ai). Captures session lifecycle, message flow, tool execution, and cost metrics as OTLP/HTTP JSON log records and ships them to any OTel-compatible collector.

## Install

Add `@gfxlabs/opencode-plugins-otel` to the `plugin` array in your opencode config file. opencode installs npm packages automatically.

```json
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@gfxlabs/opencode-plugins-otel@latest"]
}
```

Then create an `otel.json` config file to enable and configure the plugin. See the **[Setup Instructions](docs/SETUP-INSTRUCTIONS.md)** for full configuration reference, examples, environment variable overrides, and redaction levels.

Minimal example:

```json
// .opencode/otel.json
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/plugin-otel/otel.schema.json",
  "enabled": true,
  "endpoint": "https://otel-collector.example.com"
}
```

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
| `user.prompt` | Synthetic event: user's prompt content (redacted via `rt()`), length, and line count. Only emitted for root sessions, not subtask/subagent sessions. |
| `api.request` | Synthetic event: assistant message completion with cost and token breakdown |
| `command.executed` | A slash command was executed |
| `file.edited` | A file was edited |
| `permission.updated` | A permission request was created |
| `permission.replied` | A permission request was answered |
| `todo.updated` | Todo list changed (total count and per-status/priority breakdowns) |
| `vcs.branch.updated` | Git branch changed |
| `tool.executed` | A tool finished execution (via `tool.execute.after` hook) |

### Token and cost tracking

Cost and token data is only emitted on the `api.request` synthetic event, which fires exactly once per completed LLM call (deduplicated by message ID). This includes:

- Token counts: `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`
- Cost from the provider (when available)
- Estimated cost from per-token rates via `client.provider.list()` (fallback when provider cost is 0)
- Duration in milliseconds
- Finish reason: `finish`

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
yarn workspace @gfxlabs/opencode-plugins-otel build
```

Output: `dist/index.mjs` (ESM) + `dist/index.d.mts` (types). ESM-only, no CJS.

## License

dual-licensed under [Unlicense](https://unlicense.org/) and [MIT](https://opensource.org/licenses/MIT). choose whichever you prefer.
