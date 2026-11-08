import { Icon } from '../../components/Icons'

export type FileChange = {
  id: string
  relativePath: string
  changeType: string
  createdAt: string
  hasReverse?: boolean
  reviewStatus?: 'open' | 'kept' | 'undone'
}

type ChangesBarProps = {
  changes: FileChange[]
  expanded: boolean
  onToggle: () => void
  onKeepAll: () => void
  onUndoAll: () => void
  onReview: () => void
  onReviewOne: (changeId: string) => void
  additions?: number
  deletions?: number
}

export function ChangesBar({
  changes,
  expanded,
  onToggle,
  onKeepAll,
  onUndoAll,
  onReview,
  onReviewOne,
  additions,
  deletions
}: ChangesBarProps) {
  const fileCount = new Set(changes.map((change) => change.relativePath)).size
  if (fileCount === 0) {
    return null
  }
  const stats =
    typeof additions === 'number' || typeof deletions === 'number'
      ? ` +${additions ?? 0} −${deletions ?? 0}`
      : ''
  return (
    <section className={expanded ? 'changes-bar is-open' : 'changes-bar'} data-changes-bar>
      <div className="changes-bar-row">
        <button type="button" className="changes-bar-toggle" data-changes-toggle onClick={onToggle} aria-expanded={expanded}>
          <Icon name={expanded ? 'chevron-down' : 'chevron'} />
          <span>
            {fileCount} file{fileCount === 1 ? '' : 's'} changed{stats}
          </span>
        </button>
        <div className="changes-bar-actions">
          <button type="button" className="text-button" data-action="changes-review" onClick={onReview}>
            Review
          </button>
          <button type="button" className="text-button" data-action="changes-keep-all" onClick={onKeepAll}>
            Keep all
          </button>
          <button type="button" className="text-button" data-action="changes-undo-all" onClick={onUndoAll}>
            Undo all
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="changes-bar-list" data-changes-list>
          {changes.map((change) => (
            <button
              key={change.id}
              type="button"
              className="change-row"
              data-file-change={change.relativePath}
              onClick={() => onReviewOne(change.id)}
            >
              <span>{change.changeType}</span>
              <span>{change.relativePath}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
