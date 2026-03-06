import { readFile, stat } from "node:fs/promises"
import { join, dirname } from "node:path"

export interface GitInfo {
  remoteUrl?: string
  branch?: string
  commit?: string
}

// Detect git repo info by reading .git files directly -- no subprocess spawning.
// Walks up from `directory` to find the nearest .git directory or file (worktrees).
export async function detectGitInfo(directory: string): Promise<GitInfo> {
  const info: GitInfo = {}
  try {
    let gitDir: string | undefined

    // Walk up to find .git
    let current = directory
    for (let i = 0; i < 64; i++) {
      const candidate = join(current, ".git")
      try {
        const s = await stat(candidate)
        if (s.isDirectory()) {
          gitDir = candidate
          break
        }
        if (s.isFile()) {
          // Worktree: .git file contains "gitdir: <path>"
          const content = await readFile(candidate, "utf-8")
          const match = content.match(/^gitdir:\s*(.+)$/m)
          if (match) {
            const linked = match[1].trim()
            gitDir = linked.startsWith("/") ? linked : join(current, linked)
          }
          break
        }
      } catch {
        // no .git here, keep walking up
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }

    if (!gitDir) return info

    // Read HEAD to get branch or detached commit
    try {
      const head = (await readFile(join(gitDir, "HEAD"), "utf-8")).trim()
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5)
        // Extract branch name from refs/heads/...
        if (ref.startsWith("refs/heads/")) {
          info.branch = ref.slice(11)
        } else {
          info.branch = ref
        }
        // Resolve the ref to a commit SHA
        try {
          info.commit = (await readFile(join(gitDir, ref), "utf-8")).trim()
        } catch {
          // Might be in packed-refs
          try {
            const packed = await readFile(join(gitDir, "packed-refs"), "utf-8")
            for (const line of packed.split("\n")) {
              if (line.endsWith(ref)) {
                const sha = line.split(" ")[0]
                if (sha && sha.length >= 40) info.commit = sha
                break
              }
            }
          } catch {
            // no packed-refs
          }
        }
      } else if (head.length >= 40) {
        // Detached HEAD -- raw SHA
        info.commit = head
      }
    } catch {
      // no HEAD file
    }

    // Read remote origin URL from config
    try {
      const gitConfig = await readFile(join(gitDir, "config"), "utf-8")
      // Find [remote "origin"] section and extract url
      const remoteMatch = gitConfig.match(/\[remote\s+"origin"\]\s*\n(?:\s+[^\[].+\n)*?\s+url\s*=\s*(.+)/m)
      if (remoteMatch) {
        info.remoteUrl = remoteMatch[1].trim()
      }
    } catch {
      // no config or no origin
    }
  } catch {
    // git detection failed entirely, return empty
  }
  return info
}
