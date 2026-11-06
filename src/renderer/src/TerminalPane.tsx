import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'

type TerminalPaneProps = {
  workspacePath: string | null
  clearRequest: number
  onRunningChange: (running: boolean) => void
}

export function TerminalPane({ workspacePath, clearRequest, onRunningChange }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const runningRef = useRef(onRunningChange)
  runningRef.current = onRunningChange

  useEffect(() => {
    const element = host.current
    if (!element || !workspacePath) {
      runningRef.current(false)
      return
    }
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: {
        background: '#0A0B0E',
        foreground: '#C9D1D9',
        cursor: '#8B7CFF',
        selectionBackground: '#3A347888'
      },
      convertEol: true
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    fit.fit()
    const dataId = window.kern.terminal.onData((data) => {
      term.write(data)
    })
    let acceptingExit = false
    const exitId = window.kern.terminal.onExit((exitCode) => {
      if (!acceptingExit) {
        return
      }
      acceptingExit = false
      runningRef.current(false)
      term.write(`\r\n[process exited ${exitCode}]\r\n`)
    })
    let stopped = false
    void window.kern.terminal.start().then((result) => {
      if (!result.ok || stopped) {
        if (!result.ok) {
          term.writeln(result.error)
        }
        runningRef.current(false)
        return
      }
      acceptingExit = true
      runningRef.current(true)
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
      runningRef.current(false)
      observer.disconnect()
      input.dispose()
      window.kern.terminal.offData(dataId)
      window.kern.terminal.offExit(exitId)
      term.dispose()
      termRef.current = null
      void window.kern.terminal.cancel()
    }
  }, [workspacePath])

  useEffect(() => {
    if (clearRequest === 0) {
      return
    }
    termRef.current?.clear()
  }, [clearRequest])

  return <div className="terminal-host" ref={host} />
}
