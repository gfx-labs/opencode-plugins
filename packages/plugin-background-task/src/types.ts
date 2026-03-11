import type { createOpencodeClient } from "@opencode-ai/sdk"

export type OpencodeClient = ReturnType<typeof createOpencodeClient>

export interface Delegation {
  id: string
  sessionID: string
  parentSessionID: string
  parentMessageID: string
  parentAgent: string
  prompt: string
  agent: string
  status: "running" | "complete" | "error" | "cancelled" | "timeout"
  startedAt: Date
  completedAt?: Date
  progress: DelegationProgress
  error?: string
  title?: string
  description?: string
  result?: string
}

export interface DelegationProgress {
  toolCalls: number
  lastUpdate: Date
  lastMessage?: string
  lastMessageAt?: Date
}

export interface DelegationListItem {
  id: string
  status: string
  title?: string
  description?: string
  agent?: string
}

export interface DelegateInput {
  parentSessionID: string
  parentMessageID: string
  parentAgent: string
  prompt: string
  agent: string
}

export interface GeneratedMetadata {
  title: string
  description: string
}

type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug: (msg: string) => void
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export function createLogger(client: OpencodeClient): Logger {
  const log = (level: LogLevel, message: string) =>
    void client.app.log({ body: { service: "background-task", level, message } }).catch(() => {})
  return {
    debug: (msg: string) => log("debug", msg),
    info: (msg: string) => log("info", msg),
    warn: (msg: string) => log("warn", msg),
    error: (msg: string) => log("error", msg),
  }
}
