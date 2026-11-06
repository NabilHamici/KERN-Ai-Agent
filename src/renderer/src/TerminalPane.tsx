import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'

type TerminalPaneProps = {
  workspacePath: string | null
  onCancel: () => void
}

export function TerminalPane({ workspacePath, onCancel }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element || !workspacePath) {
      return
    }
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0e1116', foreground: '#e7e4dc', cursor: '#e0a45c' },
      convertEol: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    fit.fit()
    const dataId = window.kern.terminal.onData((data) => {
      term.write(data)
    })
    const exitId = window.kern.terminal.onExit((exitCode) => {
      term.write(`\r\n[process exited ${exitCode}]\r\n`)
    })
    let stopped = false
    void window.kern.terminal.start().then((result) => {
      if (!result.ok || stopped) {
        return
      }
      term.writeln(`KERN terminal — ${result.data.shell}`)
      void window.kern.terminal.resize({ cols: term.cols, rows: term.rows })
    })
    const input = term.onData((data) => {
      void window.kern.terminal.write({ data })
    })
    const observer = new ResizeObserver(() => {
      fit.fit()
      void window.kern.terminal.resize({ cols: term.cols, rows: term.rows })
    })
    observer.observe(element)
    return () => {
      stopped = true
      observer.disconnect()
      input.dispose()
      window.kern.terminal.offData(dataId)
      window.kern.terminal.offExit(exitId)
      term.dispose()
      void window.kern.terminal.cancel()
    }
  }, [workspacePath])

  return (
    <section className="terminal-wrap">
      <div className="terminal-bar">
        <strong>Terminal</strong>
        <span className="spacer" />
        <button type="button" data-action="terminal-cancel" onClick={onCancel} disabled={!workspacePath}>
          Cancel process
        </button>
      </div>
      <div className="terminal-host" ref={host} />
    </section>
  )
}
