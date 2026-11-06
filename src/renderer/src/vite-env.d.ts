/// <reference types="vite/client" />

declare module '*.css'

declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/editor/editor.worker.js?worker'
declare module 'monaco-editor/language/css/css.worker.js?worker'
declare module 'monaco-editor/language/html/html.worker.js?worker'
declare module 'monaco-editor/language/json/json.worker.js?worker'
declare module 'monaco-editor/language/typescript/ts.worker.js?worker'
