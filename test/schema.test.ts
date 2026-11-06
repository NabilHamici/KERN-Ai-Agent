import assert from 'node:assert/strict'
import test from 'node:test'
import { IpcChannel, parseRequest } from '../src/shared/ipc.ts'

const secret = 'bc_live_acceptance_key_should_not_leak'

test('rejects invalid IPC payloads without echoing the API key', () => {
  const cases = [
    [IpcChannel.workspaceRead, { path: 12 }],
    [IpcChannel.workspaceRead, { path: '../outside.txt', extra: true }],
    [IpcChannel.workspaceRemove, { path: 'file.txt', confirm: false }],
    [IpcChannel.workspaceRename, { from: 'a', to: 'b' }],
    [IpcChannel.secretsSet, { apiKey: '' }],
    [IpcChannel.secretsSet, { apiKey: secret, leaked: true }],
    [IpcChannel.secretsSet, { apiKey: `${secret}\n` }],
    [IpcChannel.terminalWrite, { data: 'x'.repeat(70_000) }],
    ['shell:exec', { command: 'rm -rf /' }]
  ] as const

  for (const [channel, payload] of cases) {
    const result = parseRequest(channel, payload)
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.error, 'Invalid request')
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

test('accepts a well-formed workspace and secret request', () => {
  const read = parseRequest(IpcChannel.workspaceRead, { path: 'src/main.ts' })
  assert.equal(read.ok, true)
  const stored = parseRequest(IpcChannel.secretsSet, { apiKey: secret })
  assert.equal(stored.ok, true)
  if (stored.ok) {
    assert.equal((stored.data as { apiKey: string }).apiKey, secret)
  }
})
