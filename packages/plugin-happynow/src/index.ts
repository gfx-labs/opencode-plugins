import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import {
  git,
  getCurrentBranch,
  getHead,
  getMergeBase,
  getDiff,
  parseDiff,
  flattenHunks,
  createTempBranch,
  checkout,
  deleteBranch,
  applyPatch,
  commitAll,
  moveBranch,
  isClean,
  refExists,
} from "./git.js"
import type { FileDiff } from "./git.js"
import { verifyDiffsMatch, describeMismatch } from "./verify.js"

interface SessionState {
  baseBranch: string
  originalBranch: string
  originalHead: string
  tempBranch: string
  files: FileDiff[]
  hunkCount: number
  committedHunks: Set<number>
}

const sessions = new Map<string, SessionState>()

async function detectBaseBranch(cwd: string): Promise<string> {
  try {
    const ref = (await git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd })).trim()
    const branch = ref.replace(/^refs\/remotes\/origin\//, "")
    if (branch && await refExists(branch, cwd)) return branch
  } catch { /* ignore */ }
  if (await refExists("main", cwd)) return "main"
  if (await refExists("master", cwd)) return "master"
  throw new Error("Could not detect base branch. Specify it with the 'base' argument.")
}

const COMMAND_TEMPLATE = `Reorganize the commits on this branch into clean, logical ones. The result must be verified to produce a byte-identical diff to the original.

Follow these steps exactly in order:

1. Call happynow_diff to get all numbered hunks between the base and HEAD. You can pass a base branch argument if provided: $ARGUMENTS

2. Plan the commits. Group related hunks together (same feature, same concern). Related changes across files belong together. Order commits logically: foundational changes first. Prefer fewer meaningful commits over many tiny ones. Every hunk index must be used exactly once.

3. Call happynow_start to create a temporary branch from the merge-base.

4. For each logical group, call happynow_commit with comma-separated hunk indices and a commit message. Imperative mood subject line, max 72 chars, explain why not what. Call once per group, in order.

5. Call happynow_verify to confirm the result is identical to the original diff. If it fails, call happynow_finish with action="abort".

6. Call happynow_finish with action="apply" to replace the branch, or action="abort" to discard.

Important: working tree must be clean, you must be on a feature branch, every hunk must be committed exactly once, and if anything goes wrong call happynow_finish with action="abort".`

