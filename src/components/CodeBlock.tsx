import { useEffect, useState } from 'react'
import { codeToHtml } from 'shiki'

/**
 * Highlights a fenced code block with Shiki. Code is rendered through Shiki's
 * tokenizer (which escapes text), never through the markdown HTML path — so it is
 * never garbled and original whitespace is preserved. On any failure it falls back
 * to a plain <pre> that still shows the exact source.
 */
// Shiki tokenizes the whole string synchronously-ish; on a huge block (e.g. an
// agent dumping an entire manual) that can lock the UI for seconds. Above this size
// we skip highlighting and render plain text instead.
const MAX_HIGHLIGHT_CHARS = 20000

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (code.length > MAX_HIGHLIGHT_CHARS) {
      setHtml(null)
      return
    }
    let alive = true
    codeToHtml(code, { lang, theme: 'github-dark' })
      .then((h) => alive && setHtml(h))
      .catch(() =>
        // Unknown language (or other): retry as plain text so we still highlight box.
        codeToHtml(code, { lang: 'text', theme: 'github-dark' })
          .then((h) => alive && setHtml(h))
          .catch(() => alive && setHtml(null))
      )
    return () => {
      alive = false
    }
  }, [code, lang])

  if (html === null) {
    return (
      <pre className="code-fallback">
        <code>{code}</code>
      </pre>
    )
  }
  // eslint-disable-next-line react/no-danger
  return <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />
}
