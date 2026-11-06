import { useEffect, useRef } from 'react'
import { languageForPath, monaco } from './monaco'

type EditorPaneProps = {
  path: string
  initialValue: string
  onReady: (getValue: () => string) => void
}

export function EditorPane({ path, initialValue, onReady }: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const element = host.current
    if (!element) {
      return
    }
    const instance = monaco.editor.create(element, {
      value: initialValue,
      language: languageForPath(path),
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    readyRef.current(() => instance.getValue())
    return () => {
      instance.dispose()
    }
  }, [path, initialValue])

  return <div className="monaco-host" ref={host} />
}