export const HappynowPlugin: Plugin = async () => {
  return {
    async config(cfg) {
      cfg.command = cfg.command || {}
      cfg.command.happynow = {
        template: COMMAND_TEMPLATE,
        description: "Reorganize messy commits into clean, logical ones",
      }
    },

    tool: {
      happynow_diff: tool({
        description: "Analyze the diff between a base branch and the current HEAD. Returns numbered hunks that can be grouped into commits. This must be called first before any other happynow tools.",
        args: {
          base: tool.schema.string().optional().describe("Base branch to diff against. Auto-detected if omitted."),
        },
        async execute(args, context) {
          const cwd = context.directory
          const clean = await isClean(cwd)
          if (!clean) return "Error: Working tree is not clean. Commit or stash changes first."

          const baseBranch = args.base || await detectBaseBranch(cwd)
          const currentBranch = await getCurrentBranch(cwd)
          if (currentBranch === baseBranch) {
            return `Error: You are on the base branch (${baseBranch}). Switch to a feature branch first.`
          }
          if (!await refExists(baseBranch, cwd)) {
            return `Error: Base branch '${baseBranch}' does not exist.`
          }

          const originalHead = await getHead(cwd)
          const originalDiff = await getDiff(baseBranch, "HEAD", cwd)
          if (!originalDiff.trim()) return "No diff between base and current branch. Nothing to do."

          const files = parseDiff(originalDiff)
          const hunks = flattenHunks(files)
          const state: SessionState = {
            baseBranch,
            originalBranch: currentBranch,
            originalHead,
            tempBranch: `happynow/${currentBranch}`,
            files,
            hunkCount: hunks.length,
            committedHunks: new Set(),
          }
          sessions.set(context.sessionID, state)

          const lines: string[] = []
          lines.push(`Branch: ${currentBranch}`)
          lines.push(`Base: ${baseBranch}`)
          lines.push(`Head: ${originalHead}`)
          lines.push(`Files: ${files.length}`)
          lines.push(`Total hunks: ${hunks.length}`)
          lines.push("")
          for (const h of hunks) {
            lines.push(`--- HUNK ${h.index} [${h.file}] ---`)
            lines.push(h.patch)
            lines.push("")
          }
          return lines.join("\n")
        },
      }),

      happynow_start: tool({
        description: "Create a temporary branch from the merge-base, ready to receive commits. Call this after happynow_diff and before happynow_commit.",
        args: {},
        async execute(_args, context) {
          const state = sessions.get(context.sessionID)
          if (!state) return "Error: Call happynow_diff first."

          const cwd = context.directory
          try { await deleteBranch(state.tempBranch, cwd) } catch { /* may not exist */ }
          const mergeBase = await getMergeBase(state.baseBranch, state.originalHead, cwd)
          await createTempBranch(state.tempBranch, mergeBase, cwd)
          await checkout(state.tempBranch, cwd)
          return `Created temp branch '${state.tempBranch}' from merge-base ${mergeBase}. Ready for commits.`
        },
      }),

      happynow_commit: tool({
        description: "Apply a set of hunks as a single commit on the temp branch. Call this once per logical commit, in order. Each hunk index must be used exactly once across all happynow_commit calls.",
        args: {
          hunkIndices: tool.schema.string().describe("Comma-separated hunk indices to include in this commit (e.g. '0,1,4,5')."),
          message: tool.schema.string().describe("The commit message. First line is the subject (imperative mood, max 72 chars). Optionally add a blank line and body."),
        },
        async execute(args, context) {
          const state = sessions.get(context.sessionID)
          if (!state) return "Error: Call happynow_diff and happynow_start first."

          const indices = args.hunkIndices.split(",").map((s) => parseInt(s.trim(), 10))
          const allHunks = flattenHunks(state.files)

          for (const idx of indices) {
            if (isNaN(idx) || idx < 0 || idx >= state.hunkCount) {
              return `Error: Hunk index ${idx} is out of range [0, ${state.hunkCount}).`
            }
            if (state.committedHunks.has(idx)) {
              return `Error: Hunk index ${idx} was already committed.`
            }
          }

          const byFile = new Map<string, { header: string; patches: string[] }>()
          for (const idx of indices) {
            const hunk = allHunks[idx]
            let entry = byFile.get(hunk.file)
            if (!entry) {
              entry = { header: hunk.header, patches: [] }
              byFile.set(hunk.file, entry)
            }
            entry.patches.push(hunk.patch)
          }

          const patchParts: string[] = []
          for (const [, { header, patches }] of byFile) {
            patchParts.push(header)
            for (const p of patches) patchParts.push(p)
          }
          const patch = patchParts.join("")

          const cwd = context.directory
          if (patch.trim()) await applyPatch(patch, cwd)
          const commitHash = await commitAll(args.message, cwd)

          for (const idx of indices) state.committedHunks.add(idx)
          const remaining = state.hunkCount - state.committedHunks.size
          return `Committed ${indices.length} hunks as ${commitHash.slice(0, 8)}. ${remaining} hunks remaining.`
        },
      }),

      happynow_verify: tool({
        description: "Verify that the temp branch produces an identical diff to the original branch. Call this after all happynow_commit calls are done.",
        args: {},
        async execute(_args, context) {
          const state = sessions.get(context.sessionID)
          if (!state) return "Error: Call happynow_diff first."

          if (state.committedHunks.size !== state.hunkCount) {
            const missing: number[] = []
            for (let i = 0; i < state.hunkCount; i++) {
              if (!state.committedHunks.has(i)) missing.push(i)
            }
            return `Error: ${missing.length} hunks not yet committed: ${missing.join(", ")}. Commit all hunks before verifying.`
          }

          const cwd = context.directory
          const newHead = await getHead(cwd)
          const verification = await verifyDiffsMatch(state.baseBranch, state.originalHead, newHead, cwd)
          if (!verification.match) {
            return `VERIFICATION FAILED — diffs do not match!\n${describeMismatch(verification.originalDiff, verification.newDiff)}\n\nCall happynow_finish with action="abort" to restore the original branch.`
          }
          return `Verification passed — diffs are byte-identical. New head: ${newHead}. Call happynow_finish with action="apply" to replace the branch, or action="abort" to discard.`
        },
      }),

      happynow_finish: tool({
        description: "Finish the happynow workflow. Use action='apply' to replace the original branch with the clean commits, or action='abort' to discard the temp branch and restore the original.",
        args: {
          action: tool.schema.string().describe("Either 'apply' to replace the branch, or 'abort' to discard changes."),
        },
        async execute(args, context) {
          const state = sessions.get(context.sessionID)
          if (!state) return "Error: Call happynow_diff first."

          const cwd = context.directory

          if (args.action === "abort") {
            await checkout(state.originalBranch, cwd)
            try { await deleteBranch(state.tempBranch, cwd) } catch { /* may not exist */ }
            sessions.delete(context.sessionID)
            return `Aborted. Original branch '${state.originalBranch}' is unchanged.`
          }

          if (args.action === "apply") {
            const newHead = await getHead(cwd)
            const backupRef = `refs/happynow/backup/${state.originalBranch}`
            await git(["update-ref", backupRef, state.originalHead], { cwd })
            await moveBranch(state.originalBranch, newHead, cwd)
            await checkout(state.originalBranch, cwd)
            try { await deleteBranch(state.tempBranch, cwd) } catch { /* may not exist */ }
            sessions.delete(context.sessionID)
            return [
              `Done! '${state.originalBranch}' now has clean commits.`,
              `Original head backed up at ${backupRef} (${state.originalHead}).`,
              `To undo: git reset --hard ${state.originalHead}`,
            ].join("\n")
          }

          return "Error: action must be 'apply' or 'abort'."
        },
      }),
    },
  }
}
