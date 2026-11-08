import { defineConfig } from 'drizzle-kit'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for drizzle-kit')
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL
  },
  strict: true,
  verbose: true
})
