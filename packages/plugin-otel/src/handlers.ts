import type { Event } from "@opencode-ai/sdk"
import type { OtelEvent } from "./events.js"
import { sessionFields, tokenFields } from "./events.js"
import { lineCount, safeStringifyLength } from "./otel.js"

type EventType = Event["type"]
type EventFor<T extends EventType> = Extract<Event, { type: T }>
type EventHandler<T extends EventType> = (event: EventFor<T>) => Promise<void> | void
type EventHandlers = { [T in EventType]?: EventHandler<T> }

export interface HandlerContext {
  track: (sessionID?: string | null, messageID?: string | null) => void
  emit: (event: OtelEvent) => void
  flush: () => void
  // Redact titles, descriptions, session names — applies at light + full levels
  rt: (value: string) => string
  // Redact structural metadata (VCS info, tool names, command args, file names) — applies at full level only
  rs: (value: string) => string
  userMessages: Set<string>
  childSessions: Set<string>
  pendingTextParts: Map<string, { sessionID: string; content: string; length: number; lines: number }>
  getModelCosts: () => Promise<Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>>
  estimateCost: (
    costs: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>,
    modelID: string,
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  ) => number | undefined
}

function handlePartUpdated(ctx: HandlerContext, part: EventFor<"message.part.updated">["properties"]["part"], delta: string | undefined) {
  const { emit, rt, rs, pendingTextParts } = ctx

  const base = {
    "part.id": part.id,
    "delta.length": delta?.length,
  } as const

  switch (part.type) {
    case "text":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "text",
          "text.length": part.text.length,
          "text.lines": lineCount(part.text),
          "text.synthetic": part.synthetic,
          "text.ignored": part.ignored,
          "text.time.start": part.time?.start,
          "text.time.end": part.time?.end,
          "text.duration_ms": part.time?.end !== undefined && part.time?.start !== undefined
            ? part.time.end - part.time.start
            : undefined,
        },
      })
      // Buffer text content for potential user.prompt emission.
      // pendingTextParts doubles as a "seen" guard: once set for a
      // messageID, duplicate deliveries of the same part are skipped.
      // Emission happens from whichever of message.updated or
      // message.part.updated arrives second (when both role and
      // text content are known). The entry is never deleted so
      // subsequent duplicate deliveries remain no-ops.
      if (!pendingTextParts.has(part.messageID)) {
        pendingTextParts.set(part.messageID, {
          sessionID: part.sessionID,
          content: part.text,
          length: part.text.length,
          lines: lineCount(part.text),
        })
        // If we already know this is a user message, emit now
        if (ctx.userMessages.has(part.messageID) && !ctx.childSessions.has(part.sessionID)) {
          emit({
            type: "user.prompt",
            attrs: {
              "prompt.content": rt(part.text),
              "prompt.length": part.text.length,
              "prompt.lines": lineCount(part.text),
            },
          })
          ctx.flush()
        }
      }
      break
    case "reasoning":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "reasoning",
          "reasoning.length": part.text.length,
          "reasoning.lines": lineCount(part.text),
          "reasoning.time.start": part.time.start,
          "reasoning.time.end": part.time.end,
          "reasoning.duration_ms": part.time.end !== undefined
            ? part.time.end - part.time.start
            : undefined,
        },
      })
      break
    case "tool": {
      const state = part.state
      const toolBase = {
        ...base,
        "part.type": "tool" as const,
        "tool.name": rs(part.tool),
        "tool.call_id": part.callID,
        "tool.input_size": safeStringifyLength(state.input),
      }
      switch (state.status) {
        case "running":
          emit({
            type: "message.part.updated",
            attrs: {
              ...toolBase,
              "tool.state": "running",
              "tool.time.start": state.time.start,
            },
          })
          break
        case "completed":
          emit({
            type: "message.part.updated",
            attrs: {
              ...toolBase,
              "tool.state": "completed",
              "tool.time.start": state.time.start,
              "tool.time.end": state.time.end,
              "tool.duration_ms": state.time.end - state.time.start,
              "tool.success": true,
              "tool.title": rt(state.title),
              "tool.output_size": state.output.length,
              "tool.output_lines": lineCount(state.output),
              "tool.time.compacted": state.time.compacted,
              "tool.attachments": state.attachments?.length,
            },
          })
          break
        case "error":
          emit({
            type: "message.part.updated",
            attrs: {
              ...toolBase,
              "tool.state": "error",
              "tool.time.start": state.time.start,
              "tool.time.end": state.time.end,
              "tool.duration_ms": state.time.end - state.time.start,
              "tool.success": false,
            },
          })
          break
      }
      break
    }
    case "step-start":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "step-start",
          "step.snapshot": part.snapshot ? true : false,
        },
      })
      break
    case "step-finish":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "step-finish",
          "step.reason": part.reason,
          "step.cost": part.cost,
          "step.snapshot": part.snapshot ? true : false,
          ...tokenFields("step.tokens", part.tokens),
        },
      })
      break
    case "snapshot":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "snapshot",
          "snapshot.id": part.snapshot,
        },
      })
      break
    case "subtask":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "subtask",
          "subtask.agent": part.agent,
          "subtask.description": rt(part.description),
          "subtask.prompt.length": part.prompt.length,
          "subtask.prompt.lines": lineCount(part.prompt),
        },
      })
      break
    case "agent":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "agent",
          "agent.name": part.name,
        },
      })
      break
    case "retry":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "retry",
          "retry.attempt": part.attempt,
          "retry.error.name": part.error.name,
          // retry error message is runtime content — never sent
          "retry.error.status_code": part.error.data.statusCode,
          "retry.error.retryable": part.error.data.isRetryable,
          "retry.time.created": part.time.created,
        },
      })
      break
    case "compaction":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "compaction",
          "compaction.auto": part.auto,
        },
      })
      break
    case "file":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "file",
          "file.mime": part.mime,
          "file.name": part.filename ? rt(part.filename) : undefined,
          "file.source.type": part.source?.type,
          "file.source.length": part.source?.text.value.length,
          "file.source.lines": part.source ? part.source.text.end - part.source.text.start : undefined,
        },
      })
      break
    case "patch":
      emit({
        type: "message.part.updated",
        attrs: {
          ...base,
          "part.type": "patch",
          "patch.hash": part.hash,
          "patch.files": part.files.length,
        },
      })
      break
  }
}

