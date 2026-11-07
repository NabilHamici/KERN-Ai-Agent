import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { writeFileAtomic } from './atomicWrite.ts'
import { interpretDecryptResult } from './secretResult.ts'
import type { SecretStatus } from '../../shared/ipc.ts'

const BHARATCODE_FILE = 'api-key.bin'
const CURSOR_FILE = 'cursor-api-key.bin'

function secretPath(userData: string, file: string): string {
  return path.join(userData, file)
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
  const configured = storageAvailable && fs.existsSync(secretPath(userData, BHARATCODE_FILE))
  const cursorConfigured = storageAvailable && fs.existsSync(secretPath(userData, CURSOR_FILE))
  return { configured, cursorConfigured, storageAvailable }
}

async function storeNamedSecret(userData: string, file: string, apiKey: string): Promise<void> {
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
  const target = secretPath(userData, file)
  writeFileAtomic(target, encrypted)
  fs.chmodSync(target, 0o600)
}

async function readNamedSecret(userData: string, file: string, rewrite: (key: string) => Promise<void>): Promise<string | null> {
  requireAsyncStorage()
  const storageAvailable = await safeStorage.isAsyncEncryptionAvailable()
  if (!storageAvailable) {
    throw new Error('Secure storage is unavailable on this system')
  }
  const target = secretPath(userData, file)
  if (!fs.existsSync(target)) {
    return null
  }
  const decrypted: unknown = await safeStorage.decryptStringAsync(fs.readFileSync(target))
  const interpreted = interpretDecryptResult(decrypted as { result?: unknown; shouldReEncrypt?: unknown })
  if (interpreted.reencrypt) {
    await rewrite(interpreted.key)
  }
  return interpreted.key
}

function clearNamedSecret(userData: string, file: string): void {
  const target = secretPath(userData, file)
  if (fs.existsSync(target)) {
    fs.rmSync(target)
  }
}

export async function storeSecret(userData: string, apiKey: string): Promise<void> {
  await storeNamedSecret(userData, BHARATCODE_FILE, apiKey)
}

export async function readSecret(userData: string): Promise<string | null> {
  return readNamedSecret(userData, BHARATCODE_FILE, (key) => storeSecret(userData, key))
}

export async function clearSecret(userData: string): Promise<void> {
  clearNamedSecret(userData, BHARATCODE_FILE)
}

export async function storeCursorSecret(userData: string, apiKey: string): Promise<void> {
  await storeNamedSecret(userData, CURSOR_FILE, apiKey)
}

export async function readCursorSecret(userData: string): Promise<string | null> {
  return readNamedSecret(userData, CURSOR_FILE, (key) => storeCursorSecret(userData, key))
}

export async function clearCursorSecret(userData: string): Promise<void> {
  clearNamedSecret(userData, CURSOR_FILE)
}
