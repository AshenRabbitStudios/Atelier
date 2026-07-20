// A2 — open a cwd-scoped file in the OS default handler for a plugin pane (permission `shell:open`).
// A re-gated sibling of the renderer's unscoped `app.openPath`: the host bounds `path` to the
// conversation cwd via the same resolver the read/write paths use (null → refused), so a sandboxed
// plugin can never hand an arbitrary path to the OS shell. Every failure is `{ error }` (never a
// throw across the relay). The actual `shell.openPath` is injected so this stays Electron-free and
// unit-testable (path-scoping is the interesting part; main.ts supplies the real opener).

export type OpenResult = { ok: true } | { error: string }

export function createPathOpener(
  resolvePath: (conversationId: string, rel: string) => string | null,
  openPath: (abs: string) => Promise<string>
): (conversationId: string, rel: string) => Promise<OpenResult> {
  return async (conversationId, rel) => {
    const abs = resolvePath(conversationId, rel)
    if (!abs) return { error: `path "${rel}" is outside the conversation folder` }
    try {
      // shell.openPath resolves to a non-empty string on FAILURE (its error message), '' on success.
      const err = await openPath(abs)
      return err ? { error: err } : { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}
