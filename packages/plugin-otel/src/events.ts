// Typed event definitions and builder functions for all OTLP log records.
// Each builder returns a correctly-typed OtelEvent, ensuring emit() calls
// are fully type-checked at compile time.

import type { AttrVal } from "./otel.js"

// Shared input shapes

export interface SessionInput {
  id: string
  projectID: string
  parentID?: string
  title: string
  version: string
  summary?: { additions: number; deletions: number; files: number }
  share?: { url: string }
  time: { created: number; updated: number; compacting?: number }
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

// Attr interfaces

interface SessionFields {
  "session.id": string
  "session.project_id": string
  "session.title": string
  "session.version": string
  "session.time.created": number
  "session.time.updated": number
  "session.parent_id"?: string
  "session.time.compacting"?: number
  "session.summary.additions"?: number
  "session.summary.deletions"?: number
  "session.summary.files"?: number
  "session.share": boolean
}

interface SessionStatusAttrs {
  "session.status": string
  "retry.attempt"?: number
  "retry.next"?: number
}

interface SessionErrorAttrs {
  "error.name"?: string
  "error.provider_id"?: string
  "error.retryable"?: boolean
  "error.status_code"?: number
}

interface SessionDiffAttrs {
  "diff.files": number
  "diff.additions": number
  "diff.deletions": number
}

interface MessageUpdatedAssistantAttrs {
  "message.role": "assistant"
  "message.time.created": number
  "model.id": string
  "provider.id": string
  "message.mode": string
  "message.parent_id": string
  "message.finish"?: string
  "message.time.completed"?: number
  "message.duration_ms"?: number
  "message.summary"?: boolean
  "message.error.name"?: string
}

interface MessageUpdatedUserAttrs {
  "message.role": "user"
  "message.time.created": number
  "message.agent": string
  "message.model.id": string
  "message.model.provider_id": string
  "message.system.length"?: number
  "message.tools.count"?: number
  "message.summary.diffs"?: number
  "message.summary.additions"?: number
  "message.summary.deletions"?: number
}

interface PartBase {
  "part.id": string
  "part.type": string
  "delta.length"?: number
}

interface TextPartAttrs extends PartBase {
  "part.type": "text"
  "text.length": number
  "text.lines": number
  "text.synthetic"?: boolean
  "text.ignored"?: boolean
  "text.time.start"?: number
  "text.time.end"?: number
  "text.duration_ms"?: number
}

interface ReasoningPartAttrs extends PartBase {
  "part.type": "reasoning"
  "reasoning.length": number
  "reasoning.lines": number
  "reasoning.time.start": number
  "reasoning.time.end"?: number
  "reasoning.duration_ms"?: number
}

interface ToolPartRunningAttrs extends PartBase {
  "part.type": "tool"
  "tool.name": string
  "tool.call_id": string
  "tool.state": "running"
  "tool.input_size"?: number
  "tool.time.start": number
}

interface ToolPartCompletedAttrs extends PartBase {
  "part.type": "tool"
  "tool.name": string
  "tool.call_id": string
  "tool.state": "completed"
  "tool.input_size"?: number
  "tool.time.start": number
  "tool.time.end": number
  "tool.duration_ms": number
  "tool.success": true
  "tool.title": string
  "tool.output_size": number
  "tool.output_lines": number
  "tool.time.compacted"?: number
  "tool.attachments"?: number
}

interface ToolPartErrorAttrs extends PartBase {
  "part.type": "tool"
  "tool.name": string
  "tool.call_id": string
  "tool.state": "error"
  "tool.input_size"?: number
  "tool.time.start": number
  "tool.time.end": number
  "tool.duration_ms": number
  "tool.success": false
}

interface StepStartPartAttrs extends PartBase {
  "part.type": "step-start"
  "step.snapshot": boolean
}

interface StepFinishPartAttrs extends PartBase {
  "part.type": "step-finish"
  "step.reason": string
  "step.cost": number
  "step.snapshot": boolean
  "step.tokens.input": number
  "step.tokens.output": number
  "step.tokens.reasoning": number
  "step.tokens.cache.read": number
  "step.tokens.cache.write": number
}

interface SnapshotPartAttrs extends PartBase {
  "part.type": "snapshot"
  "snapshot.id": string
}

interface SubtaskPartAttrs extends PartBase {
  "part.type": "subtask"
  "subtask.agent": string
  "subtask.description": string
  "subtask.prompt.length": number
  "subtask.prompt.lines": number
}

interface AgentPartAttrs extends PartBase {
  "part.type": "agent"
  "agent.name": string
}

interface RetryPartAttrs extends PartBase {
  "part.type": "retry"
  "retry.attempt": number
  "retry.error.name": string
  "retry.error.status_code"?: number
  "retry.error.retryable"?: boolean
  "retry.time.created": number
}

interface CompactionPartAttrs extends PartBase {
  "part.type": "compaction"
  "compaction.auto": boolean
}

interface FilePartAttrs extends PartBase {
  "part.type": "file"
  "file.mime": string
  "file.name"?: string
  "file.source.type"?: string
  "file.source.length"?: number
  "file.source.lines"?: number
}

interface PatchPartAttrs extends PartBase {
  "part.type": "patch"
  "patch.hash": string
  "patch.files": number
}

type MessagePartAttrs =
  | TextPartAttrs
  | ReasoningPartAttrs
  | ToolPartRunningAttrs
  | ToolPartCompletedAttrs
  | ToolPartErrorAttrs
  | StepStartPartAttrs
  | StepFinishPartAttrs
  | SnapshotPartAttrs
  | SubtaskPartAttrs
  | AgentPartAttrs
  | RetryPartAttrs
  | CompactionPartAttrs
  | FilePartAttrs
  | PatchPartAttrs

interface UserPromptAttrs {
  "prompt.content": string
  "prompt.length": number
  "prompt.lines": number
}

interface ApiRequestAttrs {
  "message.id": string
  "model.id": string
  "provider.id": string
  "message.mode": string
  "cost": number
  "cost.estimated": boolean
  "duration_ms"?: number
  "finish": string
  "tokens.input": number
  "tokens.output": number
  "tokens.reasoning": number
  "tokens.cache.read": number
  "tokens.cache.write": number
}

interface CommandExecutedAttrs {
  "command.name": string
  "command.arguments": string
}

interface PermissionUpdatedAttrs {
  "permission.id": string
  "permission.type": string
  "permission.title": string
  "permission.time.created": number
  "permission.call_id"?: string
}

interface PermissionRepliedAttrs {
  "permission.id": string
  "permission.response"?: string
}

interface TodoUpdatedAttrs {
  "todo.count": number
  "todo.pending": number
  "todo.in_progress": number
  "todo.completed": number
  "todo.cancelled": number
  "todo.high": number
  "todo.medium": number
  "todo.low": number
}

interface VcsBranchUpdatedAttrs {
  "vcs.branch"?: string
}

interface ToolExecutedAttrs {
  "tool.name": string
  "tool.call_id": string
  "tool.title": string
  "tool.args_size"?: number
  "tool.output_size"?: number
  "tool.output_lines"?: number
  "tool.has_metadata": boolean
}

// Event interfaces

interface SessionCreatedEvent { type: "session.created"; attrs: SessionFields }
interface SessionUpdatedEvent { type: "session.updated"; attrs: SessionFields }
interface SessionDeletedEvent { type: "session.deleted"; attrs: SessionFields }
interface SessionIdleEvent { type: "session.idle"; attrs: Record<string, never> }
interface SessionCompactedEvent { type: "session.compacted"; attrs: Record<string, never> }
interface SessionStatusEvent { type: "session.status"; attrs: SessionStatusAttrs }
interface SessionErrorEvent { type: "session.error"; attrs: SessionErrorAttrs }
interface SessionDiffEvent { type: "session.diff"; attrs: SessionDiffAttrs }
interface MessageUpdatedEvent { type: "message.updated"; attrs: MessageUpdatedAssistantAttrs | MessageUpdatedUserAttrs }
interface MessageRemovedEvent { type: "message.removed"; attrs: Record<string, never> }
interface MessagePartUpdatedEvent { type: "message.part.updated"; attrs: MessagePartAttrs }
interface MessagePartRemovedEvent { type: "message.part.removed"; attrs: { "part.id": string } }
interface UserPromptEvent { type: "user.prompt"; attrs: UserPromptAttrs }
interface ApiRequestEvent { type: "api.request"; attrs: ApiRequestAttrs }
interface CommandExecutedEvent { type: "command.executed"; attrs: CommandExecutedAttrs }
interface FileEditedEvent { type: "file.edited"; attrs: Record<string, never> }
interface PermissionUpdatedEvent { type: "permission.updated"; attrs: PermissionUpdatedAttrs }
interface PermissionRepliedEvent { type: "permission.replied"; attrs: PermissionRepliedAttrs }
interface TodoUpdatedEvent { type: "todo.updated"; attrs: TodoUpdatedAttrs }
interface VcsBranchUpdatedEvent { type: "vcs.branch.updated"; attrs: VcsBranchUpdatedAttrs }
interface ToolExecutedEvent { type: "tool.executed"; attrs: ToolExecutedAttrs }

// Discriminated union

export type OtelEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | SessionIdleEvent
  | SessionCompactedEvent
  | SessionStatusEvent
  | SessionErrorEvent
  | SessionDiffEvent
  | MessageUpdatedEvent
  | MessageRemovedEvent
  | MessagePartUpdatedEvent
  | MessagePartRemovedEvent
  | UserPromptEvent
  | ApiRequestEvent
  | CommandExecutedEvent
  | FileEditedEvent
  | PermissionUpdatedEvent
  | PermissionRepliedEvent
  | TodoUpdatedEvent
  | VcsBranchUpdatedEvent
  | ToolExecutedEvent

// Flatten for OTLP pipeline
export function flattenEvent(event: OtelEvent): { type: string; attrs: Record<string, AttrVal> } {
  return { type: event.type, attrs: event.attrs as Record<string, AttrVal> }
}

// Builder: shared session fields
function sessionFields(
  rt: (v: string) => string,
  s: SessionInput,
): SessionFields {
  return {
    "session.id": s.id,
    "session.project_id": s.projectID,
    "session.title": rt(s.title),
    "session.version": s.version,
    "session.time.created": s.time.created,
    "session.time.updated": s.time.updated,
    "session.parent_id": s.parentID,
    "session.time.compacting": s.time.compacting,
    "session.summary.additions": s.summary?.additions,
    "session.summary.deletions": s.summary?.deletions,
    "session.summary.files": s.summary?.files,
    "session.share": s.share ? true : false,
  }
}

// Session lifecycle builders

export function sessionCreated(rt: (v: string) => string, s: SessionInput): SessionCreatedEvent {
  return { type: "session.created", attrs: sessionFields(rt, s) }
}

export function sessionUpdated(rt: (v: string) => string, s: SessionInput): SessionUpdatedEvent {
  return { type: "session.updated", attrs: sessionFields(rt, s) }
}

export function sessionDeleted(rt: (v: string) => string, s: SessionInput): SessionDeletedEvent {
  return { type: "session.deleted", attrs: sessionFields(rt, s) }
}

export function sessionIdle(): SessionIdleEvent {
  return { type: "session.idle", attrs: {} }
}

export function sessionCompacted(): SessionCompactedEvent {
  return { type: "session.compacted", attrs: {} }
}

export function sessionStatus(status: { type: string; attempt?: number; next?: number }): SessionStatusEvent {
  return {
    type: "session.status",
    attrs: {
      "session.status": status.type,
      ...(status.type === "retry" ? {
        "retry.attempt": status.attempt,
        "retry.next": status.next,
      } : {}),
    },
  }
}

export function sessionError(err?: {
  name: string
  data: Record<string, unknown>
}): SessionErrorEvent {
  return {
    type: "session.error",
    attrs: {
      "error.name": err?.name,
      "error.provider_id": err?.name === "ProviderAuthError" ? err.data.providerID as string : undefined,
      "error.retryable": err?.name === "APIError" ? err.data.isRetryable as boolean : undefined,
      "error.status_code": err?.name === "APIError" ? err.data.statusCode as number : undefined,
    },
  }
}

export function sessionDiff(diffs: Array<{ additions: number; deletions: number }>): SessionDiffEvent {
  return {
    type: "session.diff",
    attrs: {
      "diff.files": diffs.length,
      "diff.additions": diffs.reduce((sum, d) => sum + d.additions, 0),
      "diff.deletions": diffs.reduce((sum, d) => sum + d.deletions, 0),
    },
  }
}

// Message builders

export function messageUpdatedAssistant(msg: {
  time: { created: number; completed?: number }
  modelID: string
  providerID: string
  mode: string
  parentID: string
  finish?: string
  summary?: boolean
  error?: { name: string }
}): MessageUpdatedEvent {
  const duration = msg.time.completed !== undefined
    ? msg.time.completed - msg.time.created
    : undefined
  return {
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
  }
}

export function messageUpdatedUser(msg: {
  time: { created: number }
  agent: string
  model: { modelID: string; providerID: string }
  system?: string
  tools?: Record<string, unknown>
  summary?: { diffs?: Array<{ additions: number; deletions: number }> }
}): MessageUpdatedEvent {
  return {
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
      "message.summary.additions": msg.summary?.diffs?.reduce((sum, d) => sum + d.additions, 0),
      "message.summary.deletions": msg.summary?.diffs?.reduce((sum, d) => sum + d.deletions, 0),
    },
  }
}

