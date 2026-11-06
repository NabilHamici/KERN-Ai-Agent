export type DecryptPayload = {
  result?: unknown
  shouldReEncrypt?: unknown
}

export function interpretDecryptResult(value: DecryptPayload | null | undefined): { key: string; reencrypt: boolean } {
  if (!value || typeof value !== 'object' || typeof value.result !== 'string' || value.result.length === 0) {
    throw new Error('Secure storage is unavailable on this system')
  }
  return { key: value.result, reencrypt: value.shouldReEncrypt === true }
}
