import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findRiskyCommitPaths,
  generateGitignore,
  maskRemoteUrl,
  parseGitLog,
  parseGitRemotes,
  parsePorcelainV2Z,
  validateRemoteUrl
} from '../src/shared/git.ts'
import { resetGitExecutableCache, resolveGitExecutable } from '../src/main/services/gitResolve.ts'
import { GitError, GitService } from '../src/main/services/gitService.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fixture(parts: string[]): string {
  return parts.join('\0') + (parts.length ? '\0' : '')
}

test('validateRemoteUrl accepts https, ssh, and scp-like remotes', () => {
  const ok = [
    'https://github.com/org/repo.git',
    'https://gitlab.com/group/project',
    'git@github.com:org/repo.git',
    'user@gitlab.com:group/project.git'
  ]
  for (const url of ok) {
    const result = validateRemoteUrl(url)
    assert.equal(result.ok, true, url)
  }
})

test('validateRemoteUrl rejects unsafe and credential URLs', () => {
  const bad: Array<[string, string]> = [
    ['file:///tmp/repo', 'scheme'],
    ['ext::destination', 'scheme'],
    [' -https://example.com', '-'],
    ['https://evil.com/foo bar', 'whitespace'],
    ['https://user:token@github.com/org/repo.git', 'credential']
  ]
  for (const [url, hint] of bad) {
    const result = validateRemoteUrl(url)
    assert.equal(result.ok, false, `${hint}: ${url}`)
  }
})

test('maskRemoteUrl redacts embedded credentials', () => {
  assert.equal(maskRemoteUrl('https://user:token@github.com/org/repo.git'), 'https://***@github.com/org/repo.git')
  assert.equal(maskRemoteUrl('https://github.com/org/repo.git'), 'https://github.com/org/repo.git')
})

test('parsePorcelainV2Z handles branch headers, modified, untracked, rename, and unborn', () => {
  const raw = fixture([
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 123 456 src/app.ts',
    '2 R. N... 100644 100644 100644 111 222 R100 src/new-name.ts',
    'src/old-name.ts',
    '? untracked file with spaces.txt',
    '! node_modules/pkg/index.js'
  ])
  const parsed = parsePorcelainV2Z(raw)
  assert.equal(parsed.branch.head, 'main')
  assert.equal(parsed.branch.ahead, 2)
  assert.equal(parsed.branch.behind, 1)
  assert.equal(parsed.entries.length, 4)
  assert.equal(parsed.entries.find((e) => e.path === 'src/app.ts')?.status, 'modified')
  const renamed = parsed.entries.find((e) => e.path === 'src/new-name.ts')
  assert.equal(renamed?.status, 'renamed')
  assert.equal(renamed?.origPath, 'src/old-name.ts')
  assert.equal(parsed.entries.find((e) => e.path === 'untracked file with spaces.txt')?.status, 'untracked')
})

test('parseGitLog and parseGitRemotes', () => {
  const logRaw = `abc123\0Initial commit\0Alice\0alice@example.com\0${'2025-01-01T00:00:00+00:00'}\0`
  const entries = parseGitLog(logRaw, 5)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.hash, 'abc123')
  assert.equal(entries[0]!.subject, 'Initial commit')

  const remotes = parseGitRemotes(
    'origin\thttps://user:secret@github.com/org/repo.git\t(fetch)\norigin\thttps://user:secret@github.com/org/repo.git\t(push)\n'
  )
  assert.equal(remotes.length, 1)
  assert.match(remotes[0]!.fetchUrl ?? '', /\*\*\*@/)
})

test('generateGitignore includes node, expo, and react-native stacks', () => {
  const node = generateGitignore('node')
  assert.match(node, /node_modules/)
  assert.match(node, /\.env\.\*/)
  const expo = generateGitignore('expo')
  assert.match(expo, /\.expo/)
  const rn = generateGitignore('react-native')
  assert.match(rn, /android\/build/)
})

test('findRiskyCommitPaths flags env files, keys, and large files', () => {
  const root = tempDir('kern-git-risk-')
  const large = path.join(root, 'big.bin')
  fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=1')
  fs.writeFileSync(path.join(root, 'deploy.pem'), 'key')
  fs.writeFileSync(large, Buffer.alloc(26 * 1024 * 1024, 1))
  const findings = findRiskyCommitPaths(
    root,
    ['.env.local', 'deploy.pem', 'big.bin', 'src/index.ts'],
    (absolute) => {
      try {
        return fs.statSync(absolute)
      } catch {
        return null
      }
    }
  )
  assert.equal(findings.some((f) => f.reason === 'env_file'), true)
  assert.equal(findings.some((f) => f.reason === 'private_key'), true)
  assert.equal(findings.some((f) => f.reason === 'large_file'), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('GitService integration: init, commit, branch, push to bare remote', async () => {
  const git = await resolveGitExecutable()
  if (!git) {
    test.skip('git executable not available')
    return
  }

  const workspace = tempDir('kern-git-ws-')
  const bare = tempDir('kern-git-bare-')
  execFileSync(git, ['init', '--bare', '-b', 'main'], { cwd: bare })

  const service = new GitService(workspace)
  await service.init('main')
  await service.setLocalIdentity('KERN Test', 'kern@test.local')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# hello\n')
  await service.stage(['README.md'])
  const hash = await service.commit('Initial commit')
  assert.match(hash, /^[0-9a-f]{40}$/)

  await service.createBranch('feature')
  await service.switchBranch('feature')
  const branch = await service.currentBranch()
  assert.equal(branch, 'feature')

  assert.equal(validateRemoteUrl(`file://${bare}`).ok, false)

  const remotePath = bare.replace(/\\/g, '/')
  await service.addRemote('origin', remotePath)
  await service.push({ remote: 'origin', branch: 'feature', setUpstream: true })

  const refs = fs.readdirSync(path.join(bare, 'refs', 'heads'))
  assert.ok(refs.includes('feature'))

  const status = await service.status()
  assert.equal(status.branch.head, 'feature')

  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(bare, { recursive: true, force: true })
  resetGitExecutableCache()
})

test('GitService refuses merge/rebase in progress and forbidden flags', async () => {
  const git = await resolveGitExecutable()
  if (!git) {
    test.skip('git executable not available')
    return
  }
  const workspace = tempDir('kern-git-busy-')
  const service = new GitService(workspace)
  await service.init('main')
  fs.writeFileSync(path.join(workspace, '.git', 'MERGE_HEAD'), 'deadbeef\n')
  await assert.rejects(() => service.commit('blocked'), (error: unknown) => {
    assert.ok(error instanceof GitError)
    assert.equal(error.code, 'operation_in_progress')
    return true
  })
  await assert.rejects(
    () => service.exec(['push', '--force', 'origin', 'main']),
    (error: unknown) => {
      assert.ok(error instanceof GitError)
      assert.equal(error.code, 'forbidden_flag')
      return true
    }
  )
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('resolveGitExecutable returns an absolute path when git is installed', async () => {
  resetGitExecutableCache()
  const resolved = await resolveGitExecutable({ refresh: true })
  if (!resolved) {
    test.skip('git executable not available')
    return
  }
  assert.ok(path.isAbsolute(resolved))
  assert.equal(fs.existsSync(resolved), true)
})
