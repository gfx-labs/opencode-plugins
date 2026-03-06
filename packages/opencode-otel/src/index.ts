import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"

interface OtelConfig {
  enabled?: boolean
  redact?: boolean
  endpoint?: string
  headers?: Record<string, string>
  user_id?: string
  organization?: string
  environment?: string
  project_name?: string
}

const REDACTED = "<REDACTED>"
const PLUGIN_VERSION = 2

interface OtelLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>
}

type OtelResourceAttr = { key: string; value: { stringValue?: string; intValue?: number } }

interface OtelExportLogsRequest {
  resourceLogs: Array<{
    resource: {
      attributes: OtelResourceAttr[]
    }
    scopeLogs: Array<{
      scope: { name: string; version: string }
      logRecords: OtelLogRecord[]
    }>
  }>
}

async function loadJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"))
  } catch {
    return undefined
  }
}

// Pick typed fields from an unknown object, silently dropping invalid values
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

function parseConfig(value: unknown): OtelConfig {
  if (typeof value !== "object" || value === null) return {}
  const obj = value as Record<string, unknown>
  return {
    enabled: bool(obj, "enabled"),
    redact: bool(obj, "redact"),
    endpoint: str(obj, "endpoint"),
    user_id: str(obj, "user_id"),
    organization: str(obj, "organization"),
    environment: str(obj, "environment"),
    project_name: str(obj, "project_name"),
    headers: strRecord(obj, "headers"),
  }
}

async function loadConfig(directory: string): Promise<OtelConfig> {
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

type OtelAttr = { key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }

type AttrVal = string | number | boolean | undefined | null

function attrs(obj: Record<string, AttrVal>): OtelAttr[] {
  const result: OtelAttr[] = []
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue
    if (typeof val === "boolean") {
      result.push({ key, value: { intValue: val ? 1 : 0 } })
    } else if (typeof val === "number") {
      if (Number.isInteger(val)) {
        result.push({ key, value: { intValue: val } })
      } else {
        result.push({ key, value: { doubleValue: val } })
      }
    } else {
      result.push({ key, value: { stringValue: val } })
    }
  }
  return result
}

function makeLogRecord(
  eventType: string,
  attributes: OtelAttr[],
): OtelLogRecord {
  return {
    timeUnixNano: String(Date.now() * 1_000_000),
    severityNumber: 9, // INFO
    severityText: "INFO",
    body: { stringValue: eventType },
    attributes: [...attrs({ "event.type": eventType }), ...attributes],
  }
}

function buildExportRequest(
  resourceAttrs: OtelResourceAttr[],
  records: OtelLogRecord[],
): OtelExportLogsRequest {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttrs,
        },
        scopeLogs: [
          {
            scope: {
              name: "opencode-otel",
              version: "0.1.0",
            },
            logRecords: records,
          },
        ],
      },
    ],
  }
}

