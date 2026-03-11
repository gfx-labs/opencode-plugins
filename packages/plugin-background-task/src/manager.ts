import { mkdir, writeFile, readFile, readdir, unlink, appendFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  OpencodeClient, Logger, Delegation, DelegateInput,
  DelegationListItem,
} from "./types.js"
import type { Message, Part, TextPart } from "@opencode-ai/sdk"
import { generateId } from "./names.js"
import { generateMetadata } from "./metadata.js"

interface SessionMessageItem {
  info: Message
  parts: Part[]
}

interface AssistantSessionMessageItem {
  info: Message & { role: "assistant" }
  parts: Part[]
}

const MAX_RUN_TIME_MS = 15 * 60 * 1_000 // 15 minutes

export class DelegationManager {
  private delegations = new Map<string, Delegation>()
  private client: OpencodeClient
  private baseDir: string
  private log: Logger
  // Track pending delegations per parent session for batched notifications
  private pendingByParent = new Map<string, Set<string>>()

  constructor(client: OpencodeClient, baseDir: string, log: Logger) {
    this.client = client
    this.baseDir = baseDir
    this.log = log
  }

  // Walk up the parent chain to find the root session
  async getRootSessionID(sessionID: string): Promise<string> {
    let currentID = sessionID
    for (let depth = 0; depth < 10; depth++) {
      try {
        const session = await this.client.session.get({ path: { id: currentID } })
        if (!session.data?.parentID) return currentID
        currentID = session.data.parentID
      } catch {
        return currentID
      }
    }
    return currentID
  }

  private async getDelegationsDir(sessionID: string): Promise<string> {
    const rootID = await this.getRootSessionID(sessionID)
    return join(this.baseDir, rootID)
  }

  private async ensureDelegationsDir(sessionID: string): Promise<string> {
    const dir = await this.getDelegationsDir(sessionID)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async delegate(input: DelegateInput): Promise<Delegation> {
    // Generate a unique readable ID
    let id = generateId()
    let attempts = 0
    while (this.delegations.has(id) && attempts < 10) {
      id = generateId()
      attempts++
    }
    if (this.delegations.has(id)) {
      throw new Error("Failed to generate unique delegation ID after 10 attempts")
    }

    await this.debugLog(`delegate() id=${id}`)

    // Validate agent exists
    const agentsResult = await this.client.app.agents({})
    const agents = (agentsResult.data ?? []) as {
      name: string; description?: string; mode?: string
    }[]
    const validAgent = agents.find((a) => a.name === input.agent)

    if (!validAgent) {
      const available = agents
        .filter((a) => a.mode === "subagent" || a.mode === "all" || !a.mode)
        .map((a) => `  ${a.name}${a.description ? ` - ${a.description}` : ""}`)
        .join("\n")
      throw new Error(
        `Agent "${input.agent}" not found.\n\nAvailable agents:\n${available || "(none)"}`,
      )
    }

    // Resolve root session ID once and cache it so persist and read
    // always use the same directory regardless of which session calls them
    const rootSessionID = await this.getRootSessionID(input.parentSessionID)

    // Create isolated session
    const sessionResult = await this.client.session.create({
      body: {
        title: `Delegation: ${id}`,
        parentID: input.parentSessionID,
      },
    })

    if (!sessionResult.data?.id) {
      throw new Error("Failed to create delegation session")
    }

    const delegation: Delegation = {
      id,
      sessionID: sessionResult.data.id,
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      parentAgent: input.parentAgent,
      prompt: input.prompt,
      agent: input.agent,
      status: "running",
      startedAt: new Date(),
      progress: { toolCalls: 0, lastUpdate: new Date() },
      rootSessionID,
    }

    this.delegations.set(id, delegation)

    // Track for batched notification
    if (!this.pendingByParent.has(input.parentSessionID)) {
      this.pendingByParent.set(input.parentSessionID, new Set())
    }
    this.pendingByParent.get(input.parentSessionID)!.add(id)

    // Timeout safety net
    setTimeout(() => {
      const current = this.delegations.get(id)
      if (current && current.status === "running") {
        void this.handleTimeout(id)
      }
    }, MAX_RUN_TIME_MS + 5_000)

    // Ensure storage dir exists using the cached root
    const delegationsDir = join(this.baseDir, rootSessionID)
    await mkdir(delegationsDir, { recursive: true })

    // Fire prompt -- disable recursive delegation and state tools
    this.client.session
      .prompt({
        path: { id: delegation.sessionID },
        body: {
          agent: input.agent,
          parts: [{ type: "text", text: input.prompt }],
          tools: {
            task: false,
            delegate: false,
            todowrite: false,
            plan_save: false,
          },
        },
      })
      .catch((error: Error) => {
        delegation.status = "error"
        delegation.error = error.message
        delegation.completedAt = new Date()
        void this.persistOutput(delegation, `Error: ${error.message}`)
        void this.notifyParent(delegation)
      })

    return delegation
  }

  private async handleTimeout(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId)
    if (!delegation || delegation.status !== "running") return

    await this.debugLog(`timeout for delegation ${delegation.id}`)

    delegation.status = "timeout"
    delegation.completedAt = new Date()
    delegation.error = `Delegation timed out after ${MAX_RUN_TIME_MS / 1_000}s`

    try {
      await this.client.session.delete({ path: { id: delegation.sessionID } })
    } catch {
      // session may already be gone
    }

    const result = await this.getResult(delegation)
    await this.persistOutput(delegation, `${result}\n\n[TIMEOUT REACHED]`)
    await this.notifyParent(delegation)
  }

