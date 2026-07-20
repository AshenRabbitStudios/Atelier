// A3 — a tiny renderer-local registry mapping a conversationId to its mounted ChatPanel composer's
// "insert text at cursor" handler. `atelier.agent.compose(text)` (permission `agent:compose`) stages
// text into THIS conversation's composer WITHOUT sending; the PluginPane relay resolves the pane's
// conversationId and calls compose() here. If no composer is mounted for that conversation the call
// returns false so the relay can answer { error: 'composer not open' } — a plugin annotates the miss
// instead of silently dropping the text. Module-level (one renderer, one map) so the plugin pane and
// the chat panel don't need a shared React context threaded between two independent Dockview panes.

type ComposeHandler = (text: string) => void

const handlers = new Map<string, ComposeHandler>()

/** A mounted composer registers its inserter; returns an unregister for unmount. */
export function registerComposer(conversationId: string, handler: ComposeHandler): () => void {
  handlers.set(conversationId, handler)
  return () => {
    if (handlers.get(conversationId) === handler) handlers.delete(conversationId)
  }
}

/** Stage text into a conversation's composer. Returns false if none is mounted. */
export function composeInto(conversationId: string, text: string): boolean {
  const handler = handlers.get(conversationId)
  if (!handler) return false
  handler(text)
  return true
}
