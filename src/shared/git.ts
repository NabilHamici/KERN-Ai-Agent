import { z } from 'zod'

const invalid = { error: 'Invalid request' } as const

export const GIT_LARGE_FILE_BYTES = 25 * 1024 * 1024

export const gitPathListSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).max(500).optional()
})

export const gitCommitRequestSchema = z.strictObject({
  message: z.string().min(1).max(10_000)
})

export const gitBranchRequestSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.includes('..') && !value.startsWith('-') && !/\s/.test(value), invalid)
})

export const gitSwitchBranchRequestSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.includes('..') && !value.startsWith('-') && !/\s/.test(value), invalid)
})

export const gitAddRemoteRequestSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => !value.startsWith('-') && !/\s/.test(value), invalid),
  url: z.string().min(1).max(2048)
})

export const gitPushRequestSchema = z.strictObject({
  remote: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => !value.startsWith('-') && !/\s/.test(value), invalid)
    .optional(),
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith('-') && !/\s/.test(value), invalid)
    .optional(),
  setUpstream: z.boolean().optional()
})

export const gitPullRequestSchema = z.strictObject({
  remote: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => !value.startsWith('-') && !/\s/.test(value), invalid)
    .optional(),
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith('-') && !/\s/.test(value), invalid)
    .optional()
})

export const gitDiffRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096).optional(),
  staged: z.boolean().optional()
})

export const gitLogRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional()
})

export const gitIdentitySchema = z.strictObject({
  name: z.string().min(1).max(256),
  email: z
    .string()
    .min(3)
    .max(320)
    .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), invalid)
})

export const gitIdentitySetSchema = z.strictObject({
  local: z.literal(true),
  name: z.string().min(1).max(256),
  email: z
    .string()
    .min(3)
    .max(320)
    .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), invalid)
})

const gitFileStatusSchema = z.enum([
  'unmodified',
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'ignored',
  'unmerged',
  'conflicted'
])

export const gitStatusEntrySchema = z.strictObject({
  path: z.string(),
  origPath: z.string().optional(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  status: gitFileStatusSchema
})

export const gitBranchInfoSchema = z.strictObject({
  oid: z.string().nullable(),
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  detached: z.boolean(),
  unborn: z.boolean()
})

export const gitRemoteSchema = z.strictObject({
  name: z.string(),
  fetchUrl: z.string().nullable(),
  pushUrl: z.string().nullable()
})

export const gitStatusResultSchema = z.strictObject({
  branch: gitBranchInfoSchema,
  entries: z.array(gitStatusEntrySchema),
  inProgress: z.enum(['none', 'merge', 'rebase', 'cherry-pick', 'revert', 'bisect']).optional()
})

export const gitLogEntrySchema = z.strictObject({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  email: z.string(),
  date: z.string()
})

export const gitIdentityResultSchema = z.strictObject({
  name: z.string().nullable(),
  email: z.string().nullable(),
  configured: z.boolean()
})

export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>
export type GitBranchInfo = z.infer<typeof gitBranchInfoSchema>
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>
export type GitLogEntry = z.infer<typeof gitLogEntrySchema>
export type GitIdentityResult = z.infer<typeof gitIdentityResultSchema>

export type RemoteUrlValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string }

const CREDENTIAL_IN_URL =
  /^(?:https?|git|ssh):\/\/[^/\s@]+:[^/\s@]+@/i

const UNSAFE_REMOTE_PREFIX = /^(?:file:|ext::|-)/i

export function validateRemoteUrl(input: string): RemoteUrlValidation {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'Remote URL is required.' }
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Remote URL cannot be empty.' }
  }
  if (trimmed !== input || /\s/.test(input)) {
    return { ok: false, reason: 'Remote URL cannot contain whitespace.' }
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, reason: 'Remote URL cannot start with "-".' }
  }
  if (UNSAFE_REMOTE_PREFIX.test(trimmed)) {
    return { ok: false, reason: 'Remote URL scheme is not allowed.' }
  }
  if (CREDENTIAL_IN_URL.test(trimmed)) {
    return { ok: false, reason: 'Remote URL cannot contain credentials.' }
  }
  const scpLike = /^[\w.-]+@[\w.-]+:(?:\/\/)?[\w./~-]+$/
  const sshLike = /^git@[\w.-]+:[\w./~-]+$/
  const httpsLike = /^https:\/\/[\w.-]+(?:\/[\w./~-]+)*\/?$/
  const httpLike = /^http:\/\/[\w.-]+(?:\/[\w./~-]+)*\/?$/
  const localPosix = /^\/[\w./~-]+$/
  const localWin = /^[A-Za-z]:[\\/][\w.\\~-]+$/
  if (
    httpsLike.test(trimmed) ||
    httpLike.test(trimmed) ||
    sshLike.test(trimmed) ||
    scpLike.test(trimmed) ||
    localPosix.test(trimmed) ||
    localWin.test(trimmed)
  ) {
    return { ok: true, normalized: trimmed }
  }
  return { ok: false, reason: 'Remote URL must be https, ssh, or scp-like.' }
}

