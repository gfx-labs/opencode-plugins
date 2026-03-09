import type { Event } from "@opencode-ai/sdk"
import type { EmitContext } from "./context.js"
import {
  sessionCreated, sessionUpdated, sessionDeleted, sessionIdle,
  sessionCompacted, sessionStatus, sessionError, sessionDiff,
  messageUpdatedAssistant, messageUpdatedUser, messageRemoved,
  textPart, reasoningPart, toolPartRunning, toolPartCompleted,
  toolPartError, stepStartPart, stepFinishPart, snapshotPart,
  subtaskPart, agentPart, retryPart, compactionPart, filePart,
  patchPart, messagePartRemoved, userPrompt, apiRequest,
  commandExecuted, fileEdited, permissionUpdated, permissionReplied,
  todoUpdated, vcsBranchUpdated,
} from "./events.js"
import { lineCount, safeStringifyLength } from "./otel.js"

type EventType = Event["type"]
type EventFor<T extends EventType> = Extract<Event, { type: T }>
type EventHandler<T extends EventType> = (event: EventFor<T>) => Promise<void> | void
type EventHandlers = { [T in EventType]?: EventHandler<T> }

function handlePartUpdated(ctx: EmitContext, part: EventFor<"message.part.updated">["properties"]["part"], delta: string | undefined) {
  const deltaLength = delta?.length

  switch (part.type) {
    case "text":
      ctx.emit(textPart({
        id: part.id,
        deltaLength,
        length: part.text.length,
        lines: lineCount(part.text),
        synthetic: part.synthetic,
        ignored: part.ignored,
        time: part.time,
      }))
      // Buffer text content for potential user.prompt emission.
      // pendingTextParts doubles as a "seen" guard: once set for a
      // messageID, duplicate deliveries of the same part are skipped.
      // Emission happens from whichever of message.updated or
      // message.part.updated arrives second (when both role and
      // text content are known). The entry is never deleted so
      // subsequent duplicate deliveries remain no-ops.
      if (!ctx.pendingTextParts.has(part.messageID)) {
        ctx.pendingTextParts.set(part.messageID, {
          sessionID: part.sessionID,
          content: part.text,
          length: part.text.length,
          lines: lineCount(part.text),
        })
        // If we already know this is a user message, emit now
        if (ctx.userMessages.has(part.messageID) && !ctx.childSessions.has(part.sessionID)) {
          ctx.emit(userPrompt(ctx.rt(part.text), part.text.length, lineCount(part.text)))
          ctx.flush()
        }
      }
      break
    case "reasoning":
      ctx.emit(reasoningPart({
        id: part.id,
        deltaLength,
        length: part.text.length,
        lines: lineCount(part.text),
        time: part.time,
      }))
      break
    case "tool": {
      const state = part.state
      const inputSize = safeStringifyLength(state.input)
      switch (state.status) {
        case "running":
          ctx.emit(toolPartRunning({
            id: part.id,
            deltaLength,
            name: ctx.rs(part.tool),
            callID: part.callID,
            inputSize,
            timeStart: state.time.start,
          }))
          break
        case "completed":
          ctx.emit(toolPartCompleted({
            id: part.id,
            deltaLength,
            name: ctx.rs(part.tool),
            callID: part.callID,
            inputSize,
            timeStart: state.time.start,
            timeEnd: state.time.end,
            title: ctx.rt(state.title),
            outputSize: state.output.length,
            outputLines: lineCount(state.output),
            timeCompacted: state.time.compacted,
            attachments: state.attachments?.length,
          }))
          break
        case "error":
          ctx.emit(toolPartError({
            id: part.id,
            deltaLength,
            name: ctx.rs(part.tool),
            callID: part.callID,
            inputSize,
            timeStart: state.time.start,
            timeEnd: state.time.end,
          }))
          break
      }
      break
    }
    case "step-start":
      ctx.emit(stepStartPart({
        id: part.id,
        deltaLength,
        snapshot: part.snapshot ? true : false,
      }))
      break
    case "step-finish":
      ctx.emit(stepFinishPart({
        id: part.id,
        deltaLength,
        reason: part.reason,
        cost: part.cost,
        snapshot: part.snapshot ? true : false,
        tokens: part.tokens,
      }))
      break
    case "snapshot":
      ctx.emit(snapshotPart({
        id: part.id,
        deltaLength,
        snapshotID: part.snapshot,
      }))
      break
    case "subtask":
      ctx.emit(subtaskPart({
        id: part.id,
        deltaLength,
        agent: part.agent,
        description: ctx.rt(part.description),
        promptLength: part.prompt.length,
        promptLines: lineCount(part.prompt),
      }))
      break
    case "agent":
      ctx.emit(agentPart({
        id: part.id,
        deltaLength,
        name: part.name,
      }))
      break
    case "retry":
      ctx.emit(retryPart({
        id: part.id,
        deltaLength,
        attempt: part.attempt,
        errorName: part.error.name,
        // retry error message is runtime content — never sent
        statusCode: part.error.data.statusCode,
        retryable: part.error.data.isRetryable,
        timeCreated: part.time.created,
      }))
      break
    case "compaction":
      ctx.emit(compactionPart({
        id: part.id,
        deltaLength,
        auto: part.auto,
      }))
      break
    case "file":
      ctx.emit(filePart({
        id: part.id,
        deltaLength,
        mime: part.mime,
        name: part.filename ? ctx.rt(part.filename) : undefined,
        sourceType: part.source?.type,
        sourceLength: part.source?.text.value.length,
        sourceLines: part.source ? part.source.text.end - part.source.text.start : undefined,
      }))
      break
    case "patch":
      ctx.emit(patchPart({
        id: part.id,
        deltaLength,
        hash: part.hash,
        files: part.files.length,
      }))
      break
  }
}

