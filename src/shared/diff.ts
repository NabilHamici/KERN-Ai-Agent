/** Build a unified diff for proposal review. Not a Git patch; paths are workspace-relative. */
export function unifiedDiff(path: string, before: string | null, after: string | null, toPath?: string | null): string {
  if (before === null && after !== null) {
    return formatHunk(`a/${path}`, `b/${path}`, [], after.split(/\r?\n/))
  }
  if (before !== null && after === null) {
    return formatHunk(`a/${path}`, `b/${path}`, before.split(/\r?\n/), [])
  }
  if (before !== null && after !== null && toPath && toPath !== path) {
    const rename = `rename from ${path}\nrename to ${toPath}`
    if (before === after) {
      return rename
    }
    return `${rename}\n${formatHunk(`a/${path}`, `b/${toPath}`, before.split(/\r?\n/), after.split(/\r?\n/))}`
  }
  if (before !== null && after !== null) {
    return formatHunk(`a/${path}`, `b/${path}`, before.split(/\r?\n/), after.split(/\r?\n/))
  }
  return `--- a/${path}\n+++ b/${toPath ?? path}\n`
}

function formatHunk(leftPath: string, rightPath: string, left: string[], right: string[]): string {
  const lines = [`--- ${leftPath}`, `+++ ${rightPath}`]
  const { edits } = lineEdits(left, right)
  let hunk: string[] = []
  let leftStart = 0
  let rightStart = 0
  let leftCount = 0
  let rightCount = 0
  let pendingContext = 0
  const flush = (): void => {
    if (hunk.length === 0) {
      return
    }
    lines.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`)
    lines.push(...hunk)
    hunk = []
    leftCount = 0
    rightCount = 0
  }
  let leftLine = 1
  let rightLine = 1
  for (const edit of edits) {
    if (edit.type === 'equal') {
      if (hunk.length === 0) {
        leftLine += 1
        rightLine += 1
        continue
      }
      hunk.push(` ${edit.line}`)
      leftCount += 1
      rightCount += 1
      pendingContext += 1
      if (pendingContext >= 3) {
        flush()
        pendingContext = 0
      }
      leftLine += 1
      rightLine += 1
      continue
    }
    if (hunk.length === 0) {
      leftStart = leftLine
      rightStart = rightLine
    }
    pendingContext = 0
    if (edit.type === 'delete') {
      hunk.push(`-${edit.line}`)
      leftCount += 1
      leftLine += 1
    } else {
      hunk.push(`+${edit.line}`)
      rightCount += 1
      rightLine += 1
    }
  }
  flush()
  if (lines.length === 2) {
    lines.push('@@ -0,0 +0,0 @@')
  }
  return lines.join('\n')
}

type Edit =
  | { type: 'equal'; line: string }
  | { type: 'delete'; line: string }
  | { type: 'insert'; line: string }

function lineEdits(left: string[], right: string[]): { edits: Edit[] } {
  const n = left.length
  const m = right.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = left[i] === right[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }
  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      edits.push({ type: 'equal', line: left[i]! })
      i += 1
      j += 1
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      edits.push({ type: 'delete', line: left[i]! })
      i += 1
    } else {
      edits.push({ type: 'insert', line: right[j]! })
      j += 1
    }
  }
  while (i < n) {
    edits.push({ type: 'delete', line: left[i]! })
    i += 1
  }
  while (j < m) {
    edits.push({ type: 'insert', line: right[j]! })
    j += 1
  }
  return { edits }
}
