import { useEffect, useRef, useState } from 'react'
import type { AgentChatSummary } from '../../../../shared/agent.ts'

type HistoryMenuProps = {
  chats: AgentChatSummary[]
  activeChatId: string | null
  workspaceOpen: boolean
  running: boolean
  onSelectChat: (chatId: string) => void
  onRenameChat: (chatId: string) => void
  onArchiveChat: (chatId: string) => void
}

export function HistoryMenu({
  chats,
  activeChatId,
  workspaceOpen,
  running,
  onSelectChat,
  onRenameChat,
  onArchiveChat
}: HistoryMenuProps) {
  const [open, setOpen] = useState(false)
  const [menuChatId, setMenuChatId] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointer = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
        setMenuChatId(null)
      }
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  return (
    <div className="history-menu" data-chat-history ref={root}>
      <button
        type="button"
        className="icon-hit history-menu-toggle"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Chat history"
        onClick={() => setOpen((value) => !value)}
      >
        History ▾
      </button>
      {open ? (
        <div className="history-menu-panel" role="menu">
          {!workspaceOpen ? <p className="muted">Open a folder to start chatting.</p> : null}
          {workspaceOpen && chats.length === 0 ? <p className="muted">No chats yet.</p> : null}
          {chats.map((item) => {
            const active = activeChatId === item.id
            return (
              <div key={item.id} className={active ? 'history-menu-item is-active' : 'history-menu-item'}>
                <button
                  type="button"
                  role="menuitem"
                  className="history-menu-main"
                  data-chat-id={item.id}
                  disabled={running && !active}
                  onClick={() => {
                    setOpen(false)
                    onSelectChat(item.id)
                  }}
                >
                  <span className="history-menu-title">{item.title}</span>
                  <span className="muted">{formatChatActivity(item.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="history-menu-more"
                  aria-label={`Chat actions for ${item.title}`}
                  disabled={running && !active}
                  onClick={() => setMenuChatId((current) => (current === item.id ? null : item.id))}
                >
                  ···
                </button>
                {menuChatId === item.id ? (
                  <div className="history-menu-actions" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuChatId(null)
                        setOpen(false)
                        onRenameChat(item.id)
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuChatId(null)
                        setOpen(false)
                        onArchiveChat(item.id)
                      }}
                    >
                      Archive
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function formatChatActivity(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const delta = Math.max(0, Date.now() - date.getTime())
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'Just now'
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
