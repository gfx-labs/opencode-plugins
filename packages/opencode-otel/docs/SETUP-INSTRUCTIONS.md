# Setup Instructions

## 1. Add the plugin

Add `@gfxlabs/opencode-plugins-otel` to the `plugin` array in your opencode config file:

```json
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@gfxlabs/opencode-plugins-otel"]
}
```

If you already have a `plugin` array, append `"@gfxlabs/opencode-plugins-otel"` to it. opencode installs npm packages automatically -- no separate `npm install` step is needed.

## 2. Configuration

Configuration is loaded from two JSON files and merged. Project values override global values per-key; headers are deep-merged.

| Location | Purpose |
|---|---|
| `~/.config/opencode/otel.json` | Global user settings (applied to all projects) |
| `<project>/.opencode/otel.json` | Project-specific overrides |

All fields are optional in both files. Add `"$schema"` to get validation and autocomplete in your editor.

### Config fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable the plugin. Must be `true` (or set `OPENCODE_OTEL_ENABLED=1`) to activate. |
| `endpoint` | `string` | | OTLP/HTTP base URL. Logs are POSTed to `<endpoint>/v1/logs`. |
| `headers` | `Record<string, string>` | | Extra HTTP headers (e.g. auth tokens). Global and project headers are deep-merged. |
| `redact` | `"none" \| "light" \| "full"` | `"full"` | Redaction level. See [Redaction](#5-redaction) below. |
| `user_id` | `string` | | User identifier. Sent as the `user.id` resource attribute. |
| `organization` | `string` | `"unset"` | Organization or team name. Sent as `organization.id`. |
| `environment` | `string` | `"default"` | Deployment environment name. Sent as `deployment.environment`. |
| `project_name` | `string` | | Human-readable project name. Sent as `project.name`. |

## 3. Examples

Global config with user identity and auth:

```json
// ~/.config/opencode/otel.json
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
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

Minimal project config (uses endpoint/auth from global):

```json
// .opencode/otel.json
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
  "enabled": true,
  "project_name": "my-api"
}
```

Full project config with overrides:

```json
// .opencode/otel.json
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
  "enabled": true,
  "project_name": "my-api",
  "endpoint": "https://different-collector.example.com",
  "organization": "backend-team",
  "environment": "production"
}
```

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

LLM-generated content (reasoning, assistant text, error messages) is **never sent** regardless of redaction level. Only structural metrics like length and line count are emitted. User prompt text is the one exception -- it is sent wrapped in `rt()`, so it is `<REDACTED>` at `"light"` and `"full"` levels and only visible at `"none"`.

The `redact` field controls how much structural metadata is sent. Default is `"full"` (most conservative). For backwards compatibility, `true` is treated as `"full"` and `false` as `"none"`.

| Level | Titles & descriptions | Structural metadata (VCS, tool names, file names) |
|---|---|---|
| `"full"` (default) | `<REDACTED>` | `<REDACTED>` |
| `"light"` | `<REDACTED>` | Sent |
| `"none"` | Sent | Sent |

Numeric data (IDs, types, counts, sizes, token counts, costs, timestamps) is never redacted at any level.

Redaction can be set globally and overridden per-project:

```json
// ~/.config/opencode/otel.json — light redaction by default
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
  "redact": "light"
}
```

```json
// .opencode/otel.json — full redaction on a sensitive project
{
  "$schema": "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/master/packages/opencode-otel/otel.schema.json",
  "enabled": true,
  "redact": "full",
  "project_name": "my-project"
}
```

## Config resolution order

1. Load `<project>/.opencode/otel.json`
2. Load `~/.config/opencode/otel.json`
3. Merge: project values override global values per-key; headers are deep-merged
4. Environment variables override the merged result
