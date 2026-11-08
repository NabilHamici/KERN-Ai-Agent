import fs from 'node:fs'
import path from 'node:path'

/** Minimal .env loader. By default does not override existing process.env values. */
export function loadDotEnv(
  filePath = path.resolve(process.cwd(), '.env'),
  options: { override?: boolean } = {}
): void {
  if (!fs.existsSync(filePath)) {
    return
  }
  const text = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const index = line.indexOf('=')
    if (index <= 0) {
      continue
    }
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (options.override || process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}
