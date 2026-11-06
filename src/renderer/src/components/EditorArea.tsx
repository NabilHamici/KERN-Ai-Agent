import { EditorPane } from '../EditorPane'
import type { EditorDiagnostic } from '../EditorPane'
import { isDirty, languageLabel } from '../editorState'
import { fileTone, Icon } from './Icons'

type BufferState = {
  baseline: string
  value: string
}

type EditorAreaProps = {
  tabs: string[]
  activePath: string | null
  loadedValue: string
  buffers: Map<string, BufferState>
  revision: number
  opening: boolean
  conflict: { path: string; disk: string } | null
  explorerHidden: boolean
  onShowExplorer: () => void
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onSave: () => void
  onOverwrite: () => void
  onReload: () => void
  onDelete: () => void
  onReady: (getValue: () => string) => void
  onChange: (path: string, value: string) => void
  onCursor: (position: { line: number; column: number }) => void
  onDiagnostics: (items: EditorDiagnostic[]) => void
}

export function EditorArea({
  tabs,
  activePath,
  loadedValue,
  buffers,
  revision,
  opening,
  conflict,
  explorerHidden,
  onShowExplorer,
  onActivate,
  onClose,
  onSave,
  onOverwrite,
  onReload,
  onDelete,
  onReady,
  onChange,
  onCursor,
  onDiagnostics
}: EditorAreaProps) {
  const active = activePath ? buffers.get(activePath) : undefined
  const dirty = active ? isDirty(active.baseline, active.value) : false
  void revision
  const crumbs = activePath ? activePath.split('/') : []

  return (
    <section className="editor-stage">
      <div className="tabbar">
        {explorerHidden ? (
          <button type="button" className="icon-hit" title="Show explorer" onClick={onShowExplorer}>
            <Icon name="chevron" />
          </button>
        ) : null}
        {tabs.length === 0 ? <span className="muted">No file open</span> : null}
        {tabs.map((path) => {
          const buffer = buffers.get(path)
          const tabDirty = buffer ? isDirty(buffer.baseline, buffer.value) : false
          const name = path.split('/').pop() ?? path
          return (
            <div key={path} className={path === activePath ? 'tab active' : 'tab'} data-tab={path} data-dirty={tabDirty ? 'true' : 'false'}>
              <button type="button" className="tab-main" onClick={() => onActivate(path)}>
                <Icon name="file" className={fileTone(name)} />
                <span>{name}</span>
                {tabDirty ? <span className="dirty-dot" title="Unsaved changes">●</span> : null}
              </button>
              <button type="button" className="tab-close" aria-label={`Close ${name}`} onClick={() => onClose(path)}>
                <Icon name="close" />
              </button>
            </div>
          )
        })}
        <div className="tab-actions">
          {activePath ? <span className="lang-label">{languageLabel(activePath)}</span> : null}
          <button type="button" className="ghost-button" disabled title="No formatter is connected.">
            Format
          </button>
          <button type="button" className="text-button" data-action="save" onClick={onSave} disabled={!activePath}>
            Save
          </button>
          <button type="button" className="text-button" data-action="delete" onClick={onDelete} disabled={!activePath}>
            Delete
          </button>
        </div>
      </div>
      {activePath ? (
        <div className="crumbs">
          {crumbs.map((part, index) => (
            <span key={`${part}-${index}`}>
              {index > 0 ? <span> &gt; </span> : null}
              {index === crumbs.length - 1 ? <b>{part}</b> : part}
            </span>
          ))}
          {dirty ? <span className="dirty-label">Unsaved</span> : null}
        </div>
      ) : null}
      <p className="save-note">Save re-reads the file and stops if the disk copy differs from the version opened here.</p>
      {conflict && conflict.path === activePath ? (
        <div className="conflict" role="alert">
          <strong>Save blocked.</strong>
          <span>This file changed outside the editor.</span>
          <button type="button" className="text-button" onClick={onReload}>
            Reload from disk
          </button>
          <button type="button" className="text-button" onClick={onOverwrite}>
            Overwrite disk
          </button>
        </div>
      ) : null}
      {opening ? <p className="muted editor-message">Opening file…</p> : null}
      {activePath ? (
        <EditorPane
          path={activePath}
          initialValue={loadedValue}
          onReady={onReady}
          onChange={onChange}
          onCursor={onCursor}
          onDiagnostics={onDiagnostics}
        />
      ) : (
        <div className="empty">
          <p className="empty-title">From intention to verified code.</p>
          <p>Open a project folder, then choose a file.</p>
          <p>Filesystem and shell access stay in the main process.</p>
        </div>
      )}
    </section>
  )
}