export function messageRemoved(): MessageRemovedEvent {
  return { type: "message.removed", attrs: {} }
}

// Message part builders

interface PartInput {
  id: string
  deltaLength?: number
}

function partBase(p: PartInput): { "part.id": string; "delta.length"?: number } {
  return { "part.id": p.id, "delta.length": p.deltaLength }
}

export function textPart(p: PartInput & {
  length: number
  lines: number
  synthetic?: boolean
  ignored?: boolean
  time?: { start?: number; end?: number }
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "text",
      "text.length": p.length,
      "text.lines": p.lines,
      "text.synthetic": p.synthetic,
      "text.ignored": p.ignored,
      "text.time.start": p.time?.start,
      "text.time.end": p.time?.end,
      "text.duration_ms": p.time?.end !== undefined && p.time?.start !== undefined
        ? p.time.end - p.time.start
        : undefined,
    },
  }
}

export function reasoningPart(p: PartInput & {
  length: number
  lines: number
  time: { start: number; end?: number }
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "reasoning",
      "reasoning.length": p.length,
      "reasoning.lines": p.lines,
      "reasoning.time.start": p.time.start,
      "reasoning.time.end": p.time.end,
      "reasoning.duration_ms": p.time.end !== undefined
        ? p.time.end - p.time.start
        : undefined,
    },
  }
}

