import type { OpencodeClient, Logger } from "./types.js"

// Permission entry: simple value or pattern object
// Matches CLI schema: z.union([z.enum(["ask", "allow", "deny"]), z.record(z.enum(...))])
type PermissionEntry = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">

function isPermissionDenied(entry: PermissionEntry | undefined): boolean {
  if (entry === undefined) return false
  if (entry === "deny") return true
  if (typeof entry === "object" && entry["*"] === "deny") return true
  return false
}

// Check if an agent is a sub-agent (mode === "subagent")
export async function parseAgentMode(
  client: OpencodeClient,
  agentName: string,
  log: Logger,
): Promise<{ isSubAgent: boolean }> {
  try {
    const result = await client.app.agents({})
    const agents = (result.data ?? []) as { name: string; mode?: string }[]
    const agent = agents.find((a) => a.name === agentName)
    return { isSubAgent: agent?.mode === "subagent" }
  } catch (error) {
    log.warn(
      `Agent list fetch failed for "${agentName}", assuming non-sub-agent: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { isSubAgent: false }
  }
}

// An agent is read-only when ALL of: edit, write, and bash are denied
export async function parseAgentWriteCapability(
  client: OpencodeClient,
  agentName: string,
  log: Logger,
): Promise<{ isReadOnly: boolean }> {
  try {
    const config = await client.config.get()
    const configData = config.data as {
      agent?: Record<string, {
        permission?: Record<string, PermissionEntry>
      }>
    }
    const permission = configData?.agent?.[agentName]?.permission ?? {}

    const editDenied = isPermissionDenied(permission.edit)
    const writeDenied = isPermissionDenied(permission.write)
    const bashDenied = isPermissionDenied(permission.bash)

    return { isReadOnly: editDenied && writeDenied && bashDenied }
  } catch (error) {
    log.warn(
      `Config fetch failed for "${agentName}", assuming write-capable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { isReadOnly: false }
  }
}
