import { useState } from 'react'
import type { FinalResult } from '../timeline.ts'

type FinalResultCardProps = {
  result: FinalResult
  onNextStep?: (prompt: string) => void
  reportLedger?: string | null
}

const SECTION_CAP = 5

export function FinalResultCard({ result, onNextStep, reportLedger }: FinalResultCardProps) {
  return (
    <article className={`final-result is-${result.status}`} data-final-result={result.status}>
      <header>
        <span className="final-result-icon" aria-hidden="true">
          {result.status === 'completed_verified' || result.status === 'completed_unverified'
            ? '✓'
            : result.status === 'partially_completed'
              ? '◐'
              : result.status === 'cancelled' || result.status === 'stopped_limit'
                ? '■'
                : '✗'}
        </span>
        <strong>{result.title}</strong>
      </header>
      {result.outcome ? <p className="final-result-outcome">{result.outcome}</p> : null}
      {result.statusReason ? <p className="final-result-reason muted">{result.statusReason}</p> : null}
      <CappedSection title="What was done" items={result.done} />
      {result.notDone.length > 0 ? <CappedSection title="What was not done" items={result.notDone} /> : null}
      <section className={result.verified ? 'final-verify is-ok' : 'final-verify is-warn'}>
        <h3>Verification</h3>
        <CappedList items={result.verificationLines.length > 0 ? result.verificationLines : [result.verification]} />
      </section>
      {result.nextStep && onNextStep ? (
        <div className="final-result-next">
          <span>Next</span>
          <button type="button" className="text-button" onClick={() => onNextStep(result.nextStep!)}>
            {result.nextStep}
          </button>
        </div>
      ) : null}
      {result.invalidCallNote ? <p className="muted final-result-footer">{result.invalidCallNote}</p> : null}
      {reportLedger ? (
        <details className="report-details" data-report-details>
          <summary>Report details</summary>
          <pre>{reportLedger}</pre>
          <button
            type="button"
            className="text-button"
            onClick={() => void navigator.clipboard.writeText(reportLedger)}
          >
            Copy report
          </button>
        </details>
      ) : null}
    </article>
  )
}

function CappedSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <h3>{title}</h3>
      <CappedList items={items} />
    </section>
  )
}

function CappedList({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false)
  const visible = open ? items : items.slice(0, SECTION_CAP)
  const hidden = items.length - SECTION_CAP
  return (
    <>
      <ul>
        {visible.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {!open && hidden > 0 ? (
        <button type="button" className="text-button" onClick={() => setOpen(true)}>
          Show {hidden} more
        </button>
      ) : null}
    </>
  )
}
