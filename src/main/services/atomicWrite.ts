import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function writeFileAtomic(target: string, content: string | Buffer): void {
  const directory = path.dirname(target)
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  )
  const descriptor = fs.openSync(temporary, 'w', 0o644)
  try {
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
  } catch (error) {
    fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
    throw error
  }
  fs.closeSync(descriptor)
  try {
    fs.renameSync(temporary, target)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}
