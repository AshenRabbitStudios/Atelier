import { Component, type ErrorInfo, type ReactNode, type CSSProperties } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  stack: string
}

// Catches render/lifecycle exceptions anywhere in the React tree and shows a recoverable panel
// instead of letting a single thrown component unmount everything to a blank window. Process-level
// crashes (the renderer dying outright) are handled separately in main via 'render-process-gone';
// module-eval errors that throw before React mounts are not caught here (nothing has mounted yet).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? error.stack ?? '' })
  }

  // Re-mount the tree in place — recovers without a full reload if the fault was transient.
  private retry = (): void => this.setState({ error: null, stack: '' })
  private reload = (): void => window.location.reload()

  render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div style={overlay}>
        <div style={card}>
          <div style={title}>Atelier hit a rendering error</div>
          <div style={message}>{error.message || String(error)}</div>
          {stack ? <pre style={stackBox}>{stack.trim()}</pre> : null}
          <div style={row}>
            <button style={primaryBtn} onClick={this.retry}>
              Try again
            </button>
            <button style={btn} onClick={this.reload}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    )
  }
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'var(--bg, #0e1014)',
  color: 'var(--text, #e7eaf0)',
  fontFamily: 'var(--font, system-ui, sans-serif)',
  zIndex: 99999
}
const card: CSSProperties = {
  maxWidth: 640,
  width: '100%',
  maxHeight: '100%',
  overflow: 'auto',
  padding: 20,
  border: '1px solid var(--border, #252b37)',
  borderRadius: 8,
  background: 'var(--surface, #14171e)'
}
const title: CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 8 }
const message: CSSProperties = {
  fontFamily: 'var(--mono, monospace)',
  fontSize: 13,
  color: 'var(--err, #e06c75)',
  marginBottom: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}
const stackBox: CSSProperties = {
  margin: '0 0 14px',
  padding: 10,
  maxHeight: 240,
  overflow: 'auto',
  background: 'var(--bg-2, #0f1117)',
  border: '1px solid var(--border, #252b37)',
  borderRadius: 4,
  fontFamily: 'var(--mono, monospace)',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--dim, #8b97ae)',
  whiteSpace: 'pre-wrap'
}
const row: CSSProperties = { display: 'flex', gap: 8 }
const btn: CSSProperties = {
  padding: '6px 14px',
  border: '1px solid var(--border, #252b37)',
  borderRadius: 4,
  background: 'var(--surface-2, #1a1e27)',
  color: 'var(--text, #e7eaf0)',
  fontSize: 13,
  cursor: 'pointer'
}
const primaryBtn: CSSProperties = {
  ...btn,
  border: 'none',
  background: 'var(--accent, #5b9cff)',
  color: 'var(--on-accent, #fff)'
}
