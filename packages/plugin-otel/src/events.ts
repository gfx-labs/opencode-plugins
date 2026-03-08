// Typed event definitions for all OTLP log records emitted by the plugin.
// Each interface defines the exact attributes for one event type.
// The OtelEvent discriminated union ensures emit() calls are type-checked.

import type { AttrVal } from "./otel.js"

// Shared shapes used across multiple events

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

interface TokenFields {
  input: number
  output: number
  reasoning: number
  "cache.read": number
  "cache.write": number
}

// Prefix token fields with a given prefix (e.g. "tokens" or "step.tokens").
// This is applied at emit time via flattenTokens().
export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

// Session lifecycle events

interface SessionCreatedEvent {
  type: "session.created"
  attrs: SessionFields
}

interface SessionUpdatedEvent {
  type: "session.updated"
  attrs: SessionFields
}

interface SessionDeletedEvent {
  type: "session.deleted"
  attrs: SessionFields
}

interface SessionIdleEvent {
  type: "session.idle"
  attrs: Record<string, never>
}

interface SessionCompactedEvent {
  type: "session.compacted"
  attrs: Record<string, never>
}

interface SessionStatusEvent {
  type: "session.status"
  attrs: {
    "session.status": string
    "retry.attempt"?: number
    "retry.next"?: number
  }
}

interface SessionErrorEvent {
  type: "session.error"
  attrs: {
    "error.name"?: string
    "error.provider_id"?: string
    "error.retryable"?: boolean
    "error.status_code"?: number
  }
}

interface SessionDiffEvent {
  type: "session.diff"
  attrs: {
    "diff.files": number
    "diff.additions": number
    "diff.deletions": number
  }
}

// Message events

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

interface MessageUpdatedEvent {
  type: "message.updated"
  attrs: MessageUpdatedAssistantAttrs | MessageUpdatedUserAttrs
}

interface MessageRemovedEvent {
  type: "message.removed"
  attrs: Record<string, never>
}

// Message part events — one type per part variant

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
  // Token fields are spread from tokenFields() at runtime
  [key: `step.tokens.${string}`]: number
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

interface MessagePartUpdatedEvent {
  type: "message.part.updated"
  attrs: MessagePartAttrs
}

interface MessagePartRemovedEvent {
  type: "message.part.removed"
  attrs: {
    "part.id": string
  }
}

// Synthetic events

interface UserPromptEvent {
  type: "user.prompt"
  attrs: {
    "prompt.content": string
    "prompt.length": number
    "prompt.lines": number
  }
}

interface ApiRequestEvent {
  type: "api.request"
  attrs: {
    "message.id": string
    "model.id": string
    "provider.id": string
    "message.mode": string
    "cost": number
    "cost.estimated": boolean
    "duration_ms"?: number
    "finish": string
    // Token fields are spread from tokenFields() at runtime
    [key: `tokens.${string}`]: number
  }
}

// Command and file events

interface CommandExecutedEvent {
  type: "command.executed"
  attrs: {
    "command.name": string
    "command.arguments": string
  }
}

interface FileEditedEvent {
  type: "file.edited"
  attrs: Record<string, never>
}

// Permission events

interface PermissionUpdatedEvent {
  type: "permission.updated"
  attrs: {
    "permission.id": string
    "permission.type": string
    "permission.title": string
    "permission.time.created": number
    "permission.call_id"?: string
  }
}

interface PermissionRepliedEvent {
  type: "permission.replied"
  attrs: {
    "permission.id": string
    "permission.response"?: string
  }
}

// Todo events

interface TodoUpdatedEvent {
  type: "todo.updated"
  attrs: {
    "todo.count": number
    "todo.pending": number
    "todo.in_progress": number
    "todo.completed": number
    "todo.cancelled": number
    "todo.high": number
    "todo.medium": number
    "todo.low": number
  }
}

// VCS events

interface VcsBranchUpdatedEvent {
  type: "vcs.branch.updated"
  attrs: {
    "vcs.branch"?: string
  }
}

// Tool execution hook event (emitted from index.ts, not handlers.ts)

interface ToolExecutedEvent {
  type: "tool.executed"
  attrs: {
    "tool.name": string
    "tool.call_id": string
    "tool.title": string
    "tool.args_size"?: number
    "tool.output_size"?: number
    "tool.output_lines"?: number
    "tool.has_metadata": boolean
  }
}

// Discriminated union of all events

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

// Type-safe emit: converts typed event attrs to Record<string, AttrVal>
// This ensures all emit() calls are type-checked at compile time.
export function flattenEvent(event: OtelEvent): { type: string; attrs: Record<string, AttrVal> } {
  return { type: event.type, attrs: event.attrs as Record<string, AttrVal> }
}

// Helper to build SessionFields from a session object
export function sessionFields(
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
): SessionFields {
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

// Helper to build prefixed token attributes
export function tokenFields(prefix: string, tokens: Tokens): Record<string, number> {
  return {
    [`${prefix}.input`]: tokens.input,
    [`${prefix}.output`]: tokens.output,
    [`${prefix}.reasoning`]: tokens.reasoning,
    [`${prefix}.cache.read`]: tokens.cache.read,
    [`${prefix}.cache.write`]: tokens.cache.write,
  }
}
