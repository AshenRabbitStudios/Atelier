// Pure helpers for the ambient Bash tap (P4 S2). Kept SDK/electron-free so they're unit-testable
// in isolation; AgentManager wires these into Pre/PostToolUse hooks. See docs/SDK_NOTES.md.

/** Publishes an ambient event onto a DataBus channel (the Bash tap → bash-stream pane). */
export type BashPublish = (conversationId: string, channel: string, data: unknown) => void

/** Best-effort faithful text of a Bash tool_response (ANSI preserved), across the shapes it takes. */
export function bashResponseText(resp: unknown): string {
  if (typeof resp === 'string') return resp
  if (resp && typeof resp === 'object') {
    const o = resp as Record<string, unknown>
    const parts: string[] = []
    if (typeof o.stdout === 'string') parts.push(o.stdout)
    if (typeof o.stderr === 'string' && o.stderr) parts.push(o.stderr)
    if (parts.length) return parts.join('')
    // content-block array (e.g. [{ type:'text', text }]) — concatenate the text blocks.
    if (Array.isArray(o.content)) {
      const text = o.content
        .map((b) => (b && typeof b === 'object' ? (b as { text?: unknown }).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('')
      if (text) return text
    }
  }
  return typeof resp === 'undefined' ? '' : JSON.stringify(resp)
}
