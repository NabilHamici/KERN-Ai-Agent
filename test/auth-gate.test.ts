import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { isPublicAuthChannel, IpcChannel, requestSchemas } from '../src/shared/ipc.ts'

test('auth IPC channels are registered and public auth channels stay limited', () => {
  const publicChannels = [
    IpcChannel.authStatus,
    IpcChannel.authRegister,
    IpcChannel.authLogin,
    IpcChannel.authVerify,
    IpcChannel.authResend,
    IpcChannel.authForgot,
    IpcChannel.authReset,
    IpcChannel.authRetry
  ]
  for (const channel of publicChannels) {
    assert.equal(isPublicAuthChannel(channel), true)
    assert.ok(channel in requestSchemas)
  }
  assert.equal(isPublicAuthChannel(IpcChannel.agentSubmit), false)
  assert.equal(isPublicAuthChannel(IpcChannel.workspaceRead), false)
  assert.equal(isPublicAuthChannel(IpcChannel.authLogoutAll), false)
  assert.equal(isPublicAuthChannel(IpcChannel.authMe), false)
})

test('renderer cannot reach refresh tokens or safeStorage', () => {
  const forbidden = ['safeStorage', 'refreshToken', 'auth-session.bin', 'Authorization: Bearer']
  const roots = [path.join('src', 'renderer'), path.join('src', 'preload')]
  for (const root of roots) {
    const walk = (directory: string): string[] =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    for (const file of walk(root).filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))) {
      const source = fs.readFileSync(file, 'utf8')
      for (const token of forbidden) {
        assert.equal(source.includes(token), false, `${file} contains ${token}`)
      }
    }
  }
})

test('main process owns auth vault paths and offline grace constant', () => {
  const source = fs.readFileSync(path.join('src', 'main', 'services', 'authSession.ts'), 'utf8')
  assert.match(source, /auth-session\.bin/)
  assert.match(source, /OFFLINE_GRACE_MS = 7 \* 24 \* 60 \* 60 \* 1000/)
  assert.match(source, /safeStorage/)
  assert.equal(source.includes('localStorage'), false)
})

test('auth UI and gate are present', () => {
  assert.equal(fs.existsSync(path.join('src', 'renderer', 'src', 'components', 'AuthShell.tsx')), true)
  assert.equal(fs.existsSync(path.join('src', 'renderer', 'src', 'AuthGate.tsx')), true)
  assert.equal(fs.existsSync(path.join('src', 'renderer', 'src', 'assets', 'kern-logo.svg')), true)
  const main = fs.readFileSync(path.join('src', 'renderer', 'src', 'main.tsx'), 'utf8')
  assert.match(main, /AuthGate/)
})