  private async waitForCompletion(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId)
    if (!delegation) return

    const startTime = Date.now()
    while (
      delegation.status === "running" &&
      Date.now() - startTime < MAX_RUN_TIME_MS + 10_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  // Called from the event hook when a delegation session becomes idle
  async handleSessionIdle(sessionID: string): Promise<void> {
    const delegation = this.findBySession(sessionID)
    if (!delegation || delegation.status !== "running") return

    await this.debugLog(`session.idle for delegation ${delegation.id}`)

    delegation.status = "complete"
    delegation.completedAt = new Date()

    const result = await this.getResult(delegation)
    delegation.result = result

    // Generate title/description via small_model
    const metadata = await generateMetadata(
      this.client, result, delegation.sessionID,
      (msg) => this.debugLog(msg),
    )
    delegation.title = metadata.title
    delegation.description = metadata.description

    await this.persistOutput(delegation, result)
    await this.notifyParent(delegation)
  }

  private async getResult(delegation: Delegation): Promise<string> {
    try {
      const messages = await this.client.session.messages({
        path: { id: delegation.sessionID },
      })

      const messageData = messages.data as SessionMessageItem[] | undefined
      if (!messageData || messageData.length === 0) {
        return `Delegation "${delegation.id}" completed but produced no output.`
      }

      const isAssistant = (m: SessionMessageItem): m is AssistantSessionMessageItem =>
        m.info.role === "assistant"
      const assistantMessages = messageData.filter(isAssistant)

      if (assistantMessages.length === 0) {
        return `Delegation "${delegation.id}" completed but produced no assistant response.`
      }

      const lastMessage = assistantMessages[assistantMessages.length - 1]
      const isText = (p: Part): p is TextPart => p.type === "text"
      const textParts = lastMessage.parts.filter(isText)

      if (textParts.length === 0) {
        return `Delegation "${delegation.id}" completed but produced no text content.`
      }

      return textParts.map((p) => p.text).join("\n")
    } catch (error) {
      return `Delegation "${delegation.id}" result could not be retrieved: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    }
  }

  private async persistOutput(delegation: Delegation, content: string): Promise<void> {
    try {
      // Use the cached rootSessionID so the file always lands in the same
      // directory that was resolved at delegation creation time
      const dir = join(this.baseDir, delegation.rootSessionID)
      await mkdir(dir, { recursive: true })
      const filePath = join(dir, `${delegation.id}.md`)

      const title = delegation.title || delegation.id
      const description = delegation.description || "(No description generated)"

      const header = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Started:** ${delegation.startedAt.toISOString()}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}

---

`
      await writeFile(filePath, header + content, "utf8")
      delegation.persistedPath = filePath
      await this.debugLog(`persisted output to ${filePath}`)
    } catch (error) {
      await this.debugLog(
        `failed to persist output: ${error instanceof Error ? error.message : "Unknown error"}`,
      )
    }
  }

  // Batched parent notification:
  // Individual completions are silent (noReply: true)
  // When ALL delegations for a parent complete, trigger a response
  private async notifyParent(delegation: Delegation): Promise<void> {
    try {
      const title = delegation.title || delegation.id
      const statusText = delegation.status === "complete" ? "complete" : delegation.status
      const result = delegation.result || "(No result)"

      // Mark complete in pending tracker
      const pendingSet = this.pendingByParent.get(delegation.parentSessionID)
      if (pendingSet) pendingSet.delete(delegation.id)

      const allComplete = !pendingSet || pendingSet.size === 0
      if (allComplete && pendingSet) {
        this.pendingByParent.delete(delegation.parentSessionID)
      }

      const remainingCount = pendingSet?.size || 0

      const progressNote = remainingCount > 0
        ? `\n**${remainingCount} delegation${remainingCount === 1 ? "" : "s"} still in progress.** You WILL be notified when ALL complete.\nDo NOT poll delegation_list - continue productive work.`
        : ""

      const notification = `<task-notification>
<task-id>${delegation.id}</task-id>
<status>${statusText}</status>
<summary>Agent "${title}" ${statusText}</summary>
<result>${result}</result>${delegation.error ? `\n<error>${delegation.error}</error>` : ""}
</task-notification>${progressNote}`

      await this.client.session.prompt({
        path: { id: delegation.parentSessionID },
        body: {
          noReply: true,
          agent: delegation.parentAgent,
          parts: [{ type: "text", text: notification }],
        },
      })

      // All done -- send a final notification that triggers a response
      if (allComplete) {
        await this.client.session.prompt({
          path: { id: delegation.parentSessionID },
          body: {
            noReply: false,
            agent: delegation.parentAgent,
            parts: [{ type: "text", text: `<task-notification>\n<status>completed</status>\n<summary>All delegations complete.</summary>\n</task-notification>` }],
          },
        })
      }

      await this.debugLog(
        `notified parent ${delegation.parentSessionID} (allComplete=${allComplete}, remaining=${remainingCount})`,
      )
    } catch (error) {
      await this.debugLog(
        `failed to notify parent: ${error instanceof Error ? error.message : "Unknown error"}`,
      )
    }
  }

  // Try to read a delegation's persisted file, checking multiple paths
  private async tryReadFile(sessionID: string, id: string): Promise<string | undefined> {
    // Path 1: resolve via the caller's session
    try {
      const dir = await this.getDelegationsDir(sessionID)
      return await readFile(join(dir, `${id}.md`), "utf8")
    } catch {
      // not found at this path
    }

    // Path 2: use the cached persistedPath from the in-memory delegation
    const delegation = this.delegations.get(id)
    if (delegation?.persistedPath) {
      try {
        return await readFile(delegation.persistedPath, "utf8")
      } catch {
        // not found at cached path either
      }
    }

    // Path 3: use the cached rootSessionID to derive the directory
    if (delegation?.rootSessionID) {
      try {
        const dir = join(this.baseDir, delegation.rootSessionID)
        return await readFile(join(dir, `${id}.md`), "utf8")
      } catch {
        // not found
      }
    }

    return undefined
  }

  // Read a delegation's persisted output, blocking if still running
  async readOutput(sessionID: string, id: string): Promise<string> {
    // Fast path: file already exists
    const cached = await this.tryReadFile(sessionID, id)
    if (cached) return cached

    // Check in-memory state
    const delegation = this.delegations.get(id)
    if (delegation) {
      if (delegation.status === "running") {
        await this.debugLog(`readOutput: waiting for delegation ${id} to complete`)
        await this.waitForCompletion(id)

        // Retry file read after completion
        const afterWait = await this.tryReadFile(sessionID, id)
        if (afterWait) return afterWait
      }

      // Delegation exists in memory but file is missing -- return what we have
      if (delegation.result) return delegation.result

      if (delegation.status !== "running") {
        const title = delegation.title || delegation.id
        return `Delegation "${title}" ended with status: ${delegation.status}. ${delegation.error || ""}`
      }
    }

    throw new Error(
      `Delegation "${id}" not found.\n\nUse delegation_list() to see available delegations.`,
    )
  }

  async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
    const results: DelegationListItem[] = []

    // In-memory delegations
    for (const delegation of this.delegations.values()) {
      results.push({
        id: delegation.id,
        status: delegation.status,
        title: delegation.title || "(generating...)",
        description: delegation.description || "(generating...)",
      })
    }

    // Persisted delegations from filesystem
    try {
      const dir = await this.getDelegationsDir(sessionID)
      const files = await readdir(dir)

      for (const file of files) {
        if (!file.endsWith(".md")) continue
        const id = file.replace(".md", "")
        if (results.find((r) => r.id === id)) continue

        let title = "(loaded from storage)"
        let description = ""
        let agent: string | undefined
        try {
          const content = await readFile(join(dir, file), "utf8")
          const titleMatch = content.match(/^# (.+)$/m)
          if (titleMatch) title = titleMatch[1]
          const agentMatch = content.match(/^\*\*Agent:\*\* (.+)$/m)
          if (agentMatch) agent = agentMatch[1]
          const lines = content.split("\n")
          if (lines.length > 2 && lines[2]) description = lines[2].slice(0, 150)
        } catch {
          // ignore read errors
        }
        results.push({ id, status: "complete", title, description, agent })
      }
    } catch {
      // directory may not exist yet
    }

    return results
  }

  async deleteDelegation(sessionID: string, id: string): Promise<boolean> {
    // Find and cancel if running
    const delegation = this.delegations.get(id)
    if (delegation) {
      if (delegation.status === "running") {
        try {
          await this.client.session.delete({ path: { id: delegation.sessionID } })
        } catch {
          // session may already be gone
        }
        delegation.status = "cancelled"
        delegation.completedAt = new Date()
      }
      this.delegations.delete(id)
    }

    // Remove from filesystem
    try {
      const dir = await this.getDelegationsDir(sessionID)
      await unlink(join(dir, `${id}.md`))
      return true
    } catch {
      return false
    }
  }

  findBySession(sessionID: string): Delegation | undefined {
    return Array.from(this.delegations.values()).find((d) => d.sessionID === sessionID)
  }

  handleMessageEvent(sessionID: string, messageText?: string): void {
    const delegation = this.findBySession(sessionID)
    if (!delegation || delegation.status !== "running") return

    delegation.progress.lastUpdate = new Date()
    if (messageText) {
      delegation.progress.lastMessage = messageText
      delegation.progress.lastMessageAt = new Date()
    }
  }

  getPendingCount(parentSessionID: string): number {
    return this.pendingByParent.get(parentSessionID)?.size ?? 0
  }

  getRunningDelegations(): Delegation[] {
    return Array.from(this.delegations.values()).filter((d) => d.status === "running")
  }

  async getRecentCompletedDelegations(
    sessionID: string,
    limit = 10,
  ): Promise<DelegationListItem[]> {
    const all = await this.listDelegations(sessionID)
    return all.filter((d) => d.status !== "running").slice(-limit)
  }

  async debugLog(msg: string): Promise<void> {
    const line = `${new Date().toISOString()}: ${msg}\n`
    const debugFile = join(this.baseDir, "background-task-debug.log")
    try {
      await appendFile(debugFile, line, "utf8")
    } catch {
      // ignore
    }
  }
}
