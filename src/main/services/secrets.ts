import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { writeFileAtomic } from './atomicWrite.ts'
import type { SecretStatus } from '../../shared/ipc.ts'

const SECRET_FILE = 'api-key.bin'

function secretPath(userData: string): string {
  return path.join(userData, SECRET_FILE)
}

function requireAsyncStorage(): void {
  if (
    typeof safeStorage.isAsyncEncryptionAvailable !== 'function' ||
    typeof safeStorage.encryptStringAsync !== 'function' ||
    typeof safeStorage.decryptStringAsync !== 'function'
  ) {
    throw new Error('Secure storage is unavailable on this system')
  }
}

export async function secretStatus(userData: string): Promise<SecretStatus> {
  requireAsyncStorage()
  const storageAvailable = await safeStorage.isAsyncEncryptionAvailable()
  const configured = storageAvailable && fs.existsSync(secretPath(userData))
  return { configured, storageAvailable }
}

export async function storeSecret(userData: string, apiKey: string): Promise<void> {
  requireAsyncStorage()
  const storageAvailable = await safeStorage.isAsyncEncryptionAvailable()
  if (!storageAvailable) {
    throw new Error('Secure storage is unavailable on this system')
  }
  const encrypted = Buffer.from(await safeStorage.encryptStringAsync(apiKey))
  if (encrypted.length === 0) {
    throw new Error('Secure storage is unavailable on this system')
  }
  fs.mkdirSync(userData, { recursive: true })
  writeFileAtomic(secretPath(userData), encrypted)
  fs.chmodSync(secretPath(userData), 0o600)
}

export async function clearSecret(userData: string): Promise<void> {
  const target = secretPath(userData)
  if (fs.existsSync(target)) {
    fs.rmSync(target)
  }
}