export const DRAIN_EVENTS = new Set<EventType>(["session.idle", "session.deleted", "session.error"])

export function createHandlers(ctx: HandlerContext): EventHandlers {
  const { track, emit, rt, rs, userMessages, pendingTextParts, getModelCosts, estimateCost } = ctx
  // Dedup synthetic events — opencode may deliver the same event multiple times
  const emittedApiRequests = new Set<string>()

  return {
    "session.created": (event) => {
      track(event.properties.info.id)
      if (event.properties.info.parentID) ctx.childSessions.add(event.properties.info.id)
      emit({ type: "session.created", attrs: sessionFields(rt, event.properties.info) })
    },
    "session.updated": (event) => {
      track(event.properties.info.id)
      emit({ type: "session.updated", attrs: sessionFields(rt, event.properties.info) })
    },
    "session.deleted": (event) => {
      track(event.properties.info.id)
      emit({ type: "session.deleted", attrs: sessionFields(rt, event.properties.info) })
    },
    "session.idle": (event) => {
      track(event.properties.sessionID)
      emit({ type: "session.idle", attrs: {} })
    },
    "session.compacted": (event) => {
      track(event.properties.sessionID)
      emit({ type: "session.compacted", attrs: {} })
    },
    "session.status": (event) => {
      track(event.properties.sessionID)
      const status = event.properties.status
      emit({
        type: "session.status",
        attrs: {
          "session.status": status.type,
          ...(status.type === "retry" ? {
            "retry.attempt": status.attempt,
            // retry message is runtime content — never sent
            "retry.next": status.next,
          } : {}),
        },
      })
      // Flush at status transitions — ensures records are sent before
      // the user's turn or before the process might exit
      ctx.flush()
    },
    "session.error": (event) => {
      track(event.properties.sessionID)
      const err = event.properties.error
      emit({
        type: "session.error",
        attrs: {
          "error.name": err?.name,
          // error message is runtime content — never sent
          "error.provider_id": err?.name === "ProviderAuthError" ? err.data.providerID : undefined,
          "error.retryable": err?.name === "APIError" ? err.data.isRetryable : undefined,
          "error.status_code": err?.name === "APIError" ? err.data.statusCode : undefined,
        },
      })
    },
    "session.diff": (event) => {
      track(event.properties.sessionID)
      const diffs = event.properties.diff
      emit({
        type: "session.diff",
        attrs: {
          "diff.files": diffs.length,
          "diff.additions": diffs.reduce((sum, d) => sum + d.additions, 0),
          "diff.deletions": diffs.reduce((sum, d) => sum + d.deletions, 0),
        },
      })
    },
    "message.updated": async (event) => {
      const msg = event.properties.info
      track(msg.sessionID, msg.id)
      const duration = msg.role === "assistant" && msg.time.completed !== undefined
        ? msg.time.completed - msg.time.created
        : undefined
      if (msg.role === "assistant") {
        emit({
          type: "message.updated",
          attrs: {
            "message.role": "assistant",
            "message.time.created": msg.time.created,
            "model.id": msg.modelID,
            "provider.id": msg.providerID,
            "message.mode": msg.mode,
            "message.parent_id": msg.parentID,
            "message.finish": msg.finish,
            "message.time.completed": msg.time.completed,
            "message.duration_ms": duration,
            "message.summary": msg.summary,
            "message.error.name": msg.error?.name,
          },
        })
      } else {
        emit({
          type: "message.updated",
          attrs: {
            "message.role": "user",
            "message.time.created": msg.time.created,
            "message.agent": msg.agent,
            "message.model.id": msg.model.modelID,
            "message.model.provider_id": msg.model.providerID,
            "message.system.length": msg.system?.length,
            "message.tools.count": msg.tools ? Object.keys(msg.tools).length : undefined,
            "message.summary.diffs": msg.summary?.diffs?.length,
            "message.summary.additions": msg.summary?.diffs?.reduce((sum: number, d: { additions: number }) => sum + d.additions, 0),
            "message.summary.deletions": msg.summary?.diffs?.reduce((sum: number, d: { deletions: number }) => sum + d.deletions, 0),
          },
        })
      }
      if (msg.role === "user" && !userMessages.has(msg.id)) {
        userMessages.add(msg.id)
        const pending = pendingTextParts.get(msg.id)
        if (pending && !ctx.childSessions.has(pending.sessionID)) {
          emit({
            type: "user.prompt",
            attrs: {
              "prompt.content": rt(pending.content),
              "prompt.length": pending.length,
              "prompt.lines": pending.lines,
            },
          })
          ctx.flush()
        }
      }
      if (msg.role === "assistant" && msg.finish && !emittedApiRequests.has(msg.id)) {
        emittedApiRequests.add(msg.id)
        let effectiveCost = msg.cost
        // Only estimate cost for Anthropic models — other providers either
        // report cost accurately or are subscription plans where $0 is correct
        if (!effectiveCost && msg.providerID === "anthropic") {
          const costs = await getModelCosts()
          effectiveCost = estimateCost(costs, msg.modelID, msg.tokens) ?? 0
        }
        emit({
          type: "api.request",
          attrs: {
            "message.id": msg.id,
            "model.id": msg.modelID,
            "provider.id": msg.providerID,
            "message.mode": msg.mode,
            "cost": effectiveCost,
            "cost.estimated": msg.cost === 0,
            ...tokenFields("tokens", msg.tokens),
            "duration_ms": duration,
            "finish": msg.finish,
          },
        })
      }
    },
    "message.part.updated": (event) => {
      const part = event.properties.part
      track(part.sessionID, part.messageID)
      handlePartUpdated(ctx, part, event.properties.delta)
    },
    "message.removed": (event) => {
      track(event.properties.sessionID, event.properties.messageID)
      emit({ type: "message.removed", attrs: {} })
    },
    "message.part.removed": (event) => {
      track(event.properties.sessionID, event.properties.messageID)
      emit({
        type: "message.part.removed",
        attrs: { "part.id": event.properties.partID },
      })
    },
    "command.executed": (event) => {
      track(event.properties.sessionID, event.properties.messageID)
      emit({
        type: "command.executed",
        attrs: {
          "command.name": event.properties.name,
          "command.arguments": rs(event.properties.arguments),
        },
      })
    },
    "file.edited": () => {
      emit({ type: "file.edited", attrs: {} })
    },
    "permission.updated": (event) => {
      const perm = event.properties
      track(perm.sessionID, perm.messageID)
      emit({
        type: "permission.updated",
        attrs: {
          "permission.id": perm.id,
          "permission.type": perm.type,
          "permission.title": rt(perm.title),
          "permission.time.created": perm.time.created,
          "permission.call_id": perm.callID,
        },
      })
    },
    "permission.replied": (event) => {
      track(event.properties.sessionID)
      emit({
        type: "permission.replied",
        attrs: {
          "permission.id": event.properties.permissionID,
          "permission.response": event.properties.response,
        },
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
      emit({
        type: "todo.updated",
        attrs: {
          "todo.count": todos.length,
          "todo.pending": statusCounts["pending"] ?? 0,
          "todo.in_progress": statusCounts["in_progress"] ?? 0,
          "todo.completed": statusCounts["completed"] ?? 0,
          "todo.cancelled": statusCounts["cancelled"] ?? 0,
          "todo.high": priorityCounts["high"] ?? 0,
          "todo.medium": priorityCounts["medium"] ?? 0,
          "todo.low": priorityCounts["low"] ?? 0,
        },
      })
    },
    "vcs.branch.updated": (event) => {
      emit({
        type: "vcs.branch.updated",
        attrs: {
          "vcs.branch": event.properties.branch ? rt(event.properties.branch) : undefined,
        },
      })
    },
  }
}
