import { getDiff } from "./git.js"

export interface VerifyResult {
  match: boolean
  originalDiff: string
  newDiff: string
}

export async function verifyDiffsMatch(
  base: string,
  originalHead: string,
  newHead: string,
  cwd: string,
): Promise<VerifyResult> {
  const originalDiff = await getDiff(base, originalHead, cwd)
  const newDiff = await getDiff(base, newHead, cwd)
  return { match: originalDiff === newDiff, originalDiff, newDiff }
}

export function describeMismatch(originalDiff: string, newDiff: string): string {
  const origLines = originalDiff.split("\n")
  const newLines = newDiff.split("\n")
  const lines: string[] = []
  lines.push(`Original diff: ${origLines.length} lines, ${originalDiff.length} bytes`)
  lines.push(`New diff:      ${newLines.length} lines, ${newDiff.length} bytes`)
  const maxCheck = Math.max(origLines.length, newLines.length)
  for (let i = 0; i < maxCheck; i++) {
    if (origLines[i] !== newLines[i]) {
      lines.push(`First difference at line ${i + 1}:`)
      lines.push(`  original: ${origLines[i] ?? "(missing)"}`)
      lines.push(`  new:      ${newLines[i] ?? "(missing)"}`)
      break
    }
  }
  return lines.join("\n")
}
