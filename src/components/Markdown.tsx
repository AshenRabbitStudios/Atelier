import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ComponentPropsWithoutRef } from 'react'
import { CodeBlock } from './CodeBlock'

/**
 * Safe markdown renderer for assistant text blocks. Fenced code is routed to
 * Shiki (CodeBlock); inline code stays a styled <code>. No raw HTML is rendered.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) {
          const raw = String(children ?? '')
          const match = /language-(\w+)/.exec(className ?? '')
          const isBlock = Boolean(match) || raw.includes('\n')
          if (isBlock) {
            return <CodeBlock code={raw.replace(/\n$/, '')} lang={match?.[1] ?? 'text'} />
          }
          return (
            <code className="inline-code" {...props}>
              {children}
            </code>
          )
        }
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
