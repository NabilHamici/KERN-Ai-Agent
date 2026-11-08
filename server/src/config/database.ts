import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '../db/schema/index.js'
import { getEnv } from './env.js'

const { Pool } = pg

export type Database = NodePgDatabase<typeof schema>

let pool: pg.Pool | null = null
let db: Database | null = null

export function createPool(connectionString = getEnv().DATABASE_URL): pg.Pool {
  const needsSsl =
    /sslmode=(require|verify-ca|verify-full)/i.test(connectionString) ||
    /[?&]ssl=true/i.test(connectionString)
  // Strip sslmode so node-pg does not override our explicit SSL settings (needed for managed providers with intermediate CAs).
  const normalized = connectionString
    .replace(/([?&])sslmode=[^&]*/i, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?')
  return new Pool({
    connectionString: normalized,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined
  })
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = createPool()
  }
  return pool
}

export function getDb(): Database {
  if (!db) {
    db = drizzle(getPool(), { schema })
  }
  return db
}

export async function checkDatabaseConnectivity(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = await getPool().connect()
    try {
      await client.query('SELECT 1')
      return { ok: true }
    } finally {
      client.release()
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Database connectivity check failed'
    }
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
  }
  pool = null
  db = null
}
