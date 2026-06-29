import { createRoot } from 'react-dom/client'
import 'dockview/dist/styles/dockview.css'
import './styles.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Atelier: #root element not found')
createRoot(root).render(<App />)
