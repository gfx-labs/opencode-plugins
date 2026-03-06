# Setup Instructions

## 1. Install the plugin

```bash
npm install @gfxlabs/opencode-plugins-otel
```

## 2. Global config (once per machine)

Create `~/.config/opencode/otel.json` with your user identity and any shared auth headers. This applies to all projects.

Add `"$schema"` to get validation and autocomplete in your editor:

```json
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
  "user_id": "your-username",
  "organization": "your-org",
  "endpoint": "https://otel-collector.example.com",
  "headers": {
    "Authorization": "Bearer your-token-here"
  }
}
```

| Field | Purpose |
|---|---|
| `user_id` | Identifies you in telemetry data. Use your name, email, or team handle. |
| `organization` | Your org/team name. Shows up as `organization.id` on every record. |
| `endpoint` | OTLP/HTTP base URL. Logs are POSTed to `<endpoint>/v1/logs`. Can also be set per-project. |
| `headers` | Auth headers sent with every request. Project-level headers are merged on top. |

You can also set `redact` and `environment` here if you want them as defaults across all projects:

```json
{
  "user_id": "alice",
  "organization": "eng-team",
  "endpoint": "https://otel-collector.example.com",
  "environment": "development",
  "redact": "light",
  "headers": {
    "Authorization": "Bearer tok_xxx"
  }
}
```

## 3. Per-project config

Create `.opencode/otel.json` in your project root to enable the plugin and set project-specific values. Project values override global values per-key; headers are deep-merged.

Minimal example (uses endpoint/auth from global config):

```json
{
  "enabled": true,
  "project_name": "my-api"
}
```

Full example:

```json
{
  "enabled": true,
  "project_name": "my-api",
  "endpoint": "https://different-collector.example.com",
  "organization": "backend-team",
  "environment": "production"
}
```

| Field | Purpose |
|---|---|
| `enabled` | Must be `true` to activate the plugin. The plugin is off by default. |
| `project_name` | Human-readable name for this project. Sent as `project.name` resource attribute. |
| `endpoint` | Overrides the global endpoint for this project. |
| `organization` | Overrides the global org for this project. |
| `environment` | Label for this environment (`production`, `staging`, `development`, etc.). Default: `"default"`. |

## 4. Environment variable overrides

Environment variables take precedence over both config files.

```bash
# Enable without editing config files
export OPENCODE_OTEL_ENABLED=1

# Override endpoint
export OPENCODE_OTEL_ENDPOINT=https://otel-collector.example.com

# Override headers (comma-separated key=value pairs)
export OPENCODE_OTEL_HEADERS="Authorization=Bearer tok_xxx,X-Custom=value"
```

## 5. Redaction

LLM-generated content (prompts, reasoning, assistant text, error messages) is **never sent** regardless of redaction level. Only structural metrics like length and line count are emitted.

The `redact` field controls how much structural metadata is sent. It accepts `"none"`, `"light"`, or `"full"`. Default is `"full"` (most conservative). For backwards compatibility, `true` is treated as `"full"` and `false` as `"none"`.

| Level | Titles & descriptions | Structural metadata (VCS, tool names, file names) |
|---|---|---|
| `"full"` (default) | `<REDACTED>` | `<REDACTED>` |
| `"light"` | `<REDACTED>` | Sent |
| `"none"` | Sent | Sent |

Numeric data (IDs, types, counts, sizes, token counts, costs, timestamps) is never redacted at any level.

Redaction can be set globally and overridden per-project. For example, use light redaction by default but full on a sensitive project:

```json
// ~/.config/opencode/otel.json
{ "redact": "light" }
```

```json
// .opencode/otel.json (in a project where you want max privacy)
{ "enabled": true, "redact": "full", "project_name": "my-project" }
```

## Config resolution order

1. Load `<project>/.opencode/otel.json`
2. Load `~/.config/opencode/otel.json`
3. Merge: project values override global values per-key; headers are deep-merged
4. Environment variables override the merged result
