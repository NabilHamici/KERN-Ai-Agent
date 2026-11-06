import { useEffect, useRef } from 'react'
import { languageForPath, monaco } from './monaco'

export type EditorDiagnostic = {
  path: string
  message: string
  severity: string
  startLine: number
  startColumn: number
}

type EditorPaneProps = {
  path: string
  initialValue: string
  onReady: (getValue: () => string) => void
  onChange: (path: string, value: string) => void
  onCursor: (position: { line: number; column: number }) => void
  onDiagnostics: (items: EditorDiagnostic[]) => void
}

function severityLabel(severity: number): string {
  if (severity === monaco.MarkerSeverity.Error) {
    return 'error'
  }
  if (severity === monaco.MarkerSeverity.Warning) {
    return 'warning'
  }
  if (severity === monaco.MarkerSeverity.Info) {
    return 'info'
  }
  return 'hint'
}

export function EditorPane({ path, initialValue, onReady, onChange, onCursor, onDiagnostics }: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const readyRef = useRef(onReady)
  const changeRef = useRef(onChange)
  const cursorRef = useRef(onCursor)
  const diagnosticsRef = useRef(onDiagnostics)
  readyRef.current = onReady
  changeRef.current = onChange
  cursorRef.current = onCursor
  diagnosticsRef.current = onDiagnostics

  useEffect(() => {
    const element = host.current
    if (!element) {
      return
    }
    const uri = monaco.Uri.parse(`file:///workspace/${path}`)
    const existing = monaco.editor.getModel(uri)
    const model = existing ?? monaco.editor.createModel(initialValue, languageForPath(path), uri)
    if (existing && existing.getValue() !== initialValue) {
      existing.setValue(initialValue)
    }
    const instance = monaco.editor.create(element, {
      model,
      theme: 'kern-dark',
      automaticLayout: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      lineNumbers: 'on',
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 8 }
    })
    const publishDiagnostics = (): void => {
      const model = instance.getModel()
      if (!model) {
        diagnosticsRef.current([])
        return
      }
      const markers = monaco.editor.getModelMarkers({ resource: model.uri })
      diagnosticsRef.current(
        markers
          .map((marker) => ({
            path,
            message: marker.message,
            severity: severityLabel(marker.severity),
            startLine: marker.startLineNumber,
            startColumn: marker.startColumn
          }))
          .filter((item) => item.severity === 'error' || item.severity === 'warning')
      )
    }
    readyRef.current(() => instance.getValue())
    const position = instance.getPosition()
    cursorRef.current({ line: position?.lineNumber ?? 1, column: position?.column ?? 1 })
    publishDiagnostics()
    const content = instance.onDidChangeModelContent(() => {
      changeRef.current(path, instance.getValue())
    })
    const cursor = instance.onDidChangeCursorPosition((event) => {
      cursorRef.current({ line: event.position.lineNumber, column: event.position.column })
    })
    const markers = monaco.editor.onDidChangeMarkers((uris) => {
      const model = instance.getModel()
      if (!model || !uris.some((uri) => uri.toString() === model.uri.toString())) {
        return
      }
      publishDiagnostics()
    })
    return () => {
      content.dispose()
      cursor.dispose()
      markers.dispose()
      instance.dispose()
      model.dispose()
    }
  }, [path, initialValue])

  return <div className="monaco-host" ref={host} />
}
