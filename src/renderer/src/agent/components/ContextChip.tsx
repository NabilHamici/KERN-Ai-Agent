import { useState } from 'react'

type ContextChipProps = {
  paths: string[]
}

export function ContextChip({ paths }: ContextChipProps) {
  const [open, setOpen] = useState(false)
  if (paths.length === 0) {
    return null
  }
  return (
    <div className="context-chip-wrap" data-context-chip>
      <button
        type="button"
        className="compose-chip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Context · {paths.length} file{paths.length === 1 ? '' : 's'}
      </button>
      {open ? (
        <ul className="context-chip-list" role="list">
          {paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
