import { z } from 'zod'

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value
    }
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true
    }
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
      return false
    }
    throw new Error(`Invalid boolean value: ${value}`)
  })

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    APP_URL: z.string().url('APP_URL must be a valid URL'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      )
      .pipe(z.array(z.string().url()).min(1, 'CORS_ORIGINS must include at least one origin')),
    SMTP_HOST: z.string().optional().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanish.default(false),
    SMTP_USER: z.string().optional().default(''),
    SMTP_PASS: z.string().optional().default(''),
    SMTP_FROM_NAME: z.string().min(1).default('KERN'),
    SMTP_FROM_EMAIL: z.string().email().optional().or(z.literal('')).default(''),
    EMAIL_DEV_MODE: booleanish.default(true),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    OFFLINE_GRACE_DAYS: z.coerce.number().int().min(1).max(30).default(7)
  })
  .superRefine((env, ctx) => {
    const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_FROM_EMAIL)
    if (env.NODE_ENV === 'production') {
      if (!smtpConfigured) {
        ctx.addIssue({
          code: 'custom',
          message: 'SMTP_HOST and SMTP_FROM_EMAIL are required in production',
          path: ['SMTP_HOST']
        })
      }
      if (env.EMAIL_DEV_MODE) {
        ctx.addIssue({
          code: 'custom',
          message: 'EMAIL_DEV_MODE must be false in production',
          path: ['EMAIL_DEV_MODE']
        })
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          message: 'Wildcard CORS origins are not allowed in production',
          path: ['CORS_ORIGINS']
        })
      }
    }
  })

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }
  return parsed.data
}

export function getEnv(): Env {
  if (!cached) {
    cached = loadEnv()
  }
  return cached
}

export function resetEnvCache(): void {
  cached = null
}

export function smtpIsConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM_EMAIL)
}
