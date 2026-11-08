import { migrate } from 'drizzle-orm/node-postgres/migrator'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDb, getPool } from '../config/database.js'
import { loadEnv, resetEnvCache } from '../config/env.js'
import { loadDotEnv } from '../config/loadDotEnv.js'
import { createLogger } from '../utils/logger.js'

const here = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  // Prefer server/.env over a shell DATABASE_URL so migrations cannot silently hit the wrong DB.
  loadDotEnv(path.resolve(process.cwd(), '.env'), { override: true })
  resetEnvCache()
  const env = loadEnv()
  const logger = createLogger()
  const migrationsFolder = path.join(here, 'migrations')
  const target = new URL(env.DATABASE_URL)
  logger.info(
    {
      migrationsFolder,
      host: target.hostname,
      port: target.port || '5432',
      database: target.pathname.replace(/^\//, ''),
      user: target.username
    },
    'Running database migrations'
  )
  await getPool().query('SELECT 1')
  await migrate(getDb(), { migrationsFolder })
  logger.info('Migrations applied successfully')
  await closeDatabase()
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error)
  try {
    await closeDatabase()
  } catch {
    // ignore
  }
  process.exit(1)
})
