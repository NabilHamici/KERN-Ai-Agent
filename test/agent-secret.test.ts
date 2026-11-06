import assert from 'node:assert/strict'
import test from 'node:test'
import { interpretDecryptResult } from '../src/main/services/secretResult.ts'
import { redactSensitive } from '../src/shared/agent.ts'

test('reads the decrypt result and flags re-encryption', () => {
  assert.deepEqual(interpretDecryptResult({ result: 'stored-key', shouldReEncrypt: true }), {
    key: 'stored-key',
    reencrypt: true
  })
  assert.equal(interpretDecryptResult({ result: 'stored-key', shouldReEncrypt: false }).reencrypt, false)
  assert.throws(() => interpretDecryptResult('stored-key' as never), /Secure storage is unavailable/)
  assert.throws(() => interpretDecryptResult({ result: '' }), /Secure storage is unavailable/)
})

test('redacts bearer tokens and the stored key', () => {
  const secret = 'bc_live_runtime_secret'
  const text = redactSensitive(`Authorization: Bearer ${secret}`, secret)
  assert.equal(text.includes(secret), false)
  assert.match(text, /\[redacted\]/)
})
