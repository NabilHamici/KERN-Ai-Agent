import fs from 'node:fs'
import path from 'node:path'
import { maskRemoteUrl } from '../../shared/git.ts'

export type AuditEntry = {
  ts: string
  actor: 'user' | 'system'
  action: string
  detail?: Record<string, unknown>
}

/** Append-only audit log under userData. Never stores credentials. */
export class AuditLog {
  private readonly file: string

  constructor(userData: string) {
    this.file = path.join(userData, 'audit.log')
  }

  write(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): void {
    const record: AuditEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail ? scrub(entry.detail) : undefined
    }
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
  }
}

function scrub(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string') {
      out[key] = /url|remote|repo/i.test(key) ? maskRemoteUrl(value) : redactSecrets(value)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrub(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

function redactSecrets(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***:***@')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted]')
    .replace(/\bbc_live_[A-Za-z0-9_-]+\b/g, '[redacted]')
}