export function toolPartRunning(p: PartInput & {
  name: string
  callID: string
  inputSize?: number
  timeStart: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "tool",
      "tool.name": p.name,
      "tool.call_id": p.callID,
      "tool.state": "running",
      "tool.input_size": p.inputSize,
      "tool.time.start": p.timeStart,
    },
  }
}

export function toolPartCompleted(p: PartInput & {
  name: string
  callID: string
  inputSize?: number
  timeStart: number
  timeEnd: number
  title: string
  outputSize: number
  outputLines: number
  timeCompacted?: number
  attachments?: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "tool",
      "tool.name": p.name,
      "tool.call_id": p.callID,
      "tool.state": "completed",
      "tool.input_size": p.inputSize,
      "tool.time.start": p.timeStart,
      "tool.time.end": p.timeEnd,
      "tool.duration_ms": p.timeEnd - p.timeStart,
      "tool.success": true,
      "tool.title": p.title,
      "tool.output_size": p.outputSize,
      "tool.output_lines": p.outputLines,
      "tool.time.compacted": p.timeCompacted,
      "tool.attachments": p.attachments,
    },
  }
}

export function toolPartError(p: PartInput & {
  name: string
  callID: string
  inputSize?: number
  timeStart: number
  timeEnd: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "tool",
      "tool.name": p.name,
      "tool.call_id": p.callID,
      "tool.state": "error",
      "tool.input_size": p.inputSize,
      "tool.time.start": p.timeStart,
      "tool.time.end": p.timeEnd,
      "tool.duration_ms": p.timeEnd - p.timeStart,
      "tool.success": false,
    },
  }
}

