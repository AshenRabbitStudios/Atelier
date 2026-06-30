import { createRoot } from 'react-dom/client'
import 'dockview/dist/styles/dockview.css'
import './styles.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

const root = document.getElementById('root')
if (!root) throw new Error('Atelier: #root element not found')
createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
