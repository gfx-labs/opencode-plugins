import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { RedactLevel } from "./config.js"
import { loadConfig } from "./config.js"
import { detectGitInfo } from "./git.js"
import type { OtelEvent, Tokens } from "./events.js"
import { flattenEvent, toolExecuted } from "./events.js"
import type { OtelLogRecord, OtelResourceAttr } from "./otel.js"
import { attrs, makeLogRecord, buildExportRequest, lineCount, safeStringifyLength } from "./otel.js"
import { createHandlers, DRAIN_EVENTS } from "./handlers.js"

const REDACTED = "<REDACTED>"
const PLUGIN_VERSION = 5

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type LogLevel = "debug" | "info" | "warn" | "error"

interface LogFn {
  (level: LogLevel, message: string): void
}

export class EmitContext {
  // Transport
  private readonly logsUrl: string | undefined
  private readonly headers: Record<string, string>
  private readonly resourceAttrs: OtelResourceAttr[]
  private readonly log: LogFn

  // Buffering
  private readonly buffer: OtelLogRecord[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly inflight = new Set<Promise<void>>()
  private sequence = 0

  // Context tracking
  private currentSessionID: string | undefined
  private currentMessageID: string | undefined

  // Dedup state
  readonly userMessages = new Set<string>()
  readonly childSessions = new Set<string>()
  readonly pendingTextParts = new Map<string, { sessionID: string; content: string; length: number; lines: number }>()

  // Redaction
  readonly rt: (value: string) => string
  readonly rs: (value: string) => string

  // Cost estimation
  private modelCosts: Map<string, ModelCost> | undefined
  private readonly loadProviders: () => Promise<Array<{ models: Record<string, { id: string; cost?: { input: number; output: number; cache_read?: number; cache_write?: number } }> }>>

  constructor(opts: {
    logsUrl: string | undefined
    headers: Record<string, string>
    resourceAttrs: OtelResourceAttr[]
    redactLevel: RedactLevel
    log: LogFn
    loadProviders: () => Promise<Array<{ models: Record<string, { id: string; cost?: { input: number; output: number; cache_read?: number; cache_write?: number } }> }>>
  }) {
    this.logsUrl = opts.logsUrl
    this.headers = opts.headers
    this.resourceAttrs = opts.resourceAttrs
    this.log = opts.log
    this.loadProviders = opts.loadProviders
    this.rt = opts.redactLevel !== "none"
      ? () => REDACTED
      : (v: string) => v
    this.rs = opts.redactLevel === "full"
      ? () => REDACTED
      : (v: string) => v
  }

  track(sessionID?: string | null, messageID?: string | null) {
    if (sessionID) this.currentSessionID = sessionID
    if (messageID) this.currentMessageID = messageID
  }

  emit(event: OtelEvent) {
    const { type, attrs: eventAttrs } = flattenEvent(event)
    this.enqueue(makeLogRecord(type, attrs({
      "session.id": this.currentSessionID,
      "message.id": this.currentMessageID,
      ...eventAttrs,
    })))
  }

  flush() {
    if (this.buffer.length === 0) return
    this.send(this.buffer.splice(0))
  }

  async drain() {
    this.flush()
    await Promise.all([...this.inflight])
  }

  async getModelCosts(): Promise<Map<string, ModelCost>> {
    if (this.modelCosts) return this.modelCosts
    this.modelCosts = new Map()
    try {
      const providers = await this.loadProviders()
      for (const provider of providers) {
        for (const [key, model] of Object.entries(provider.models)) {
          if (model.cost) {
            const entry: ModelCost = {
              input: model.cost.input,
              output: model.cost.output,
              cacheRead: model.cost.cache_read ?? 0,
              cacheWrite: model.cost.cache_write ?? 0,
            }
            // Store under both the map key (alias) and model.id (full ID)
            // so lookups work regardless of which form msg.modelID uses
            this.modelCosts.set(model.id, entry)
            if (key !== model.id) this.modelCosts.set(key, entry)
          }
        }
      }
    } catch {
      this.log("warn", "failed to load model costs")
    }
    return this.modelCosts
  }

  estimateCost(
    costs: Map<string, ModelCost>,
    modelID: string,
    tokens: Tokens,
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

  private enqueue(record: OtelLogRecord) {
    if (!this.logsUrl) return
    record.attributes.push(...attrs({ "event.sequence": this.sequence++ }))
    this.buffer.push(record)
    if (this.buffer.length >= 100) {
      this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flush()
      }, 5_000)
    }
  }

  private send(records: OtelLogRecord[]) {
    if (!this.logsUrl) return
    const p = fetch(this.logsUrl, {
      method: "POST",
      headers: this.headers,
      keepalive: true,
      body: JSON.stringify(buildExportRequest(this.resourceAttrs, records)),
    }).then((res) => {
      this.log("debug", `sent ${records.length} records — ${res.status}`)
    }).catch((err) => {
      this.log("error", `send failed: ${err}`)
    })
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p))
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

  const redactLevel: RedactLevel = config.redact ?? "full"

  await client.app.log({
    body: { service: "opencode-otel", level: "info", message: `enabled, endpoint=${config.endpoint ?? "none"}, redact=${redactLevel}` },
  })

  const gitInfo = await detectGitInfo(directory)

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

  const resourceAttrs: OtelResourceAttr[] = [
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

  const log: LogFn = (level, message) => {
    void client.app.log({
      body: { service: "opencode-otel", level, message },
    })
  }

  const ctx = new EmitContext({
    logsUrl: endpoint ? endpoint.replace(/\/$/, "") + "/v1/logs" : undefined,
    headers,
    resourceAttrs,
    redactLevel,
    log,
    loadProviders: async () => {
      const res = await client.provider.list()
      return res.data?.all ?? []
    },
  })

  // Git info uses rt() from the context for redaction
  if (gitInfo.remoteUrl) {
    resourceAttrs.push({
      key: "vcs.repository.url.full",
      value: { stringValue: ctx.rt(gitInfo.remoteUrl) },
    })
  }
  if (gitInfo.branch) {
    resourceAttrs.push({
      key: "vcs.ref.head.name",
      value: { stringValue: ctx.rt(gitInfo.branch) },
    })
  }
  if (gitInfo.commit) {
    resourceAttrs.push({
      key: "vcs.ref.head.revision",
      value: { stringValue: gitInfo.commit },
    })
  }

  const handlers = createHandlers(ctx)

  // Ensure buffered records are flushed before the process exits.
  // opencode may not await the plugin's event handler on session.idle
  // before disposing the instance, so drain() in the event hook can be
  // skipped. beforeExit fires when the event loop empties and gives us
  // a chance to flush synchronously (the fetch with keepalive: true
  // will outlive the process).
  process.on("beforeExit", () => {
    ctx.flush()
  })

  return {
    event: async ({ event }) => {
      const handler = handlers[event.type] as ((event: Event) => Promise<void> | void) | undefined
      if (handler) await handler(event)
      if (DRAIN_EVENTS.has(event.type)) await ctx.drain()
    },

    "tool.execute.after": async (input, output) => {
      ctx.track(input.sessionID)
      ctx.emit(toolExecuted({
        name: input.tool,
        callID: input.callID,
        title: ctx.rt(output.title),
        argsSize: safeStringifyLength(input.args),
        outputSize: output.output?.length,
        outputLines: output.output ? lineCount(output.output) : undefined,
        hasMetadata: output.metadata !== undefined && output.metadata !== null,
      }))
    },
  }
}
