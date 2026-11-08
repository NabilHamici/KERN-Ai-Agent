import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type {
  AgentChatSummary,
  AgentMissionSummary,
  AgentOperationSummary,
  AgentToolRecord
} from '../../../shared/agent'
import type { ProviderId } from '../../../shared/provider'
import { canCancel, shouldFollowTranscript, type ConversationEntry } from '../conversation'
import { ChangesBar, type FileChange } from '../agent/components/ChangesBar'
import { Composer } from '../agent/components/Composer'
import { HistoryMenu } from '../agent/components/HistoryMenu'
import { StatusBar } from '../agent/components/StatusBar'
import { Timeline } from '../agent/components/Timeline'
import { deriveAgentUiStatus, statusPhaseKey } from '../agent/statusMachine'
import { buildTimeline } from '../agent/timeline'
import { Icon } from './Icons'

type ReviewItem = {
  id: string
  relativePath: string
  changeType: string
  reviewStatus: 'open' | 'kept' | 'undone'
  hasReverse: boolean
  unifiedDiff: string
  error: string | null
}

type AgentPanelProps = {
  changes: FileChange[]
  providerReady: boolean
  providerDetail: string
  providerId: ProviderId
  workspaceOpen: boolean
  chat: AgentChatSummary | null
  chats: AgentChatSummary[]
  mission: AgentMissionSummary | null
  missions: AgentMissionSummary[]
  running: boolean
  messages: ConversationEntry[]
  tools: AgentToolRecord[]
  operations: AgentOperationSummary[]
  notice: string
  width: number
  onWidthChange: (width: number) => void
  onSubmit: (prompt: string) => void
  onNewChat: () => void
  onSelectChat: (chatId: string) => void
  onRenameChat: (chatId: string) => void
  onArchiveChat: (chatId: string) => void
  onSelectMission: (missionId: string) => void
  onCancel: () => void
  onApprove: (operationId: string) => void
  onReject: (operationId: string) => void
  onKeepAll: () => void
  onUndoAll: () => void
  onReviewChange: (changeId: string) => Promise<ReviewItem | null>
  onProviderChange: (provider: ProviderId) => void
  publishSuggestion?: { message: string; onOpen: () => void; onDismiss: () => void }
  onClose: () => void
}

const EXAMPLES = [
  'Scaffold a new React Native Expo app in this folder',
  'Find and fix TypeScript errors in the project',
  'Explain how authentication works in this codebase'
]

