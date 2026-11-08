import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GitService } from './gitService.ts'

export type ExportPreview = {
  fileCount: number
  totalBytes: number
  paths: string[]
}

/** List tracked + non-ignored files for export (honors .gitignore). */
export async function listExportPaths(
  git: GitService,
  options: { includeGit?: boolean } = {}
): Promise<ExportPreview> {
  const result = await git.exec(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || 'Unable to list export files.').slice(0, 500))
  }
  const root = git.workspace()
  const paths = result.stdout
    .split('\0')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((relative) => {
      const parts = relative.split('/')
      if (parts.includes('node_modules')) return false
      if (!options.includeGit && parts[0] === '.git') return false
      return true
    })
  let totalBytes = 0
  const existing: string[] = []
  for (const relative of paths) {
    const absolute = path.join(root, relative)
    try {
      const stat = fs.statSync(absolute)
      if (stat.isFile()) {
        totalBytes += stat.size
        existing.push(relative)
      }
    } catch {
      // skip missing
    }
  }
  return { fileCount: existing.length, totalBytes, paths: existing }
}

/** Write a zip of export paths to destination via system zip. */
export async function writeExportZip(
  root: string,
  paths: string[],
  destination: string
): Promise<{ bytes: number; fileCount: number }> {
  if (paths.length === 0) {
    throw new Error('Nothing to export.')
  }
  const zipPath = path.resolve(destination)
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath)
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('zip', ['-q', '-@', zipPath], {
      cwd: root,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error((stderr || `zip exited with ${code}`).slice(0, 500)))
    })
    child.stdin?.end(`${paths.join('\n')}\n`)
  })
  const stat = fs.statSync(zipPath)
  return { bytes: stat.size, fileCount: paths.length }
}
