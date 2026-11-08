import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('security and architecture guards', () => {
  it('does not publish postgres ports in production compose', () => {
    const compose = readFileSync(path.join(root, 'deploy/docker-compose.yml'), 'utf8')
    expect(compose).toContain('internal: true')
    expect(compose).toMatch(/postgres:[\s\S]*# Intentionally no public ports/)
    expect(compose).not.toMatch(/postgres:[\s\S]*ports:\s*\n\s*-\s*['"]?5432/)
  })

  it('keeps secrets out of example env files', () => {
    const example = readFileSync(path.join(root, 'server/.env.example'), 'utf8')
    expect(example).toContain('DATABASE_URL=')
    expect(example).not.toMatch(/AVNS_|bc_live_|password=AVNS/)
    expect(example).toContain('SMTP_PASS=')
  })

  it('does not add cloud filesystem or terminal APIs in the backend app', () => {
    const app = readFileSync(path.join(root, 'server/src/app.ts'), 'utf8')
    expect(app).not.toMatch(/workspace|terminal|filesystem|shell/i)
    expect(app).toContain('/api/v1')
  })
})
