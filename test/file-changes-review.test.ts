import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'

function harness(): { root: string; db: MissionDatabase; workspace: WorkspaceService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-changes-'))
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const workspace = new WorkspaceService(db)
  workspace.open(root)
  return { root: workspace.current()!.path, db, workspace }
}

test('keep all marks open changes without rewriting files', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'a.txt'), 'one')
  workspace.write('a.txt', 'two')
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two')
  const open = workspace.listFileChanges(20, 'open')
  assert.equal(open.length, 1)
  const result = workspace.keepFileChanges()
  assert.equal(result.kept.length, 1)
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two')
  assert.equal(workspace.listFileChanges(20, 'open').length, 0)
  assert.equal(workspace.listFileChanges(20, 'kept').length, 1)
  db.close()
})

test('undo all restores writes creates deletes and renames safely', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'edit.txt'), 'before')
  workspace.write('edit.txt', 'after')
  workspace.createFile('new.txt', 'brand')
  fs.writeFileSync(path.join(root, 'gone.txt'), 'recover')
  workspace.remove('gone.txt', true)
  fs.writeFileSync(path.join(root, 'old-name.txt'), 'move-me')
  workspace.rename('old-name.txt', 'new-name.txt', true)

  const result = workspace.undoFileChanges()
  assert.equal(result.failed.length, 0)
  assert.equal(result.undone.length, 4)
  assert.equal(fs.readFileSync(path.join(root, 'edit.txt'), 'utf8'), 'before')
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false)
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'recover')
  assert.equal(fs.existsSync(path.join(root, 'new-name.txt')), false)
  assert.equal(fs.readFileSync(path.join(root, 'old-name.txt'), 'utf8'), 'move-me')
  assert.equal(workspace.listFileChanges(20, 'open').length, 0)
  assert.equal(workspace.listFileChanges(20, 'undone').length, 4)
  db.close()
})

test('undo refuses when the applied file was modified afterwards', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  workspace.write('note.txt', 'beta')
  fs.writeFileSync(path.join(root, 'note.txt'), 'user-edit')
  const result = workspace.undoFileChanges()
  assert.equal(result.undone.length, 0)
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0]!.error, /changed after KERN/)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'user-edit')
  assert.equal(workspace.listFileChanges(20, 'open').length, 1)
  db.close()
})

test('partial undo reports successes and failures separately', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'ok.txt'), 'a')
  workspace.write('ok.txt', 'b')
  fs.writeFileSync(path.join(root, 'bad.txt'), 'a')
  workspace.write('bad.txt', 'b')
  fs.writeFileSync(path.join(root, 'bad.txt'), 'tampered')
  const result = workspace.undoFileChanges()
  assert.equal(result.undone.length, 1)
  assert.equal(result.failed.length, 1)
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'a')
  assert.equal(fs.readFileSync(path.join(root, 'bad.txt'), 'utf8'), 'tampered')
  db.close()
})

test('review builds a diff for an open change', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'review.txt'), 'old')
  workspace.write('review.txt', 'new')
  const open = workspace.listFileChanges(10, 'open')
  const review = workspace.reviewFileChange(open[0]!.id)
  assert.equal(review.relativePath, 'review.txt')
  assert.match(review.unifiedDiff, /-old/)
  assert.match(review.unifiedDiff, /\+new/)
  db.close()
})

test('agent panel uses a compact changes bar and cursor-style composer', () => {
  const panel = [
    fs.readFileSync(new URL('../src/renderer/src/components/AgentPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/ChangesBar.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/Composer.tsx', import.meta.url), 'utf8')
  ].join('\n')
  assert.equal(panel.includes('data-changes-bar'), true)
  assert.equal(panel.includes('data-changes-toggle'), true)
  assert.equal(panel.includes('data-action="changes-undo-all"'), true)
  assert.equal(panel.includes('data-action="changes-keep-all"'), true)
  assert.equal(panel.includes('data-action="changes-review"'), true)
  assert.equal(panel.includes('Plan, build, ask KERN'), true)
  assert.equal(panel.includes('compose-shell'), true)
  assert.equal(panel.includes('Recorded file changes'), false)
})
