import type { RedactLevel } from "./config.js"
import type { OtelEvent, Tokens } from "./events.js"
import { flattenEvent } from "./events.js"
import type { OtelLogRecord, OtelResourceAttr } from "./otel.js"
import { attrs, makeLogRecord, buildExportRequest } from "./otel.js"

const REDACTED = "<REDACTED>"

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogFn {
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
