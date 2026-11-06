import { execFileSync } from 'node:child_process'

export function descendantPids(pid) {
  let output = ''
  try {
    output = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  } catch {
    return []
  }
  const children = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[1-9]\d*$/.test(line))
    .map((line) => Number(line))
  return children.flatMap((child) => [...descendantPids(child), child])
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function killProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid process id')
  }
  const descendants = descendantPids(pid)
  for (const child of descendants) {
    try {
      process.kill(child, 'SIGKILL')
    } catch {
      // The child exited between discovery and the signal.
    }
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The process is not a group leader. Direct descendants were already signaled.
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The leader already exited.
  }
}