export function AgentPanel({
  changes,
  providerReady,
  providerDetail,
  providerId,
  workspaceOpen,
  chat,
  chats,
  mission,
  missions,
  running,
  messages,
  tools,
  operations,
  notice,
  width,
  onWidthChange,
  onSubmit,
  onNewChat,
  onSelectChat,
  onRenameChat,
  onArchiveChat,
  onSelectMission,
  onCancel,
  onApprove,
  onReject,
  onKeepAll,
  onUndoAll,
  onReviewChange,
  onProviderChange,
  publishSuggestion,
  onClose
}: AgentPanelProps) {
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'chat' | 'trace'>('chat')
  const [changesOpen, setChangesOpen] = useState(false)
  const [review, setReview] = useState<ReviewItem | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [jumpVisible, setJumpVisible] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const startedAtRef = useRef(Date.now())
  const phaseKeyRef = useRef('idle')

  const startedTool = [...tools]
    .reverse()
    .find((tool) => tool.state === 'started' || tool.state === 'awaiting_approval')
  const pendingDeletes = operations.filter((item) => item.status === 'pending' && item.kind === 'delete')
  const pendingDeletionCount = pendingDeletes.reduce((sum, item) => sum + countDeleteTargets(item.unifiedDiff), 0)
  const uiStatus = deriveAgentUiStatus({
    running,
    missionStatus: mission?.status ?? null,
    toolName: startedTool?.name ?? null,
    toolState: startedTool?.state ?? null,
    toolArgumentsText: startedTool?.argumentsText ?? null,
    pendingDeletionCount,
    startedAt: startedAtRef.current,
    now
  })
  // Finished missions show the FinalResult card; status bar returns to Ready.
  const statusBarState = uiStatus.kind === 'finished' ? ({ kind: 'idle', label: 'Ready' } as const) : uiStatus

  const livePhaseKey = statusPhaseKey(uiStatus)
  useEffect(() => {
    if (livePhaseKey !== phaseKeyRef.current) {
      phaseKeyRef.current = livePhaseKey
      startedAtRef.current = Date.now()
      setNow(Date.now())
    }
  }, [livePhaseKey])

  const timelineItems = useMemo(
    () =>
      buildTimeline({
        messages,
        tools,
        operations,
        mission,
        notice
      }),
    [messages, tools, operations, mission, notice]
  )

  const contextPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const tool of tools) {
      if (tool.name !== 'read_file' || (tool.state !== 'success' && tool.state !== 'finished')) continue
      try {
        const parsed = JSON.parse(tool.argumentsText) as { path?: unknown }
        if (typeof parsed.path === 'string' && parsed.path.trim()) paths.add(parsed.path)
      } catch {
        // ignore
      }
    }
    return [...paths]
  }, [tools])

  const missionBadge = mission ? mission.status.replaceAll('_', ' ') : null

  useEffect(() => {
    follow.current = true
    setJumpVisible(false)
  }, [mission?.id])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  useEffect(() => {
    const node = scroller.current
    if (!node || !follow.current) {
      setJumpVisible(Boolean(node && !follow.current))
      return
    }
    node.scrollTop = node.scrollHeight
    setJumpVisible(false)
  }, [timelineItems, running, operations, mission?.id])

  function submitDraft(): void {
    const prompt = draft.trim()
    if (!prompt || running || !workspaceOpen) return
    setDraft('')
    onSubmit(prompt)
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const originWidth = width
    handle.setPointerCapture(event.pointerId)
    const onMove = (moveEvent: PointerEvent): void => {
      onWidthChange(Math.min(720, Math.max(300, Math.round(originWidth + (originX - moveEvent.clientX)))))
    }
    const onUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-resizing-agent')
    }
    document.body.classList.add('is-resizing-agent')
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  async function openReview(changeId: string): Promise<void> {
    setReviewOpen(true)
    setReview(await onReviewChange(changeId))
  }

  return (
    <aside className="agent" style={{ width }} data-agent-panel>
      <div className="agent-resize" role="separator" aria-orientation="vertical" aria-label="Resize agent sidebar" onPointerDown={beginResize} />

      <div className="agent-head agent-head-compact">
        <div className="agent-title-line">
          <button
            type="button"
            className="agent-chat-title"
            title="Rename chat"
            disabled={!chat || running}
            onClick={() => {
              if (chat) onRenameChat(chat.id)
            }}
          >
            {chat?.title ?? 'Conversation'}
          </button>
          {missionBadge ? (
            <span className="mission-status-pill" data-mission-status={mission?.status}>
              {missionBadge}
            </span>
          ) : null}
        </div>
        <div className="agent-head-actions">
          <div className="agent-view" role="tablist" aria-label="Agent view">
            <button type="button" role="tab" aria-pressed={view === 'chat'} onClick={() => setView('chat')}>
              Chat
            </button>
            <button type="button" role="tab" aria-pressed={view === 'trace'} onClick={() => setView('trace')}>
              Trace
            </button>
          </div>
          <button
            type="button"
            className="icon-hit"
            data-action="chat-new"
            disabled={!workspaceOpen || running}
            title="New chat"
            onClick={onNewChat}
          >
            +
          </button>
          <HistoryMenu
            chats={chats}
            activeChatId={chat?.id ?? null}
            workspaceOpen={workspaceOpen}
            running={running}
            onSelectChat={onSelectChat}
            onRenameChat={onRenameChat}
            onArchiveChat={onArchiveChat}
          />
          {missions.length > 1 ? (
            <label className="mission-history-inline">
              <span className="sr-only">Missions in this chat</span>
              <select
                data-mission-history
                value={mission?.id ?? ''}
                disabled={running}
                onChange={(event) => {
                  if (event.target.value) onSelectMission(event.target.value)
                }}
              >
                {missions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.status} · {item.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="button" className="icon-hit" title="Hide agent" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>

      <StatusBar
        status={statusBarState}
        now={now}
        cancellable={canCancel(running, mission?.status ?? null)}
        onCancel={onCancel}
        onApprove={pendingDeletes[0] ? () => onApprove(pendingDeletes[0]!.id) : undefined}
        onDeny={pendingDeletes[0] ? () => onReject(pendingDeletes[0]!.id) : undefined}
      />

      <div
        className="agent-scroll"
        ref={scroller}
        onScroll={() => {
          const node = scroller.current
          if (!node) return
          follow.current = shouldFollowTranscript(node.scrollTop, node.scrollHeight, node.clientHeight)
          setJumpVisible(!follow.current)
        }}
      >
        {view === 'chat' ? (
          <Timeline
            items={timelineItems}
            empty={messages.length === 0}
            workspaceOpen={workspaceOpen}
            examples={EXAMPLES}
            onExample={(prompt) => setDraft(prompt)}
            onCancel={onCancel}
            onApprove={onApprove}
            onReject={onReject}
            onNextStep={(prompt) => setDraft(prompt)}
            onReviewPath={(path) => {
              const match = changes.find((change) => change.relativePath === path)
              if (match) void openReview(match.id)
            }}
          />
        ) : (
          <section className="trace-panel" data-agent-trace>
            <div className="trace-head">
              <h2>Execution Trace</h2>
              <span className="muted">{tools.length === 0 ? 'No steps' : `${tools.length} recorded`}</span>
            </div>
            {tools.length === 0 ? <p className="muted">No steps recorded.</p> : null}
            {tools.map((tool, index) => (
              <div
                key={tool.callId}
                className={
                  tool.state === 'awaiting_approval' || tool.state === 'started' ? 'trace-card is-started' : 'trace-card'
                }
              >
                <div className="trace-card-main">
                  <TraceState state={tool.state} />
                  <div>
                    <p className="trace-title">{tool.name}</p>
                    <p className="muted">{tool.state}</p>
                    {tool.argumentsText ? <pre className="trace-args">{tool.argumentsText.slice(0, 2000)}</pre> : null}
                    {tool.output ? <pre className="trace-output">{tool.output.slice(0, 4000)}</pre> : null}
                  </div>
                </div>
                <span className="trace-index">Step {index + 1}</span>
              </div>
            ))}
          </section>
        )}
      </div>

      {jumpVisible ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            follow.current = true
            const node = scroller.current
            if (node) node.scrollTop = node.scrollHeight
            setJumpVisible(false)
          }}
        >
          Jump to latest
        </button>
      ) : null}

      <ChangesBar
        changes={changes}
        expanded={changesOpen}
        onToggle={() => setChangesOpen((value) => !value)}
        onKeepAll={onKeepAll}
        onUndoAll={onUndoAll}
        onReview={() => {
          setChangesOpen(true)
          const first = changes[0]
          if (first) void openReview(first.id)
        }}
        onReviewOne={(changeId) => void openReview(changeId)}
      />

      {reviewOpen && review ? (
        <section className="change-review" data-change-review>
          <header>
            <div>
              <strong>{review.relativePath}</strong>
              <span className="muted">
                {review.changeType}
                {review.hasReverse ? ' · reverse available' : ''}
              </span>
            </div>
            <button type="button" className="text-button" onClick={() => setReviewOpen(false)}>
              Close
            </button>
          </header>
          {review.error ? <p className="hint">{review.error}</p> : null}
          <pre className="proposal-diff">
            {review.unifiedDiff.split('\n').map((line, index) => (
              <span
                key={`${review.id}-${index}`}
                className={
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'diff-add'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'diff-del'
                      : line.startsWith('@@')
                        ? 'diff-hunk'
                        : undefined
                }
              >
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </section>
      ) : null}

      {publishSuggestion ? (
        <div className="agent-suggestion-card">
          <p>{publishSuggestion.message}</p>
          <div className="settings-actions">
            <button type="button" className="text-button" onClick={publishSuggestion.onOpen}>
              Publish…
            </button>
            <button type="button" className="text-button" onClick={publishSuggestion.onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <Composer
        draft={draft}
        onDraftChange={setDraft}
        running={running}
        workspaceOpen={workspaceOpen}
        providerReady={providerReady}
        providerDetail={providerDetail}
        providerId={providerId}
        missionStatus={mission?.status ?? null}
        contextPaths={contextPaths}
        onSubmit={submitDraft}
        onCancel={onCancel}
        onProviderChange={onProviderChange}
      />
    </aside>
  )
}

function countDeleteTargets(diff: string): number {
  const files = /Files:\s*(\d+)/i.exec(diff)
  if (files) return Number(files[1])
  return 1
}

function TraceState({ state }: { state: AgentToolRecord['state'] }) {
  if (state === 'awaiting_approval' || state === 'started') {
    return <span className="agent-spin trace-mark" />
  }
  if (state === 'success' || state === 'finished') {
    return <Icon name="check" className="trace-mark is-done" />
  }
  return <span className="trace-mark is-rejected" aria-hidden="true" />
}
