export type TreeEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
  blocked: boolean
}

export type SessionRecord = {
  id: string
  title: string
  status: string
  createdAt: string
}

const SKIPPED_SEARCH_DIRECTORIES = new Set(['node_modules', '.git'])

export function secretLabel(storageAvailable: boolean, configured: boolean): string {
  if (!storageAvailable) {
    return 'Secure storage unavailable'
  }
  return configured ? 'Key stored' : 'No key'
}

export function isDirty(baseline: string, value: string): boolean {
  return value !== baseline
}

export function hasExternalChange(baseline: string, disk: string): boolean {
  return disk !== baseline
}

export function languageLabel(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'tsx':
      return 'TypeScript React'
    case 'ts':
      return 'TypeScript'
    case 'jsx':
      return 'JavaScript React'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'JavaScript'
    case 'json':
      return 'JSON'
    case 'css':
      return 'CSS'
    case 'html':
      return 'HTML'
    case 'md':
      return 'Markdown'
    case 'py':
      return 'Python'
    case 'sh':
    case 'zsh':
      return 'Shell'
    case 'yml':
    case 'yaml':
      return 'YAML'
    default:
      return 'Plain text'
  }
}

export function fileMatches(relativePath: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return true
  }
  return relativePath.toLowerCase().includes(needle)
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.status === 'string' &&
    typeof row.createdAt === 'string'
  )
}

export async function collectFiles(
  list: (directory: string) => Promise<TreeEntry[]>,
  query: string,
  limit = 80
): Promise<TreeEntry[]> {
  const needle = query.trim()
  if (!needle) {
    return []
  }
  const found: TreeEntry[] = []
  const queue = ['.']
  const seen = new Set<string>()
  while (queue.length > 0 && found.length < limit && seen.size < 400) {
    const directory = queue.shift()
    if (!directory || seen.has(directory)) {
      continue
    }
    seen.add(directory)
    const entries = await list(directory)
    for (const entry of entries) {
      if (entry.blocked) {
        continue
      }
      if (entry.kind === 'directory' && !SKIPPED_SEARCH_DIRECTORIES.has(entry.name)) {
        queue.push(entry.relativePath)
      }
      if (fileMatches(entry.name, needle) || fileMatches(entry.relativePath, needle)) {
        found.push(entry)
        if (found.length >= limit) {
          break
        }
      }
    }
  }
  return found
}