export const OtelPlugin: Plugin = async ({ project, directory, client }) => {
  const config = await loadConfig(directory)

  const enabledViaEnv = process.env.OPENCODE_OTEL_ENABLED === "1"
  if (!enabledViaEnv && config.enabled !== true) {
    await client.app.log({
      body: { service: "opencode-otel", level: "info", message: "disabled (set enabled: true in .opencode/otel.json or OPENCODE_OTEL_ENABLED=1)" },
    })
    return {}
  }

  await client.app.log({
    body: { service: "opencode-otel", level: "info", message: `enabled, endpoint=${config.endpoint ?? "none"}` },
  })

  const redact = config.redact === true
  function r(value: string): string {
    return redact ? REDACTED : value
  }

  let sequence = 0

  // Env vars take precedence over config
  const endpoint = process.env.OPENCODE_OTEL_ENDPOINT || config.endpoint
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  // Config file headers first
  if (config.headers) {
    Object.assign(headers, config.headers)
  }

  // Env headers override config headers (key=value,key=value)
  const envHeaders = process.env.OPENCODE_OTEL_HEADERS
  if (envHeaders) {
    for (const pair of envHeaders.split(",")) {
      const eq = pair.indexOf("=")
      if (eq > 0) {
        headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
      }
    }
  }

  const resourceAttrs: OtelResourceAttr[] =
    [
      { key: "service.name", value: { stringValue: "opencode" } },
      { key: "organization.id", value: { stringValue: config.organization ?? "unset" } },
      { key: "deployment.environment", value: { stringValue: config.environment ?? "default" } },
      { key: "project.id", value: { stringValue: project.id } },

      { key: "plugin.version", value: { intValue: PLUGIN_VERSION } },
    ]
  resourceAttrs.push({
    key: "project.name",
    value: { stringValue: config.project_name ?? "default" },
  })
  if (config.user_id) {
    resourceAttrs.push({
      key: "user.id",
      value: { stringValue: config.user_id },
    })
  }

  // Cached model cost rates: modelID -> per-token costs
  interface ModelCost {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  let modelCosts: Map<string, ModelCost> | undefined

  async function getModelCosts(): Promise<Map<string, ModelCost>> {
    if (modelCosts) return modelCosts
    modelCosts = new Map()
    try {
      const res = await client.provider.list()
      if (res.data) {
        for (const provider of res.data.all) {
          for (const [, model] of Object.entries(provider.models)) {
            if (model.cost) {
              modelCosts.set(model.id, {
                input: model.cost.input,
                output: model.cost.output,
                cacheRead: model.cost.cache_read ?? 0,
                cacheWrite: model.cost.cache_write ?? 0,
              })
            }
          }
        }
      }
    } catch {
      void client.app.log({
        body: { service: "opencode-otel", level: "warn", message: "failed to load model costs" },
      })
    }
    return modelCosts
  }

  function estimateCost(
    costs: Map<string, ModelCost>,
    modelID: string,
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  ): number | undefined {
    const rates = costs.get(modelID)
    if (!rates) return undefined
    // Rates are $/million-tokens, so divide by 1_000_000 to get cost in dollars
    return (
      tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.reasoning * rates.output +
      tokens.cache.read * rates.cacheRead +
      tokens.cache.write * rates.cacheWrite
    ) / 1_000_000
  }

  const logsUrl = endpoint ? endpoint.replace(/\/$/, "") + "/v1/logs" : undefined
  const buffer: OtelLogRecord[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const inflight: Set<Promise<void>> = new Set()
  const userMessages = new Set<string>()
  // Buffer text parts that arrive before we know the message role
  const pendingTextParts = new Map<string, { sessionID: string; text: string }>()

  // Tracked context — updated on every event, auto-injected into all records
  let currentSessionID: string | undefined
  let currentMessageID: string | undefined

  function send(records: OtelLogRecord[]) {
    if (!logsUrl) return
    const p = fetch(logsUrl, {
      method: "POST",
      headers,
      keepalive: true,
      body: JSON.stringify(buildExportRequest(resourceAttrs, records)),
    }).then((res) => {
      void client.app.log({
        body: { service: "opencode-otel", level: "debug", message: `sent ${records.length} records — ${res.status}` },
      })
    }).catch((err) => {
      void client.app.log({
        body: { service: "opencode-otel", level: "error", message: `send failed: ${err}` },
      })
    })
    inflight.add(p)
    p.finally(() => inflight.delete(p))
  }

  function flush() {
    if (buffer.length === 0) return
    send(buffer.splice(0))
  }

  async function drain() {
    flush()
    await Promise.all([...inflight])
  }

  function enqueue(record: OtelLogRecord) {
    if (!endpoint) return
    record.attributes.push(...attrs({ "event.sequence": sequence++ }))
    buffer.push(record)
    if (buffer.length >= 100) {
      flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 5_000)
    }
  }

  function tokenAttrs(prefix: string, tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }): Record<string, AttrVal> {
    return {
      [`${prefix}.input`]: tokens.input,
      [`${prefix}.output`]: tokens.output,
      [`${prefix}.reasoning`]: tokens.reasoning,
      [`${prefix}.cache.read`]: tokens.cache.read,
      [`${prefix}.cache.write`]: tokens.cache.write,
    }
  }

  // Emit a log record with tracked context always injected.
  // Event-specific attrs override tracked values.
  function emit(eventType: string, eventAttrs: Record<string, AttrVal>) {
    enqueue(makeLogRecord(eventType, attrs({
      "session.id": currentSessionID,
      "message.id": currentMessageID,
      ...eventAttrs,
    })))
  }

  function track(sessionID?: string | null, messageID?: string | null) {
    if (sessionID) currentSessionID = sessionID
    if (messageID) currentMessageID = messageID
  }

  function lineCount(text: string): number {
    if (text.length === 0) return 0
    let count = 1
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) count++
    }
    return count
  }

  function safeStringifyLength(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined
    try {
      return JSON.stringify(value).length
    } catch {
      return undefined
    }
  }

  function sessionFields(session: {
    id: string
    projectID: string
    parentID?: string
    title: string
    version: string
    summary?: { additions: number; deletions: number; files: number }
    share?: { url: string }
    time: { created: number; updated: number; compacting?: number }
  }): Record<string, AttrVal> {
    return {
      "session.id": session.id,
      "session.project_id": session.projectID,

      "session.title": r(session.title),
      "session.version": session.version,
      "session.time.created": session.time.created,
      "session.time.updated": session.time.updated,
      "session.parent_id": session.parentID,
      "session.time.compacting": session.time.compacting,
      "session.summary.additions": session.summary?.additions,
      "session.summary.deletions": session.summary?.deletions,
      "session.summary.files": session.summary?.files,
      "session.share": session.share ? true : false,
    }
  }

  // Typed handler map — each handler receives the narrowed event type
  type EventType = Event["type"]
  type EventFor<T extends EventType> = Extract<Event, { type: T }>
  type EventHandler<T extends EventType> = (event: EventFor<T>) => Promise<void> | void
  type EventHandlers = { [T in EventType]?: EventHandler<T> }

  function handlePartUpdated(part: EventFor<"message.part.updated">["properties"]["part"], delta: string | undefined) {
    const base: Record<string, AttrVal> = {
      "part.id": part.id,
      "part.type": part.type,
      "delta.length": delta?.length,
    }
    let extra: Record<string, AttrVal> = {}
    switch (part.type) {
      case "text":
        extra = {
          "text.length": part.text.length,
          "text.lines": lineCount(part.text),
          "text.content": r(part.text),
          "text.synthetic": part.synthetic,
          "text.ignored": part.ignored,
          "text.time.start": part.time?.start,
          "text.time.end": part.time?.end,
          "text.duration_ms": part.time?.end !== undefined && part.time?.start !== undefined
            ? part.time.end - part.time.start
            : undefined,
        }
        if (userMessages.has(part.messageID)) {
          emit("user.prompt", {
            "prompt.length": part.text.length,
            "prompt.lines": lineCount(part.text),
            "prompt.content": r(part.text),
          })
        } else if (!pendingTextParts.has(part.messageID)) {
          pendingTextParts.set(part.messageID, {
            sessionID: part.sessionID,
            text: part.text,
          })
        }
        break
      case "reasoning":
        extra = {
          "reasoning.length": part.text.length,
          "reasoning.lines": lineCount(part.text),
          "reasoning.content": r(part.text),
          "reasoning.time.start": part.time.start,
          "reasoning.time.end": part.time.end,
          "reasoning.duration_ms": part.time.end !== undefined
            ? part.time.end - part.time.start
            : undefined,
        }
        break
      case "tool": {
        extra = {
          "tool.name": part.tool,
          "tool.call_id": part.callID,
          "tool.state": part.state.status,
          "tool.input_size": safeStringifyLength(part.state.input),
        }
        const state = part.state
        switch (state.status) {
          case "running":
            extra["tool.time.start"] = state.time.start
            break
          case "completed":
            extra["tool.time.start"] = state.time.start
            extra["tool.time.end"] = state.time.end
            extra["tool.duration_ms"] = state.time.end - state.time.start
            extra["tool.success"] = true
            extra["tool.title"] = r(state.title)
            extra["tool.output_size"] = state.output.length
            extra["tool.output_lines"] = lineCount(state.output)
            extra["tool.time.compacted"] = state.time.compacted
            extra["tool.attachments"] = state.attachments?.length
            break
          case "error":
            extra["tool.time.start"] = state.time.start
            extra["tool.time.end"] = state.time.end
            extra["tool.duration_ms"] = state.time.end - state.time.start
            extra["tool.success"] = false
            extra["tool.error"] = r(state.error)
            break
        }
        break
      }
      case "step-start":
        extra = {
          "step.snapshot": part.snapshot ? true : false,
        }
        break
      case "step-finish":
        extra = {
          "step.reason": part.reason,
          "step.cost": part.cost,
          "step.snapshot": part.snapshot ? true : false,
          ...tokenAttrs("step.tokens", part.tokens),
        }
        break
      case "snapshot":
        extra = { "snapshot.id": part.snapshot }
        break
      case "subtask":
        extra = {
          "subtask.agent": part.agent,
          "subtask.description": r(part.description),
          "subtask.prompt.length": part.prompt.length,
          "subtask.prompt.lines": lineCount(part.prompt),
        }
        break
      case "agent":
        extra = { "agent.name": part.name }
        break
      case "retry":
        extra = {
          "retry.attempt": part.attempt,
          "retry.error.name": part.error.name,
          "retry.error.message": r(part.error.data.message),
          "retry.error.status_code": part.error.data.statusCode,
          "retry.error.retryable": part.error.data.isRetryable,
          "retry.time.created": part.time.created,
        }
        break
      case "compaction":
        extra = { "compaction.auto": part.auto }
        break
      case "file":
        extra = {
          "file.mime": part.mime,
          "file.name": part.filename ? r(part.filename) : undefined,
          "file.source.type": part.source?.type,

          "file.source.length": part.source?.text.value.length,
          "file.source.lines": part.source ? part.source.text.end - part.source.text.start : undefined,
        }
        break
      case "patch":
        extra = {
          "patch.hash": part.hash,
          "patch.files": part.files.length,
        }
        break
    }
    emit("message.part.updated", { ...base, ...extra })
  }

  const handlers: EventHandlers = {
    "session.created": (event) => {
      track(event.properties.info.id)
      emit("session.created", sessionFields(event.properties.info))
    },
    "session.updated": (event) => {
      track(event.properties.info.id)
      emit("session.updated", sessionFields(event.properties.info))
    },
    "session.deleted": (event) => {
      track(event.properties.info.id)
      emit("session.deleted", sessionFields(event.properties.info))
    },
    "session.idle": (event) => {
      track(event.properties.sessionID)
      emit("session.idle", {})
    },
    "session.compacted": (event) => {
      track(event.properties.sessionID)
      emit("session.compacted", {})
    },
    "session.status": (event) => {
      track(event.properties.sessionID)
      const status = event.properties.status
      emit("session.status", {
        "session.status": status.type,
        ...(status.type === "retry" ? {
          "retry.attempt": status.attempt,
          "retry.message": r(status.message),
          "retry.next": status.next,
        } : {}),
      })
    },
    "session.error": (event) => {
      track(event.properties.sessionID)
      const err = event.properties.error
      emit("session.error", {
        "error.name": err?.name,
        "error.message": err && "message" in err.data ? r(String(err.data.message)) : undefined,
        "error.provider_id": err?.name === "ProviderAuthError" ? err.data.providerID : undefined,
        "error.retryable": err?.name === "APIError" ? err.data.isRetryable : undefined,
        "error.status_code": err?.name === "APIError" ? err.data.statusCode : undefined,
      })
    },
    "session.diff": (event) => {
      track(event.properties.sessionID)
      const diffs = event.properties.diff
      emit("session.diff", {
        "diff.files": diffs.length,
        "diff.additions": diffs.reduce((sum, d) => sum + d.additions, 0),
        "diff.deletions": diffs.reduce((sum, d) => sum + d.deletions, 0),
      })
    },
    "message.updated": async (event) => {
      const msg = event.properties.info
      track(msg.sessionID, msg.id)
      const duration = msg.role === "assistant" && msg.time.completed !== undefined
        ? msg.time.completed - msg.time.created
        : undefined
      emit("message.updated", {
        "message.role": msg.role,
        "message.time.created": msg.time.created,
        ...(msg.role === "assistant" ? {
          "model.id": msg.modelID,
          "provider.id": msg.providerID,
          "message.mode": msg.mode,
          "message.parent_id": msg.parentID,
          "message.cost": msg.cost,
          ...tokenAttrs("tokens", msg.tokens),
          "message.finish": msg.finish,
          "message.time.completed": msg.time.completed,
          "message.duration_ms": duration,

          "message.summary": msg.summary,
          "message.error.name": msg.error?.name,
          "message.error.message": msg.error && "message" in msg.error.data
            ? r(String(msg.error.data.message))
            : undefined,
        } : {}),
        ...(msg.role === "user" ? {
          "message.agent": msg.agent,
          "message.model.id": msg.model.modelID,
          "message.model.provider_id": msg.model.providerID,
          "message.system.length": msg.system?.length,
          "message.tools.count": msg.tools ? Object.keys(msg.tools).length : undefined,
          "message.summary.diffs": msg.summary?.diffs?.length,
          "message.summary.additions": msg.summary?.diffs?.reduce((sum: number, d: { additions: number }) => sum + d.additions, 0),
          "message.summary.deletions": msg.summary?.diffs?.reduce((sum: number, d: { deletions: number }) => sum + d.deletions, 0),
        } : {}),
      })
      if (msg.role === "user") {
        userMessages.add(msg.id)
        const pending = pendingTextParts.get(msg.id)
        if (pending) {
          pendingTextParts.delete(msg.id)
          emit("user.prompt", {
            "prompt.length": pending.text.length,
            "prompt.lines": lineCount(pending.text),
            "prompt.content": r(pending.text),
          })
        }
      }
      if (msg.role === "assistant" && msg.finish) {
        let effectiveCost = msg.cost
        if (!effectiveCost) {
          const costs = await getModelCosts()
          effectiveCost = estimateCost(costs, msg.modelID, msg.tokens) ?? 0
        }
        emit("api.request", {
          "model.id": msg.modelID,
          "provider.id": msg.providerID,
          "message.mode": msg.mode,
          "cost": effectiveCost,
          "cost.estimated": msg.cost === 0,
          ...tokenAttrs("tokens", msg.tokens),
          "duration_ms": duration,
          "finish": msg.finish,
        })
      }
    },
    "message.part.updated": (event) => {
      const part = event.properties.part
      track(part.sessionID, part.messageID)
      handlePartUpdated(part, event.properties.delta)
    },
    "message.removed": (event) => {
      track(event.properties.sessionID, event.properties.messageID)
      emit("message.removed", {})
    },
    "message.part.removed": (event) => {
      track(event.properties.sessionID, event.properties.messageID)
      emit("message.part.removed", {
        "part.id": event.properties.partID,
      })
    },
    "command.executed": (event) => {
      track(event.properties.sessionID, event.properties.messageID)
      emit("command.executed", {
        "command.name": event.properties.name,
        "command.arguments": r(event.properties.arguments),
      })
    },
    "file.edited": (event) => {
      emit("file.edited", {})
    },
    "permission.updated": (event) => {
      const perm = event.properties
      track(perm.sessionID, perm.messageID)
      emit("permission.updated", {
        "permission.id": perm.id,
        "permission.type": perm.type,
        "permission.title": r(perm.title),
        "permission.time.created": perm.time.created,
        "permission.call_id": perm.callID,
      })
    },
    "permission.replied": (event) => {
      track(event.properties.sessionID)
      emit("permission.replied", {
        "permission.id": event.properties.permissionID,
        "permission.response": event.properties.response,
      })
    },
    "todo.updated": (event) => {
      track(event.properties.sessionID)
      const todos = event.properties.todos
      const statusCounts: Record<string, number> = {}
      const priorityCounts: Record<string, number> = {}
      for (const todo of todos) {
        statusCounts[todo.status] = (statusCounts[todo.status] ?? 0) + 1
        priorityCounts[todo.priority] = (priorityCounts[todo.priority] ?? 0) + 1
      }
      emit("todo.updated", {
        "todo.count": todos.length,
        "todo.pending": statusCounts["pending"] ?? 0,
        "todo.in_progress": statusCounts["in_progress"] ?? 0,
        "todo.completed": statusCounts["completed"] ?? 0,
        "todo.cancelled": statusCounts["cancelled"] ?? 0,
        "todo.high": priorityCounts["high"] ?? 0,
        "todo.medium": priorityCounts["medium"] ?? 0,
        "todo.low": priorityCounts["low"] ?? 0,
      })
    },
    "vcs.branch.updated": (event) => {
      emit("vcs.branch.updated", {
        "vcs.branch": event.properties.branch ? r(event.properties.branch) : undefined,
      })
    },
  }

  const DRAIN_EVENTS = new Set<EventType>(["session.idle", "session.deleted", "session.error"])

  return {
    event: async ({ event }) => {
      const handler = handlers[event.type] as ((event: Event) => Promise<void> | void) | undefined
      if (handler) await handler(event)
      if (DRAIN_EVENTS.has(event.type)) await drain()
    },

    "tool.execute.after": async (input, output) => {
      track(input.sessionID)
      emit("tool.executed", {
        "tool.name": input.tool,
        "tool.call_id": input.callID,
        "tool.title": r(output.title),
        "tool.args_size": safeStringifyLength(input.args),
        "tool.output_size": output.output?.length,
        "tool.output_lines": output.output ? lineCount(output.output) : undefined,
        "tool.has_metadata": output.metadata !== undefined && output.metadata !== null,
      })
    },
  }
}