export function stepStartPart(p: PartInput & {
  snapshot: boolean
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "step-start",
      "step.snapshot": p.snapshot,
    },
  }
}

export function stepFinishPart(p: PartInput & {
  reason: string
  cost: number
  snapshot: boolean
  tokens: Tokens
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "step-finish",
      "step.reason": p.reason,
      "step.cost": p.cost,
      "step.snapshot": p.snapshot,
      "step.tokens.input": p.tokens.input,
      "step.tokens.output": p.tokens.output,
      "step.tokens.reasoning": p.tokens.reasoning,
      "step.tokens.cache.read": p.tokens.cache.read,
      "step.tokens.cache.write": p.tokens.cache.write,
    },
  }
}

export function snapshotPart(p: PartInput & {
  snapshotID: string
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "snapshot",
      "snapshot.id": p.snapshotID,
    },
  }
}

export function subtaskPart(p: PartInput & {
  agent: string
  description: string
  promptLength: number
  promptLines: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "subtask",
      "subtask.agent": p.agent,
      "subtask.description": p.description,
      "subtask.prompt.length": p.promptLength,
      "subtask.prompt.lines": p.promptLines,
    },
  }
}

export function agentPart(p: PartInput & {
  name: string
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "agent",
      "agent.name": p.name,
    },
  }
}

