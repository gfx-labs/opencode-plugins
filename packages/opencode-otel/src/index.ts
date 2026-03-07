import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { RedactLevel } from "./config.js"
import { loadConfig } from "./config.js"
import { detectGitInfo } from "./git.js"
import type { AttrVal, OtelLogRecord, OtelResourceAttr } from "./otel.js"
import { attrs, makeLogRecord, buildExportRequest, lineCount, safeStringifyLength } from "./otel.js"
import { createHandlers, DRAIN_EVENTS } from "./handlers.js"

const REDACTED = "<REDACTED>"
const PLUGIN_VERSION = 4

export const OtelPlugin: Plugin = async ({ project, directory, client }) => {
  const config = await loadConfig(directory)

  const enabledViaEnv = process.env.OPENCODE_OTEL_ENABLED === "1"
  if (!enabledViaEnv && config.enabled !== true) {
    await client.app.log({
      body: { service: "opencode-otel", level: "info", message: "disabled (set enabled: true in .opencode/otel.json or OPENCODE_OTEL_ENABLED=1)" },
    })
    return {}
  }

  const redactLevel: RedactLevel = config.redact ?? "full"

  await client.app.log({
    body: { service: "opencode-otel", level: "info", message: `enabled, endpoint=${config.endpoint ?? "none"}, redact=${redactLevel}` },
  })

  // rt: redact titles/descriptions — applies at light + full levels
  function rt(value: string): string {
    return redactLevel !== "none" ? REDACTED : value
  }

  // rs: redact structural metadata (paths, branch names, tool names, command args) — full level only
  function rs(value: string): string {
    return redactLevel === "full" ? REDACTED : value
  }

  const gitInfo = await detectGitInfo(directory)

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
  if (gitInfo.remoteUrl) {
    resourceAttrs.push({
      key: "vcs.repository.url.full",
      value: { stringValue: rt(gitInfo.remoteUrl) },
    })
  }
  if (gitInfo.branch) {
    resourceAttrs.push({
      key: "vcs.ref.head.name",
      value: { stringValue: rt(gitInfo.branch) },
    })
  }
  if (gitInfo.commit) {
    resourceAttrs.push({
      key: "vcs.ref.head.revision",
      value: { stringValue: gitInfo.commit },
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
  const childSessions = new Set<string>()
  // Buffer text parts that arrive before we know the message role
  const pendingTextParts = new Map<string, { sessionID: string; content: string; length: number; lines: number }>()

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

  const handlers = createHandlers({
    track,
    emit,
    rt,
    rs,
    userMessages,
    childSessions,
    pendingTextParts,
    getModelCosts,
    estimateCost,
  })

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
        "tool.title": rt(output.title),
        "tool.args_size": safeStringifyLength(input.args),
        "tool.output_size": output.output?.length,
        "tool.output_lines": output.output ? lineCount(output.output) : undefined,
        "tool.has_metadata": output.metadata !== undefined && output.metadata !== null,
      })
    },
  }
}
