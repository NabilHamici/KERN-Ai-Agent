import { loadEnv, resetEnvCache } from '../../config/env.js'
import { loadDotEnv } from '../../config/loadDotEnv.js'
import { createLogger } from '../../utils/logger.js'
import { EmailService } from './service.js'

async function main(): Promise<void> {
  loadDotEnv()
  resetEnvCache()
  const env = loadEnv()
  const logger = createLogger()
  const email = new EmailService(env, logger)
  const result = await email.verifyConnection()
  if (result.ok) {
    logger.info('SMTP connection verified')
    process.exit(0)
  }
  logger.error({ error: result.error }, 'SMTP connection verification failed')
  process.exit(env.EMAIL_DEV_MODE ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
