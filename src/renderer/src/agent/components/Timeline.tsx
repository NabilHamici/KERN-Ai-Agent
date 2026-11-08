import { useState } from 'react'
import { inlineParts, messageBlocks, splitAssistantReport } from '../../conversation.ts'
import type { TimelineItem } from '../timeline.ts'
import { FinalResultCard } from './FinalResultCard.tsx'
import { ApprovalCard, CommandCard, EditCard, StepGroupCard } from './stepCards.tsx'

type TimelineProps = {
  items: TimelineItem[]
  empty: boolean
  workspaceOpen: boolean
  examples: string[]
  onExample: (prompt: string) => void
  onCancel: () => void
  onApprove: (operationId: string) => void
  onReject: (operationId: string) => void
  onNextStep: (prompt: string) => void
  onReviewPath?: (path: string) => void
}

export function Timeline({
  items,
  empty,
  workspaceOpen,
  examples,
  onExample,
  onCancel,
  onApprove,
  onReject,
  onNextStep,
  onReviewPath
}: TimelineProps) {
  return (
    <div className="conversation timeline" data-conversation data-timeline>
      {empty ? (
        <div className="timeline-empty" data-empty-chat>
          <p className="muted">
            {workspaceOpen ? 'New chat — send a message to begin.' : 'Open a folder to start a conversation.'}
          </p>
          {workspaceOpen ? (
            <ul className="timeline-examples">
              {examples.map((prompt) => (
                <li key={prompt}>
                  <button type="button" className="text-button" onClick={() => onExample(prompt)}>
                    {prompt}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <article key={item.id} className="chat-row" data-message-role="user">
                <div className="chat-bubble is-user">
                  <MessageBody text={item.text} />
                </div>
              </article>
            )
          case 'assistant_text':
            return <ClampedAssistant key={item.id} id={item.id} text={item.text} muted={item.muted} />
          case 'step_group':
            return <StepGroupCard key={item.id} label={item.label} count={item.count} steps={item.steps} />
          case 'command':
            return <CommandCard key={item.id} step={item.step} onCancel={onCancel} />
          case 'verification':
            return <CommandCard key={item.id} step={item.step} verification onCancel={onCancel} />
          case 'edit':
            return <EditCard key={item.id} step={item.step} onReview={onReviewPath} />
          case 'approval':
            return (
              <ApprovalCard key={item.id} operation={item.operation} onApprove={onApprove} onReject={onReject} />
            )
          case 'error':
            return (
              <p key={item.id} className="hint" data-step-card="error">
                {item.message}
              </p>
            )
          case 'final_result':
            return (
              <FinalResultCard
                key={item.id}
                result={item.result}
                onNextStep={onNextStep}
                reportLedger={item.result.reportLedger}
              />
            )
          default:
            return null
        }
      })}
    </div>
  )
}

function ClampedAssistant({ id, text, muted }: { id: string; text: string; muted?: boolean }) {
  const [open, setOpen] = useState(false)
  const split = splitAssistantReport(text)
  const lines = split.prose.split(/\n/).filter(Boolean)
  const clamped = !open && lines.length > 6
  const visible = clamped ? lines.slice(0, 6).join('\n') : split.prose
  return (
    <article
      key={id}
      className={muted ? 'chat-row is-muted' : 'chat-row'}
      data-message-role="assistant"
      data-assistant-response
    >
      <div className="chat-assistant">
        <MessageBody text={visible} />
        {clamped ? (
          <button type="button" className="text-button" onClick={() => setOpen(true)}>
            Show more
          </button>
        ) : null}
        {split.ledger ? (
          <details className="report-details" data-report-details>
            <summary>Report details</summary>
            <pre>{split.ledger}</pre>
          </details>
        ) : null}
      </div>
    </article>
  )
}

function MessageBody({ text }: { text: string }) {
  return (
    <div className="thread-body">
      {messageBlocks(text).map((block, index) =>
        block.kind === 'code' ? (
          <pre key={index} className="thread-code">
            {block.text}
          </pre>
        ) : (
          <p key={index} className="thread-copy">
            {inlineParts(block.text).map((part, partIndex) =>
              part.code ? <code key={partIndex}>{part.text}</code> : <span key={partIndex}>{part.text}</span>
            )}
          </p>
        )
      )}
    </div>
  )
}