export function retryPart(p: PartInput & {
  attempt: number
  errorName: string
  statusCode?: number
  retryable?: boolean
  timeCreated: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "retry",
      "retry.attempt": p.attempt,
      "retry.error.name": p.errorName,
      "retry.error.status_code": p.statusCode,
      "retry.error.retryable": p.retryable,
      "retry.time.created": p.timeCreated,
    },
  }
}

export function compactionPart(p: PartInput & {
  auto: boolean
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "compaction",
      "compaction.auto": p.auto,
    },
  }
}

export function filePart(p: PartInput & {
  mime: string
  name?: string
  sourceType?: string
  sourceLength?: number
  sourceLines?: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "file",
      "file.mime": p.mime,
      "file.name": p.name,
      "file.source.type": p.sourceType,
      "file.source.length": p.sourceLength,
      "file.source.lines": p.sourceLines,
    },
  }
}

export function patchPart(p: PartInput & {
  hash: string
  files: number
}): MessagePartUpdatedEvent {
  return {
    type: "message.part.updated",
    attrs: {
      ...partBase(p),
      "part.type": "patch",
      "patch.hash": p.hash,
      "patch.files": p.files,
    },
  }
}

export function messagePartRemoved(partID: string): MessagePartRemovedEvent {
  return { type: "message.part.removed", attrs: { "part.id": partID } }
}

// Synthetic event builders

export function userPrompt(content: string, length: number, lines: number): UserPromptEvent {
  return {
    type: "user.prompt",
    attrs: {
      "prompt.content": content,
      "prompt.length": length,
      "prompt.lines": lines,
    },
  }
}

export function apiRequest(msg: {
  id: string
  modelID: string
  providerID: string
  mode: string
  cost: number
  costEstimated: boolean
  tokens: Tokens
  durationMs?: number
  finish: string
}): ApiRequestEvent {
  return {
    type: "api.request",
    attrs: {
      "message.id": msg.id,
      "model.id": msg.modelID,
      "provider.id": msg.providerID,
      "message.mode": msg.mode,
      "cost": msg.cost,
      "cost.estimated": msg.costEstimated,
      "tokens.input": msg.tokens.input,
      "tokens.output": msg.tokens.output,
      "tokens.reasoning": msg.tokens.reasoning,
      "tokens.cache.read": msg.tokens.cache.read,
      "tokens.cache.write": msg.tokens.cache.write,
      "duration_ms": msg.durationMs,
      "finish": msg.finish,
    },
  }
}

// Command / file builders

export function commandExecuted(name: string, args: string): CommandExecutedEvent {
  return {
    type: "command.executed",
    attrs: { "command.name": name, "command.arguments": args },
  }
}

export function fileEdited(): FileEditedEvent {
  return { type: "file.edited", attrs: {} }
}

// Permission builders

export function permissionUpdated(p: {
  id: string
  type: string
  title: string
  timeCreated: number
  callID?: string
}): PermissionUpdatedEvent {
  return {
    type: "permission.updated",
    attrs: {
      "permission.id": p.id,
      "permission.type": p.type,
      "permission.title": p.title,
      "permission.time.created": p.timeCreated,
      "permission.call_id": p.callID,
    },
  }
}

export function permissionReplied(id: string, response?: string): PermissionRepliedEvent {
  return {
    type: "permission.replied",
    attrs: { "permission.id": id, "permission.response": response },
  }
}

// Todo builder

export function todoUpdated(todos: Array<{ status: string; priority: string }>): TodoUpdatedEvent {
  const statusCounts: Record<string, number> = {}
  const priorityCounts: Record<string, number> = {}
  for (const todo of todos) {
    statusCounts[todo.status] = (statusCounts[todo.status] ?? 0) + 1
    priorityCounts[todo.priority] = (priorityCounts[todo.priority] ?? 0) + 1
  }
  return {
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
  }
}

// VCS builder

export function vcsBranchUpdated(branch?: string): VcsBranchUpdatedEvent {
  return { type: "vcs.branch.updated", attrs: { "vcs.branch": branch } }
}

// Tool execution hook builder (used from index.ts)

export function toolExecuted(p: {
  name: string
  callID: string
  title: string
  argsSize?: number
  outputSize?: number
  outputLines?: number
  hasMetadata: boolean
}): ToolExecutedEvent {
  return {
    type: "tool.executed",
    attrs: {
      "tool.name": p.name,
      "tool.call_id": p.callID,
      "tool.title": p.title,
      "tool.args_size": p.argsSize,
      "tool.output_size": p.outputSize,
      "tool.output_lines": p.outputLines,
      "tool.has_metadata": p.hasMetadata,
    },
  }
}
