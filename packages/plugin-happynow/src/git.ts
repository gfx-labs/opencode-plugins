import { spawn } from "node:child_process"

interface GitOpts {
  cwd?: string
  stdin?: string
}

export async function git(args: string[], opts?: GitOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    if (opts?.stdin) {
      proc.stdin.write(opts.stdin)
      proc.stdin.end()
    } else {
      proc.stdin.end()
    }

    proc.on("close", (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString()
      const stderr = Buffer.concat(stderrChunks).toString()
      if (exitCode !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (exit ${exitCode}):\n${stderr}`))
      } else {
        resolve(stdout)
      }
    })

    proc.on("error", reject)
  })
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
  return result.trim()
}

export async function getHead(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "HEAD"], { cwd })
  return result.trim()
}

export async function getMergeBase(ref1: string, ref2: string, cwd: string): Promise<string> {
  const result = await git(["merge-base", ref1, ref2], { cwd })
  return result.trim()
}

export async function getDiff(base: string, head: string, cwd: string): Promise<string> {
  const mergeBase = await getMergeBase(base, head, cwd)
  return git(["diff", mergeBase, head], { cwd })
}

export interface Hunk {
  file: string
  patch: string
}

export interface FileDiff {
  file: string
  header: string
  hunks: Hunk[]
  raw: string
}

export interface FlatHunk {
  index: number
  file: string
  header: string
  patch: string
}

export function parseDiff(rawDiff: string): FileDiff[] {
  const files: FileDiff[] = []
  if (!rawDiff.trim()) return files

  const fileParts = rawDiff.split(/(?=^diff --git )/m)
  for (const filePart of fileParts) {
    if (!filePart.trim()) continue
    const headerMatch = filePart.match(/^diff --git a\/(.*?) b\/(.*?)$/m)
    if (!headerMatch) continue
    const file = headerMatch[2]
    const hunkSplitRegex = /(?=^@@ )/m
    const parts = filePart.split(hunkSplitRegex)
    const header = parts[0]
    const hunkTexts = parts.slice(1)
    const hunks: Hunk[] = hunkTexts.map((patch) => ({ file, patch }))
    files.push({ file, header, hunks, raw: filePart })
  }
  return files
}

export function flattenHunks(files: FileDiff[]): FlatHunk[] {
  const result: FlatHunk[] = []
  let idx = 0
  for (const f of files) {
    for (const h of f.hunks) {
      result.push({ index: idx++, file: h.file, header: f.header, patch: h.patch })
    }
  }
  return result
}

export async function createTempBranch(name: string, baseRef: string, cwd: string): Promise<void> {
  await git(["branch", name, baseRef], { cwd })
}

export async function checkout(branch: string, cwd: string): Promise<void> {
  await git(["checkout", branch], { cwd })
}

export async function deleteBranch(branch: string, cwd: string): Promise<void> {
  await git(["branch", "-D", branch], { cwd })
}

export async function applyPatch(patch: string, cwd: string): Promise<void> {
  await git(["apply", "--allow-empty", "-"], { cwd, stdin: patch })
}

export async function commitAll(message: string, cwd: string): Promise<string> {
  await git(["add", "-A"], { cwd })
  await git(["commit", "-m", message, "--allow-empty"], { cwd })
  return getHead(cwd)
}

export async function moveBranch(branch: string, target: string, cwd: string): Promise<void> {
  await git(["branch", "-f", branch, target], { cwd })
}

export async function isClean(cwd: string): Promise<boolean> {
  const status = await git(["status", "--porcelain"], { cwd })
  return status.trim() === ""
}

export async function refExists(ref: string, cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", ref], { cwd })
    return true
  } catch {
    return false
  }
}
