import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Model } from "@opencode-ai/sdk"
import type { OpencodeClient, DelegationListItem } from "./types.js"
import { createLogger } from "./types.js"
import { DelegationManager } from "./manager.js"

// Detect project ID from git root commit hash for cross-worktree consistency
async function getProjectId(directory: string): Promise<string> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const exec = promisify(execFile)
  try {
    const result = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: directory })
    const hash = result.stdout.trim().split("\n")[0]
    if (hash) return hash
  } catch {
    // not a git repo or git not available
  }
  // fallback: hash the directory path
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(directory).digest("hex").slice(0, 16)
}

// Delegation rules injected into the system prompt
const DELEGATION_RULES = `<task-notification>
<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent)\` - Launch task, returns ID immediately
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)

## How It Works

1. Call \`delegate\` with a detailed prompt and any agent name
2. Continue productive work while it runs
3. Receive notification when complete
4. Call \`delegation_read(id)\` to retrieve results

Both read-only agents (explore, researcher) and write-capable agents (coder, scribe)
can be delegated. Write-capable agents will have full edit/write/bash access in their
background session.

## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<task-notification>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

</delegation-system>
</task-notification>`

// Format delegation context for injection during compaction
function formatDelegationContext(
  running: DelegationForContext[],
  completed: DelegationListItem[],
): string {
  const sections: string[] = ["<delegation-context>"]

  if (running.length > 0) {
    sections.push("## Running Delegations")
    sections.push("")
    for (const d of running) {
      sections.push(`### \`${d.id}\`${d.agent ? ` (${d.agent})` : ""}`)
      if (d.startedAt) sections.push(`**Started:** ${d.startedAt.toISOString()}`)
      if (d.prompt) {
        const truncated = d.prompt.length > 200 ? `${d.prompt.slice(0, 200)}...` : d.prompt
        sections.push(`**Prompt:** ${truncated}`)
      }
      sections.push("")
    }
    sections.push("> You WILL be notified via `<task-notification>` when delegations complete.")
    sections.push("> Do NOT poll `delegation_list` - continue productive work.")
    sections.push("")
  }

  if (completed.length > 0) {
    sections.push("## Recent Completed Delegations")
    sections.push("")
    for (const d of completed) {
      const icon = d.status === "complete" ? "[done]"
        : d.status === "error" ? "[error]"
        : d.status === "timeout" ? "[timeout]"
        : "[cancelled]"
      sections.push(`### ${icon} \`${d.id}\``)
      sections.push(`**Title:** ${d.title || "(no title)"}`)
      sections.push(`**Status:** ${d.status}`)
      sections.push(`**Description:** ${d.description || "(no description)"}`)
      sections.push("")
    }
    sections.push("> Use `delegation_list()` to see all delegations for this session.")
    sections.push("")
  }

  sections.push("## Retrieval")
  sections.push("Use `delegation_read(\"id\")` to access full delegation output.")
  sections.push("</delegation-context>")

  return sections.join("\n")
}

interface DelegationForContext {
  id: string
  agent?: string
  title?: string
  description?: string
  status: string
  startedAt?: Date
  prompt?: string
}

export const BackgroundTaskPlugin: Plugin = async ({ client, directory }) => {
  const log = createLogger(client as OpencodeClient)

  const projectId = await getProjectId(directory)
  const baseDir = join(homedir(), ".local", "share", "opencode", "delegations", projectId)
  await mkdir(baseDir, { recursive: true })

  const manager = new DelegationManager(client as OpencodeClient, baseDir, log)
  await manager.debugLog("BackgroundTaskPlugin initialized")

  return {
    tool: {
      delegate: tool({
        description: `Delegate a task to an agent. Returns immediately with a readable ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output
- Write-capable tasks (editing files, running commands) in parallel

On completion, a notification will arrive with the ID, title, description, and result.
Use \`delegation_read\` with the ID to retrieve the result again if it is lost during compaction.`,
        args: {
          prompt: tool.schema
            .string()
            .describe("The full detailed prompt for the agent. Must be in English."),
          agent: tool.schema
            .string()
            .describe("Agent to delegate to (e.g. \"explore\", \"researcher\", \"coder\")."),
        },
        async execute(args, toolCtx) {
          if (!toolCtx?.sessionID) return "delegate requires sessionID. This is a system error."
          if (!toolCtx?.messageID) return "delegate requires messageID. This is a system error."

          try {
            const delegation = await manager.delegate({
              parentSessionID: toolCtx.sessionID,
              parentMessageID: toolCtx.messageID,
              parentAgent: toolCtx.agent,
              prompt: args.prompt,
              agent: args.agent,
            })

            const pendingCount = manager.getPendingCount(toolCtx.sessionID)
            let response = `Delegation started: ${delegation.id}\nAgent: ${args.agent}`
            if (pendingCount > 1) response += `\n\n${pendingCount} delegations now active.`
            response += `\nYou WILL be notified when ${pendingCount > 1 ? "ALL complete" : "complete"}. Do NOT poll.`
            return response
          } catch (error) {
            return `Delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
          }
        },
      }),

      delegation_read: tool({
        description: `Read the output of a delegation by its ID.
Use this to retrieve results from delegated tasks if the inline notification was lost during compaction.`,
        args: {
          id: tool.schema.string().describe("The delegation ID (e.g. \"bold-amber-fox\")"),
        },
        async execute(args, toolCtx) {
          if (!toolCtx?.sessionID) return "delegation_read requires sessionID. This is a system error."
          return await manager.readOutput(toolCtx.sessionID, args.id)
        },
      }),

      delegation_list: tool({
        description: `List all delegations for the current session.
Shows both running and completed delegations.`,
        args: {},
        async execute(_args, toolCtx) {
          if (!toolCtx?.sessionID) return "delegation_list requires sessionID. This is a system error."

          const delegations = await manager.listDelegations(toolCtx.sessionID)
          if (delegations.length === 0) return "No delegations found for this session."

          const lines = delegations.map((d) => {
            const titlePart = d.title ? ` | ${d.title}` : ""
            const descPart = d.description ? `\n  -> ${d.description}` : ""
            return `- **${d.id}**${titlePart} [${d.status}]${descPart}`
          })

          return `## Delegations\n\n${lines.join("\n")}`
        },
      }),
    },

    // Inject delegation rules into system prompt
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: Model },
      output: { system: string[] },
    ) => {
      output.system.push(DELEGATION_RULES)
    },

    // Inject delegation context during compaction for context recovery
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const rootSessionID = await manager.getRootSessionID(input.sessionID)

      const running = manager
        .getRunningDelegations()
        .filter((d) =>
          d.parentSessionID === input.sessionID ||
          d.parentSessionID === rootSessionID,
        )
        .map((d) => ({
          id: d.id,
          agent: d.agent,
          title: d.title,
          description: d.description,
          status: d.status,
          startedAt: d.startedAt,
          prompt: d.prompt,
        }))

      const allDelegations = await manager.listDelegations(input.sessionID)
      const completed = allDelegations
        .filter((d) => d.status !== "running")
        .slice(-10)

      if (running.length === 0 && completed.length === 0) return

      output.context.push(formatDelegationContext(running, completed))
    },

    // Event hook for session.idle and message tracking
    event: async ({ event }: { event: Event }): Promise<void> => {
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        const delegation = manager.findBySession(sessionID)
        if (delegation) {
          await manager.handleSessionIdle(sessionID)
        }
      }

      if (event.type === "message.updated") {
        const sessionID = event.properties.info.sessionID
        if (sessionID) {
          manager.handleMessageEvent(sessionID)
        }
      }
    },
  }
}