export const DRAIN_EVENTS = new Set<EventType>(["session.idle", "session.deleted", "session.error"])

export function createHandlers(ctx: EmitContext): EventHandlers {
  // Dedup synthetic events — opencode may deliver the same event multiple times
  const emittedApiRequests = new Set<string>()

  return {
    "session.created": (event) => {
      ctx.track(event.properties.info.id)
      if (event.properties.info.parentID) ctx.childSessions.add(event.properties.info.id)
      ctx.emit(sessionCreated(ctx.rt, event.properties.info))
    },
    "session.updated": (event) => {
      ctx.track(event.properties.info.id)
      ctx.emit(sessionUpdated(ctx.rt, event.properties.info))
    },
    "session.deleted": (event) => {
      ctx.track(event.properties.info.id)
      ctx.emit(sessionDeleted(ctx.rt, event.properties.info))
    },
    "session.idle": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(sessionIdle())
    },
    "session.compacted": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(sessionCompacted())
    },
    "session.status": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(sessionStatus(event.properties.status))
      // Flush at status transitions — ensures records are sent before
      // the user's turn or before the process might exit
      ctx.flush()
    },
    "session.error": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(sessionError(event.properties.error))
    },
    "session.diff": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(sessionDiff(event.properties.diff))
    },
    "message.updated": async (event) => {
      const msg = event.properties.info
      ctx.track(msg.sessionID, msg.id)
      if (msg.role === "assistant") {
        ctx.emit(messageUpdatedAssistant(msg))
      } else {
        ctx.emit(messageUpdatedUser(msg))
      }
      if (msg.role === "user" && !ctx.userMessages.has(msg.id)) {
        ctx.userMessages.add(msg.id)
        const pending = ctx.pendingTextParts.get(msg.id)
        if (pending && !ctx.childSessions.has(pending.sessionID)) {
          ctx.emit(userPrompt(ctx.rt(pending.content), pending.length, pending.lines))
          ctx.flush()
        }
      }
      if (msg.role === "assistant" && msg.finish && !emittedApiRequests.has(msg.id)) {
        emittedApiRequests.add(msg.id)
        let effectiveCost = msg.cost
        // Only estimate cost for Anthropic models — other providers either
        // report cost accurately or are subscription plans where $0 is correct
        if (!effectiveCost && msg.providerID === "anthropic") {
          const costs = await ctx.getModelCosts()
          effectiveCost = ctx.estimateCost(costs, msg.modelID, msg.tokens) ?? 0
        }
        const duration = msg.time.completed !== undefined
          ? msg.time.completed - msg.time.created
          : undefined
        ctx.emit(apiRequest({
          id: msg.id,
          modelID: msg.modelID,
          providerID: msg.providerID,
          mode: msg.mode,
          cost: effectiveCost,
          costEstimated: msg.cost === 0,
          tokens: msg.tokens,
          durationMs: duration,
          finish: msg.finish,
        }))
      }
    },
    "message.part.updated": (event) => {
      const part = event.properties.part
      ctx.track(part.sessionID, part.messageID)
      handlePartUpdated(ctx, part, event.properties.delta)
    },
    "message.removed": (event) => {
      ctx.track(event.properties.sessionID, event.properties.messageID)
      ctx.emit(messageRemoved())
    },
    "message.part.removed": (event) => {
      ctx.track(event.properties.sessionID, event.properties.messageID)
      ctx.emit(messagePartRemoved(event.properties.partID))
    },
    "command.executed": (event) => {
      ctx.track(event.properties.sessionID, event.properties.messageID)
      ctx.emit(commandExecuted(event.properties.name, ctx.rs(event.properties.arguments)))
    },
    "file.edited": () => {
      ctx.emit(fileEdited())
    },
    "permission.updated": (event) => {
      const perm = event.properties
      ctx.track(perm.sessionID, perm.messageID)
      ctx.emit(permissionUpdated({
        id: perm.id,
        type: perm.type,
        title: ctx.rt(perm.title),
        timeCreated: perm.time.created,
        callID: perm.callID,
      }))
    },
    "permission.replied": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(permissionReplied(event.properties.permissionID, event.properties.response))
    },
    "todo.updated": (event) => {
      ctx.track(event.properties.sessionID)
      ctx.emit(todoUpdated(event.properties.todos))
    },
    "vcs.branch.updated": (event) => {
      ctx.emit(vcsBranchUpdated(event.properties.branch ? ctx.rt(event.properties.branch) : undefined))
    },
  }
}
