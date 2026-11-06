import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { isAlive, killProcessGroup } from '../src/main/services/processGroup.mjs'

test('killProcessGroup stops a background child', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 120 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const sleepPid = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const line = buffer.trim().split('\n').at(-1) ?? ''
      if (/^\d+$/.test(line)) {
        resolve(Number(line))
      }
    })
    child.once('error', reject)
    setTimeout(() => reject(new Error('child pid was not printed')), 5000)
  })

  assert.equal(isAlive(sleepPid), true)
  killProcessGroup(child.pid ?? 0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(isAlive(sleepPid), false)
  if (child.pid) {
    assert.equal(isAlive(child.pid), false)
  }
})
