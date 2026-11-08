import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './AuthGate'
import { installMonaco } from './monaco'
import './styles.css'

installMonaco()

const root = document.getElementById('root')
if (!root) {
  throw new Error('KERN root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>
)