export function maskRemoteUrl(input: string): string {
  const trimmed = input.trim()
  const urlCredential = /^(https?|git|ssh):\/\/[^/\s@]+(?::[^/\s@]*)?@/i
  if (urlCredential.test(trimmed)) {
    return trimmed.replace(urlCredential, (match) => {
      const scheme = match.slice(0, match.indexOf('://') + 3)
      return `${scheme}***@`
    })
  }
  if (!trimmed.includes('://') && /^[^@\s]+@[^@\s]+:/.test(trimmed)) {
    return trimmed.replace(/^[^@]+@/, '***@')
  }
  return trimmed
}

export function generateGitignore(stack: 'node' | 'expo' | 'react-native' = 'node'): string {
  const common = [
    '# Dependencies',
    'node_modules/',
    '',
    '# Build outputs',
    'dist/',
    'build/',
    'out/',
    '.next/',
    '',
    '# Environment & secrets',
    '.env',
    '.env.*',
    '!.env.example',
    '',
    '# Logs',
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*',
    '',
    '# OS',
    '.DS_Store',
    'Thumbs.db',
    '',
    '# IDE',
    '.idea/',
    '.vscode/',
    '*.swp',
    '',
    '# KERN',
    '.kern/',
    ''
  ]
  const expo = [
    '# Expo',
    '.expo/',
    'dist/',
    'web-build/',
    'expo-env.d.ts',
    ''
  ]
  const rn = [
    '# React Native',
    'ios/Pods/',
    'ios/build/',
    'android/app/build/',
    'android/.gradle/',
    'android/build/',
    '*.jks',
    '*.keystore',
    ''
  ]
  if (stack === 'expo') {
    return [...common.slice(0, common.length - 1), ...expo, ...rn].join('\n')
  }
  if (stack === 'react-native') {
    return [...common.slice(0, common.length - 1), ...rn].join('\n')
  }
  return common.join('\n')
}

const RISKY_BASENAMES = [
  /^\.env/i,
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ed25519$/i,
  /^id_ecdsa$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /credentials\.json$/i,
  /service[-_]?account.*\.json$/i
]

export type RiskyPathFinding = {
  path: string
  reason: 'env_file' | 'private_key' | 'large_file'
  sizeBytes?: number
}

export function findRiskyCommitPaths(
  root: string,
  paths: string[],
  statFile: (absolutePath: string) => { size: number } | null
): RiskyPathFinding[] {
  const findings: RiskyPathFinding[] = []
  const seen = new Set<string>()
  for (const relative of paths) {
    const normalized = relative.replace(/\\/g, '/')
    if (seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    const base = normalized.split('/').pop() ?? normalized
    if (RISKY_BASENAMES.some((pattern) => pattern.test(base))) {
      const reason = /^\.env/i.test(base) ? 'env_file' : 'private_key'
      findings.push({ path: normalized, reason })
      continue
    }
    const absolute = `${root.replace(/\/$/, '')}/${normalized}`
    const stat = statFile(absolute)
    if (stat && stat.size > GIT_LARGE_FILE_BYTES) {
      findings.push({ path: normalized, reason: 'large_file', sizeBytes: stat.size })
    }
  }
  return findings
}

function xyToStatus(index: string, worktree: string): GitStatusEntry['status'] {
  if (index === '?' && worktree === '?') {
    return 'untracked'
  }
  if (index === '!' && worktree === '!') {
    return 'ignored'
  }
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) {
    return 'unmerged'
  }
  if (index === 'D' || worktree === 'D') {
    return 'deleted'
  }
  if (index === 'A' || worktree === 'A') {
    return 'added'
  }
  if (index === 'R' || worktree === 'R') {
    return 'renamed'
  }
  if (index === 'C' || worktree === 'C') {
    return 'copied'
  }
  if (index !== ' ' || worktree !== ' ') {
    return 'modified'
  }
  return 'unmodified'
}

