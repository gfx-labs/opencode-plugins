import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

// Field metadata — single source of truth for config shape, parsing, and schema generation.
// Each entry defines the config key, its runtime type, JSON schema metadata, and
// how to extract it from raw JSON.

export type RedactLevel = "none" | "light" | "full"

const REDACT_LEVELS: ReadonlySet<string> = new Set<RedactLevel>(["none", "light", "full"])

interface FieldDef {
  key: string
  type: "boolean" | "string" | "headers" | "enum"
  description: string
  default?: string | boolean
  format?: string
  enum?: readonly string[]
  examples?: unknown[]
}

export const CONFIG_FIELDS: FieldDef[] = [
  {
    key: "enabled",
    type: "boolean",
    description: "Enable the plugin. Default: false.",
    default: false,
  },
  {
    key: "redact",
    type: "enum",
    description: "Redaction level. \"full\" (default): redact all structural strings. \"light\": redact titles/descriptions but keep VCS info and tool/command names. \"none\": send all structural metadata. LLM-generated content (prompts, reasoning, text) is never sent regardless of this setting.",
    default: "full",
    enum: ["none", "light", "full"],
  },
  {
    key: "endpoint",
    type: "string",
    description: "OTLP/HTTP base URL. Logs are POSTed to <endpoint>/v1/logs.",
    format: "uri",
    examples: ["https://otel-collector.example.com"],
  },
  {
    key: "headers",
    type: "headers",
    description: "Extra HTTP headers sent with every request (e.g. auth tokens). Project headers are merged on top of global headers.",
    examples: [{ "Authorization": "Bearer tok_xxx" }],
  },
  {
    key: "user_id",
    type: "string",
    description: "User identifier. Sent as the user.id resource attribute.",
    examples: ["alice"],
  },
  {
    key: "organization",
    type: "string",
    description: "Organization or team name. Sent as the organization.id resource attribute. Default: \"unset\".",
    default: "unset",
    examples: ["eng-team"],
  },
  {
    key: "environment",
    type: "string",
    description: "Deployment environment name. Sent as the deployment.environment resource attribute. Default: \"default\".",
    default: "default",
    examples: ["production", "staging", "development"],
  },
  {
    key: "project_name",
    type: "string",
    description: "Human-readable project name. Sent as the project.name resource attribute.",
    examples: ["my-api"],
  },
]

export interface OtelConfig {
  enabled?: boolean
  redact?: RedactLevel
  endpoint?: string
  headers?: Record<string, string>
  user_id?: string
  organization?: string
  environment?: string
  project_name?: string
}

// Typed extractors for raw JSON values
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key]
  return typeof val === "string" ? val : undefined
}

function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const val = obj[key]
  return typeof val === "boolean" ? val : undefined
}

function strRecord(obj: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const val = obj[key]
  if (typeof val !== "object" || val === null) return undefined
  for (const v of Object.values(val as Record<string, unknown>)) {
    if (typeof v !== "string") return undefined
  }
  return val as Record<string, string>
}

// parseConfig is derived from CONFIG_FIELDS so the accepted keys always match.
function parseConfig(value: unknown): OtelConfig {
  if (typeof value !== "object" || value === null) return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const field of CONFIG_FIELDS) {
    switch (field.type) {
      case "boolean":
        result[field.key] = bool(obj, field.key)
        break
      case "string":
        result[field.key] = str(obj, field.key)
        break
      case "enum": {
        const val = str(obj, field.key)
        if (val && field.enum && (field.enum as readonly string[]).includes(val)) {
          result[field.key] = val
        }
        // Also accept boolean true/false for backwards compat with old redact: true/false
        const boolVal = bool(obj, field.key)
        if (boolVal !== undefined && result[field.key] === undefined) {
          result[field.key] = boolVal ? "full" : "none"
        }
        break
      }
      case "headers":
        result[field.key] = strRecord(obj, field.key)
        break
    }
  }
  return result as OtelConfig
}

async function loadJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"))
  } catch {
    return undefined
  }
}

export async function loadConfig(directory: string): Promise<OtelConfig> {
  const [projectRaw, globalRaw] = await Promise.all([
    loadJsonFile(join(directory, ".opencode", "otel.json")),
    loadJsonFile(join(homedir(), ".config", "opencode", "otel.json")),
  ])

  const global = parseConfig(globalRaw)
  const project = parseConfig(projectRaw)

  // Deep merge: both layers contribute, project overrides global per-key.
  // Typical setup:
  //   global  (~/.config/opencode/otel.json) — user, auth headers
  //   project (.opencode/otel.json)          — endpoint
  return {
    enabled: project.enabled ?? global.enabled,
    redact: project.redact ?? global.redact,
    endpoint: project.endpoint ?? global.endpoint,
    user_id: project.user_id ?? global.user_id,
    organization: project.organization ?? global.organization,
    environment: project.environment ?? global.environment,
    project_name: project.project_name ?? global.project_name,
    headers: {
      ...global.headers,
      ...project.headers,
    },
  }
}
