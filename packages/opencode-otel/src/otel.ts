export type OtelAttr = { key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }

export type OtelResourceAttr = { key: string; value: { stringValue?: string; intValue?: number } }

export type AttrVal = string | number | boolean | undefined | null

export interface OtelLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: OtelAttr[]
}

export interface OtelExportLogsRequest {
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

export function attrs(obj: Record<string, AttrVal>): OtelAttr[] {
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

export function makeLogRecord(
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

export function buildExportRequest(
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

export function lineCount(text: string): number {
  if (text.length === 0) return 0
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}

export function safeStringifyLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value).length
  } catch {
    return undefined
  }
}

export function tokenAttrs(prefix: string, tokens: {
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