export function parsePorcelainV2Z(raw: string): GitStatusResult {
  const branch: GitBranchInfo = {
    oid: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    detached: false,
    unborn: false
  }
  const entries: GitStatusEntry[] = []
  const inProgress: GitStatusResult['inProgress'] = 'none'

  const records = raw.split('\0').filter((record) => record.length > 0)
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (record.startsWith('# ')) {
      const line = record.slice(2)
      if (line.startsWith('branch.oid ')) {
        branch.oid = line.slice('branch.oid '.length) || null
      } else if (line.startsWith('branch.head ')) {
        const head = line.slice('branch.head '.length)
        branch.head = head === '(detached)' ? null : head
        branch.detached = head === '(detached)'
        branch.unborn = head === '(unborn)'
      } else if (line.startsWith('branch.upstream ')) {
        branch.upstream = line.slice('branch.upstream '.length) || null
      } else if (line.startsWith('branch.ab ')) {
        const ab = line.slice('branch.ab '.length)
        const aheadMatch = /\+(\d+)/.exec(ab)
        const behindMatch = /-(\d+)/.exec(ab)
        branch.ahead = aheadMatch ? Number.parseInt(aheadMatch[1]!, 10) : 0
        branch.behind = behindMatch ? Number.parseInt(behindMatch[1]!, 10) : 0
      }
      continue
    }
    if (record.startsWith('? ')) {
      entries.push({
        path: record.slice(2),
        indexStatus: '?',
        worktreeStatus: '?',
        status: 'untracked'
      })
      continue
    }
    if (record.startsWith('! ')) {
      entries.push({
        path: record.slice(2),
        indexStatus: '!',
        worktreeStatus: '!',
        status: 'ignored'
      })
      continue
    }
    if (record.startsWith('u ')) {
      const parts = record.split(' ')
      const xy = parts[1] ?? '??'
      const filePath = parts[parts.length - 1] ?? ''
      entries.push({
        path: filePath,
        indexStatus: xy[0] ?? 'U',
        worktreeStatus: xy[1] ?? 'U',
        status: 'unmerged'
      })
      continue
    }
    if (record.startsWith('1 ')) {
      const segments = record.split(' ')
      const xy = segments[1] ?? '??'
      const filePath = segments[segments.length - 1] ?? ''
      entries.push({
        path: filePath,
        indexStatus: xy[0] ?? ' ',
        worktreeStatus: xy[1] ?? ' ',
        status: xyToStatus(xy[0] ?? ' ', xy[1] ?? ' ')
      })
      continue
    }
    if (record.startsWith('2 ')) {
      const segments = record.split(' ')
      const xy = segments[1] ?? '??'
      const filePath = segments[segments.length - 1] ?? ''
      const next = records[index + 1]
      const origPath = next && !/^[#1-2u?!]/.test(next) ? next : undefined
      if (origPath) {
        index += 1
      }
      entries.push({
        path: filePath,
        origPath,
        indexStatus: xy[0] ?? ' ',
        worktreeStatus: xy[1] ?? ' ',
        status: 'renamed'
      })
      continue
    }
    if (record.includes('\n') && !record.startsWith('#')) {
      // Newline-separated batch (test fixtures without -z).
      for (const line of record.split('\n')) {
        if (!line.trim()) {
          continue
        }
        const nested = parsePorcelainV2Z(line.endsWith('\0') ? line : `${line}\0`)
        entries.push(...nested.entries)
        if (!branch.head && nested.branch.head) {
          Object.assign(branch, nested.branch)
        }
      }
    }
  }

  return { branch, entries, inProgress }
}

export function parseGitLog(raw: string, limit = 50): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  const records = raw.split('\0').filter((record) => record.length > 0)
  for (let index = 0; index < records.length && entries.length < limit; index += 5) {
    const hash = records[index]
    const subject = records[index + 1]
    const author = records[index + 2]
    const email = records[index + 3]
    const date = records[index + 4]
    if (!hash || !subject) {
      break
    }
    entries.push({
      hash,
      subject,
      author: author ?? '',
      email: email ?? '',
      date: date ?? ''
    })
  }
  return entries
}

export function parseGitRemotes(raw: string): Array<z.infer<typeof gitRemoteSchema>> {
  const remotes = new Map<string, { fetchUrl: string | null; pushUrl: string | null }>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const match = /^(\S+)\s+(\S+)\s+\((\w+)\)/.exec(line)
    if (!match) {
      continue
    }
    const [, name, url, kind] = match
    const current = remotes.get(name!) ?? { fetchUrl: null, pushUrl: null }
    if (kind === 'fetch') {
      current.fetchUrl = maskRemoteUrl(url!)
    } else if (kind === 'push') {
      current.pushUrl = maskRemoteUrl(url!)
    }
    remotes.set(name!, current)
  }
  return [...remotes.entries()].map(([name, urls]) => ({
    name,
    fetchUrl: urls.fetchUrl,
    pushUrl: urls.pushUrl
  }))
}
