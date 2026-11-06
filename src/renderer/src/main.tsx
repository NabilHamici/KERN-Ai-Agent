import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installMonaco } from './monaco'
import './styles.css'

installMonaco()

const root = document.getElementById('root')
if (!root) {
  throw new Error('KERN root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
