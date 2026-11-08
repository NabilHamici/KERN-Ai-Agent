import { loadEnv, resetEnvCache } from './config/env.js'
import { loadDotEnv } from './config/loadDotEnv.js'
import { checkDatabaseConnectivity, closeDatabase, getDb } from './config/database.js'
import { createApp } from './app.js'
import { EmailService } from './modules/email/service.js'
import { createLogger } from './utils/logger.js'

async function main(): Promise<void> {
  loadDotEnv()
  resetEnvCache()
  const env = loadEnv()
  const logger = createLogger()
  const email = new EmailService(env, logger)
  const db = getDb()

  const database = await checkDatabaseConnectivity()
  if (!database.ok) {
    logger.error({ error: database.error }, 'Database is unavailable at startup')
    if (env.NODE_ENV === 'production') {
      process.exit(1)
    }
    logger.warn('Continuing in non-production mode despite database failure')
  } else {
    logger.info('Database connectivity verified')
  }

  const smtp = await email.verifyConnection()
  if (!smtp.ok) {
    if (env.NODE_ENV === 'production' && !env.EMAIL_DEV_MODE) {
      logger.error({ error: smtp.error }, 'SMTP verification failed')
      process.exit(1)
    }
    logger.warn({ error: smtp.error }, 'SMTP is not verified; email delivery may fail')
  } else {
    logger.info('SMTP connectivity verified')
  }

  const app = createApp({ env, logger, email, db })
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'KERN server listening')
  })

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down')
    server.close(async () => {
      await closeDatabase()
      process.exit(0)
    })
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
