import type { Event } from "@opencode-ai/sdk"
import type { AttrVal } from "./otel.js"
import { lineCount, safeStringifyLength, tokenAttrs } from "./otel.js"

type EventType = Event["type"]
type EventFor<T extends EventType> = Extract<Event, { type: T }>
type EventHandler<T extends EventType> = (event: EventFor<T>) => Promise<void> | void
type EventHandlers = { [T in EventType]?: EventHandler<T> }

export interface HandlerContext {
  track: (sessionID?: string | null, messageID?: string | null) => void
  emit: (eventType: string, eventAttrs: Record<string, AttrVal>) => void
  // Redact titles, descriptions, session names — applies at light + full levels
  rt: (value: string) => string
  // Redact structural metadata (VCS info, tool names, command args, file names) — applies at full level only
  rs: (value: string) => string
  userMessages: Set<string>
  pendingTextParts: Map<string, { sessionID: string; content: string; length: number; lines: number }>
  getModelCosts: () => Promise<Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>>
  estimateCost: (
    costs: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>,
    modelID: string,
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  ) => number | undefined
}

function sessionFields(
  rt: (value: string) => string,
  session: {
    id: string
    projectID: string
    parentID?: string
    title: string
    version: string
    summary?: { additions: number; deletions: number; files: number }
    share?: { url: string }
    time: { created: number; updated: number; compacting?: number }
  },
): Record<string, AttrVal> {
  return {
    "session.id": session.id,
    "session.project_id": session.projectID,
    "session.title": rt(session.title),
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

function handlePartUpdated(ctx: HandlerContext, part: EventFor<"message.part.updated">["properties"]["part"], delta: string | undefined) {
  const { emit, rt, rs, userMessages, pendingTextParts } = ctx
  const base: Record<string, AttrVal> = {
    "part.id": part.id,
    "part.type": part.type,
    "delta.length": delta?.length,
  }
  let extra: Record<string, AttrVal> = {}
  switch (part.type) {
    case "text":
      // LLM content is never sent — only structural metrics
      extra = {
        "text.length": part.text.length,
        "text.lines": lineCount(part.text),
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
          "prompt.content": rt(part.text),
          "prompt.length": part.text.length,
          "prompt.lines": lineCount(part.text),
        })
      } else if (!pendingTextParts.has(part.messageID)) {
        pendingTextParts.set(part.messageID, {
          sessionID: part.sessionID,
          content: part.text,
          length: part.text.length,
          lines: lineCount(part.text),
        })
      }
      break
    case "reasoning":
      // LLM content is never sent — only structural metrics
      extra = {
        "reasoning.length": part.text.length,
        "reasoning.lines": lineCount(part.text),
        "reasoning.time.start": part.time.start,
        "reasoning.time.end": part.time.end,
        "reasoning.duration_ms": part.time.end !== undefined
          ? part.time.end - part.time.start
          : undefined,
      }
      break
    case "tool": {
      extra = {
        "tool.name": rs(part.tool),
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
          extra["tool.title"] = rt(state.title)
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
          // tool error text is LLM/runtime content — never sent
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
        "subtask.description": rt(part.description),
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
        // retry error message is runtime content — never sent
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
        "file.name": part.filename ? rt(part.filename) : undefined,
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

export const DRAIN_EVENTS = new Set<EventType>(["session.idle", "session.deleted", "session.error"])

export function createHandlers(ctx: HandlerContext): EventHandlers {
  const { track, emit, rt, rs, userMessages, pendingTextParts, getModelCosts, estimateCost } = ctx
  // Dedup synthetic events — opencode may deliver the same event multiple times
  const emittedApiRequests = new Set<string>()
  const emittedUserPrompts = new Set<string>()

  return {
    "session.created": (event) => {
      track(event.properties.info.id)
      emit("session.created", sessionFields(rt, event.properties.info))
    },
    "session.updated": (event) => {
      track(event.properties.info.id)
      emit("session.updated", sessionFields(rt, event.properties.info))
    },
    "session.deleted": (event) => {
      track(event.properties.info.id)
      emit("session.deleted", sessionFields(rt, event.properties.info))
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
          // retry message is runtime content — never sent
          "retry.next": status.next,
        } : {}),
      })
    },
    "session.error": (event) => {
      track(event.properties.sessionID)
      const err = event.properties.error
      emit("session.error", {
        "error.name": err?.name,
        // error message is runtime content — never sent
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
          "message.finish": msg.finish,
          "message.time.completed": msg.time.completed,
          "message.duration_ms": duration,
          "message.summary": msg.summary,
          "message.error.name": msg.error?.name,
          // cost and tokens live on api.request only
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
            "prompt.content": rt(pending.content),
            "prompt.length": pending.length,
            "prompt.lines": pending.lines,
          })
        }
      }
      if (msg.role === "assistant" && msg.finish && !emittedApiRequests.has(msg.id)) {
        emittedApiRequests.add(msg.id)
        let effectiveCost = msg.cost
        if (!effectiveCost) {
          const costs = await getModelCosts()
          effectiveCost = estimateCost(costs, msg.modelID, msg.tokens) ?? 0
        }
        emit("api.request", {
          "message.id": msg.id,
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
      handlePartUpdated(ctx, part, event.properties.delta)
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
        "command.arguments": rs(event.properties.arguments),
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
        "permission.title": rt(perm.title),
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
        "vcs.branch": event.properties.branch ? rt(event.properties.branch) : undefined,
      })
    },
  }
}
