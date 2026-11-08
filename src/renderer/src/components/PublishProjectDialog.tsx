import { useEffect, useState } from 'react'

type PublishProbe = {
  isRepo: boolean
  hasCommits: boolean
  identity: { name: string | null; email: string | null; configured: boolean }
  remotes: Array<{ name: string; fetchUrl: string | null; pushUrl: string | null }>
  gitignoreExists: boolean
  ghAvailable: boolean
}

type PublishProjectDialogProps = {
  open: boolean
  onClose: () => void
  onPublished?: () => void
}

export function PublishProjectDialog({ open, onClose, onPublished }: PublishProjectDialogProps) {
  const [probe, setProbe] = useState<PublishProbe | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [gitignore, setGitignore] = useState('')
  const [scanFindings, setScanFindings] = useState<
    Array<{ path: string; reason: string; sizeBytes?: number }>
  >([])
  const [commitMessage, setCommitMessage] = useState('Initial commit')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [identityName, setIdentityName] = useState('')
  const [identityEmail, setIdentityEmail] = useState('')
  const [exportNote, setExportNote] = useState('')
  const [pushNote, setPushNote] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setError('')
    setScanFindings([])
    setPushNote('')
    setExportNote('')
    void window.kern.git.publishProbe().then((result) => {
      if (cancelled) {
        return
      }
      if (!result.ok) {
        setError(result.error)
        setProbe(null)
        return
      }
      setProbe(result.data)
      setIdentityName(result.data.identity.name ?? '')
      setIdentityEmail(result.data.identity.email ?? '')
    })
    void window.kern.git.ignorePreview({}).then((result) => {
      if (cancelled || !result.ok) {
        return
      }
      setGitignore(result.data.content)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  async function ensureRepo(): Promise<boolean> {
    if (probe?.isRepo) {
      return true
    }
    setBusy(true)
    const result = await window.kern.git.init()
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    const next = await window.kern.git.publishProbe()
    if (next.ok) {
      setProbe(next.data)
    }
    return true
  }

  async function saveGitignore(): Promise<void> {
    setBusy(true)
    const result = await window.kern.git.ignoreWrite({ content: gitignore, confirm: true })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError('')
  }

  async function runScan(): Promise<void> {
    setBusy(true)
    const result = await window.kern.git.scanCommit({})
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setScanFindings(result.data)
    setError('')
  }

  async function saveIdentity(): Promise<void> {
    if (!identityName.trim() || !identityEmail.trim()) {
      setError('Name and email are required for git commits.')
      return
    }
    setBusy(true)
    const result = await window.kern.git.setIdentity({
      local: true,
      name: identityName.trim(),
      email: identityEmail.trim()
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError('')
  }

  async function commitAll(): Promise<void> {
    setBusy(true)
    const staged = await window.kern.git.stage({ paths: 'all' })
    if (!staged.ok) {
      setBusy(false)
      setError(staged.error)
      return
    }
    const committed = await window.kern.git.commit({ message: commitMessage.trim() || 'Initial commit' })
    setBusy(false)
    if (!committed.ok) {
      setError(committed.error)
      return
    }
    setError('')
    onPublished?.()
    const next = await window.kern.git.publishProbe()
    if (next.ok) {
      setProbe(next.data)
    }
  }

  async function addRemoteAndPush(): Promise<void> {
    const url = remoteUrl.trim()
    if (!url) {
      setError('Enter a remote URL (https://github.com/owner/repo.git).')
      return
    }
    setBusy(true)
    const remote = await window.kern.git.addRemote({ name: 'origin', url })
    if (!remote.ok) {
      setBusy(false)
      setError(remote.error)
      return
    }
    const pushed = await window.kern.git.push({ remote: 'origin', setUpstream: true })
    setBusy(false)
    if (!pushed.ok) {
      setError(pushed.error)
      return
    }
    setPushNote('Pushed to origin.')
    setError('')
    onPublished?.()
  }

  async function exportProject(): Promise<void> {
    setBusy(true)
    const preview = await window.kern.git.exportPreview({})
    if (!preview.ok) {
      setBusy(false)
      setError(preview.error)
      return
    }
    const written = await window.kern.git.export({ includeGit: false })
    setBusy(false)
    if (!written.ok) {
      if (written.error === 'Export canceled') {
        return
      }
      setError(written.error)
      return
    }
    setExportNote(`Exported ${written.data.fileCount} files (${Math.round(written.data.bytes / 1024)} KB).`)
    setError('')
  }

  return (
    <div className="settings-layer" hidden={!open}>
      <div className="settings-card publish-card" role="dialog" aria-labelledby="publish-title">
        <div className="pane-title">
          <h2 id="publish-title">Publish project</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? <p className="hint warn-hint">{error}</p> : null}
        {pushNote ? <p className="hint">{pushNote}</p> : null}
        {exportNote ? <p className="hint">{exportNote}</p> : null}

        <section className="settings-section">
          <h3>1 · Repository</h3>
          <p className="hint">
            {probe?.isRepo ? 'Git repository detected.' : 'Initialize git in this workspace.'}
            {probe?.hasCommits ? ' · Has commits.' : ''}
          </p>
          <button type="button" className="text-button" disabled={busy || probe?.isRepo} onClick={() => void ensureRepo()}>
            {probe?.isRepo ? 'Initialized' : 'git init'}
          </button>
        </section>

        <section className="settings-section">
          <h3>2 · .gitignore</h3>
          <textarea
            className="publish-textarea"
            rows={6}
            spellCheck={false}
            value={gitignore}
            onChange={(event) => setGitignore(event.target.value)}
          />
          <button type="button" className="text-button" disabled={busy || !gitignore.trim()} onClick={() => void saveGitignore()}>
            Save .gitignore
          </button>
        </section>

        <section className="settings-section">
          <h3>3 · Scan</h3>
          <button type="button" className="text-button" disabled={busy} onClick={() => void runScan()}>
            Scan staged changes
          </button>
          {scanFindings.length > 0 ? (
            <ul className="publish-findings">
              {scanFindings.map((item) => (
                <li key={item.path}>
                  {item.path} — {item.reason}
                  {item.sizeBytes ? ` (${Math.round(item.sizeBytes / 1024)} KB)` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Check for secrets and large files before committing.</p>
          )}
        </section>

        <section className="settings-section">
          <h3>4 · Identity &amp; commit</h3>
          {!probe?.identity.configured ? (
            <div className="publish-identity">
              <input
                placeholder="Git name"
                value={identityName}
                onChange={(event) => setIdentityName(event.target.value)}
              />
              <input
                placeholder="Git email"
                value={identityEmail}
                onChange={(event) => setIdentityEmail(event.target.value)}
              />
              <button type="button" className="text-button" disabled={busy} onClick={() => void saveIdentity()}>
                Save identity
              </button>
            </div>
          ) : (
            <p className="hint">
              {probe.identity.name} &lt;{probe.identity.email}&gt;
            </p>
          )}
          <input
            className="publish-commit"
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder="Commit message"
          />
          <button type="button" className="text-button" disabled={busy} onClick={() => void commitAll()}>
            Stage all &amp; commit
          </button>
        </section>

        <section className="settings-section">
          <h3>5 · Remote</h3>
          {probe?.ghAvailable ? (
            <p className="hint">GitHub CLI (gh) is available — you can also create a repo with gh and add origin.</p>
          ) : (
            <p className="hint">Add a remote URL, then push. Create the empty repo on GitHub first.</p>
          )}
          <input
            className="publish-commit"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="https://github.com/you/project.git"
          />
          <button type="button" className="text-button" disabled={busy} onClick={() => void addRemoteAndPush()}>
            Add origin &amp; push
          </button>
        </section>

        <section className="settings-section">
          <h3>Export</h3>
          <button type="button" className="text-button" disabled={busy} onClick={() => void exportProject()}>
            Export zip…
          </button>
        </section>
      </div>
    </div>
  )
}
