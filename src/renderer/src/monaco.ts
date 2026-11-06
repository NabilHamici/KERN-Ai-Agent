import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

export function installMonaco(): void {
  window.MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case 'json':
          return new jsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker()
        case 'typescript':
        case 'javascript':
          return new tsWorker()
        default:
          return new editorWorker()
      }
    }
  }

  const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false }
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics)
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics)
  const compilerOptions = {
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    strict: true
  }
  monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
  monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)

  monaco.editor.defineTheme('kern-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6E7681' },
      { token: 'string', foreground: '9DB8D4' },
      { token: 'keyword', foreground: 'A99BFF' }
    ],
    colors: {
      'editor.background': '#0D0E11',
      'editor.foreground': '#C9D1D9',
      'editorLineNumber.foreground': '#5C6570',
      'editorLineNumber.activeForeground': '#A99BFF',
      'editorCursor.foreground': '#8B7CFF',
      'editor.selectionBackground': '#3A347866',
      'editor.lineHighlightBackground': '#161922'
    }
  })

  if (new URLSearchParams(window.location.search).get('acceptance') === '1') {
    window.__kernEditors = () => monaco.editor.getEditors()
  }
}

export function languageForPath(filePath: string | null): string {
  const extension = filePath?.split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    case 'py':
      return 'python'
    case 'sh':
    case 'zsh':
      return 'shell'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

export { monaco }
