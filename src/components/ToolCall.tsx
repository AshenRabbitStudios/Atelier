import { memo } from 'react'
import type { Block } from '../transcriptModel'
import { CodeBlock } from './CodeBlock'
import { Markdown } from './Markdown'

// Renders a tool_use block the way the underlying action reads: Bash as a shell
// prompt + terminal output, Edit/Write as a diff, Read as the highlighted file,
// Grep/Glob as a query + match list, everything else as labelled JSON. Input and
// result are `unknown` off the wire, so every accessor is defensive.

type ToolUse = Extract<Block, { kind: 'tool_use' }>

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** A tool result's output may be a string, an array of content blocks, or an object. */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((p) => {
        if (typeof p === 'string') return p
        const r = asRecord(p)
        return typeof r.text === 'string' ? r.text : ''
      })
      .join('')
  }
  const r = asRecord(output)
  if (typeof r.text === 'string') return r.text
  if (typeof r.stdout === 'string') return r.stdout
  return pretty(output)
}

/** Sidebar tint shared with the rest of the chrome (DESIGN_SYSTEM §5). */
export function toolKindClass(name: string): string {
  if (/^(read|glob|grep|ls|webfetch|websearch|toolsearch|agent|task|skill)$/i.test(name))
    return 'tool-kind-read'
  if (/^(edit|write|notebookedit|multiedit)$/i.test(name)) return 'tool-kind-edit'
  if (/^(bash|powershell|pwsh|sh|zsh|cmd|shell)$/i.test(name)) return 'tool-kind-bash'
  return ''
}

// Shell-command tools share Bash's { command, description } shape (Bash, PowerShell, …).
const SHELL_RE = /^(bash|powershell|pwsh|sh|zsh|cmd|shell)$/
function shellLabel(n: string): string {
  return /^(powershell|pwsh)$/.test(n) ? 'PowerShell' : 'Terminal'
}
function shellPrompt(n: string): string {
  return /^(powershell|pwsh)$/.test(n) ? 'PS>' : '$'
}
// Pull the matched tool names from a ToolSearch result: <function>{…,"name":"X",…}</function>.
function parseToolNames(text: string): string[] {
  const names: string[] = []
  for (const chunk of text.split('<function>').slice(1)) {
    const m = /"name"\s*:\s*"([^"]+)"/.exec(chunk)
    if (m) names.push(m[1])
  }
  return names
}

// Context-document write tools auto-registered on the `atelier_context` MCP server
// (contextTools.ts): set_<plugin>__<key>, surfaced to the model as
// mcp__atelier_context__set_<plugin>__<key>, with the full new document in { content }.
function isContextWrite(name: string): boolean {
  return /atelier_context__set_/i.test(name) || /^set_[a-z0-9_]+__[a-z0-9_]+$/i.test(name)
}
function ctxKeyName(name: string): string {
  const last = name.split('__').pop() ?? name
  return last.replace(/_/g, ' ')
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
function extLang(p: string): string {
  const ext = (p.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    py: 'python',
    sh: 'bash',
    bash: 'bash',
    go: 'go',
    rs: 'rust',
    java: 'java',
    rb: 'ruby',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    sql: 'sql'
  }
  return map[ext] ?? 'text'
}

/** The one-line preview shown in the (always-visible) summary, per tool. */
function summary(name: string, input: unknown): { label: string; detail: string; mono: boolean } {
  const i = asRecord(input)
  const n = name.toLowerCase()
  if (SHELL_RE.test(n)) return { label: shellLabel(n), detail: str(i.command), mono: true }
  if (/^(edit|write|multiedit|notebookedit)$/.test(n))
    return { label: name, detail: baseName(str(i.file_path)), mono: true }
  if (/^read$/.test(n)) return { label: 'Read', detail: baseName(str(i.file_path)), mono: true }
  if (/^grep$/.test(n)) return { label: 'Grep', detail: str(i.pattern), mono: true }
  if (/^glob$/.test(n)) return { label: 'Glob', detail: str(i.pattern), mono: true }
  if (/^toolsearch$/.test(n)) return { label: 'Tool search', detail: str(i.query), mono: true }
  if (/^(agent|task)$/.test(n))
    return { label: 'Sub-agent', detail: str(i.subagent_type) || str(i.description), mono: false }
  if (/^todowrite$/.test(n)) {
    const c = Array.isArray(i.todos) ? i.todos.length : 0
    return { label: 'To-dos', detail: c ? `${c} items` : '', mono: false }
  }
  if (/^skill$/.test(n)) return { label: 'Skill', detail: str(i.skill), mono: true }
  if (/^webfetch$/.test(n)) return { label: 'Web fetch', detail: str(i.url), mono: true }
  if (/^websearch$/.test(n)) return { label: 'Web search', detail: str(i.query), mono: false }
  if (isContextWrite(name)) return { label: 'Context', detail: ctxKeyName(name), mono: false }
  return { label: name, detail: '', mono: false }
}

type DiffLine = { sign: ' ' | '+' | '-'; text: string }

/** LCS line diff. Create/delete and oversized inputs take cheap non-LCS paths. */
function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr === '' ? [] : oldStr.split('\n')
  const b = newStr === '' ? [] : newStr.split('\n')
  if (a.length === 0) return b.map((t) => ({ sign: '+', text: t }))
  if (b.length === 0) return a.map((t) => ({ sign: '-', text: t }))
  if (a.length * b.length > 400_000) {
    return [
      ...a.map((t) => ({ sign: '-' as const, text: t })),
      ...b.map((t) => ({ sign: '+' as const, text: t }))
    ]
  }
  const m = a.length
  const nn = b.length
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(nn + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = nn - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < nn) {
    if (a[i] === b[j]) {
      out.push({ sign: ' ', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: '-', text: a[i] })
      i++
    } else {
      out.push({ sign: '+', text: b[j] })
      j++
    }
  }
  while (i < m) out.push({ sign: '-', text: a[i++] })
  while (j < nn) out.push({ sign: '+', text: b[j++] })
  return out
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="diff">
      {lines.map((l, k) => (
        <div
          key={k}
          className={`diff-line ${l.sign === '+' ? 'add' : l.sign === '-' ? 'del' : 'ctx'}`}
        >
          <span className="diff-sign">{l.sign === ' ' ? ' ' : l.sign}</span>
          <span className="diff-text">{l.text || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

function ToolBody({ block }: { block: ToolUse }) {
  const n = block.name.toLowerCase()
  const i = asRecord(block.input)
  const out = block.result ? resultText(block.result.output) : ''

  if (SHELL_RE.test(n)) {
    return (
      <div className="tool-body">
        <div className="shell-cmd">
          <span className="shell-prompt">{shellPrompt(n)}</span>{' '}
          <span className="shell-text">{str(i.command)}</span>
        </div>
        {str(i.description) && <div className="shell-desc">{str(i.description)}</div>}
        {block.result && (
          <pre className={`shell-output ${block.result.ok ? '' : 'err'}`}>
            {out || '(no output)'}
          </pre>
        )}
      </div>
    )
  }

  if (/^edit$/.test(n)) {
    return (
      <div className="tool-body">
        <DiffView lines={diffLines(str(i.old_string), str(i.new_string))} />
      </div>
    )
  }
  if (/^write$/.test(n)) {
    return (
      <div className="tool-body">
        <DiffView lines={diffLines('', str(i.content))} />
      </div>
    )
  }
  if (/^multiedit$/.test(n)) {
    const edits = Array.isArray(i.edits) ? i.edits : []
    return (
      <div className="tool-body">
        {edits.map((e, k) => {
          const er = asRecord(e)
          return <DiffView key={k} lines={diffLines(str(er.old_string), str(er.new_string))} />
        })}
      </div>
    )
  }

  if (/^read$/.test(n)) {
    return (
      <div className="tool-body">
        {block.result ? (
          <CodeBlock code={out} lang={extLang(str(i.file_path))} />
        ) : (
          <div className="tool-pending">Reading…</div>
        )}
      </div>
    )
  }

  if (/^(grep|glob)$/.test(n)) {
    return (
      <div className="tool-body">
        <div className="tool-query">
          <span className="q-label">{/grep/.test(n) ? 'pattern' : 'glob'}</span>
          <code>{str(i.pattern)}</code>
          {str(i.path) && <span className="q-path">in {str(i.path)}</span>}
        </div>
        {block.result && <pre className="tool-io">{out || '(no matches)'}</pre>}
      </div>
    )
  }

  if (/^toolsearch$/.test(n)) {
    const names = block.result ? parseToolNames(out) : []
    return (
      <div className="tool-body">
        <div className="tool-query">
          <span className="q-label">query</span>
          <code>{str(i.query)}</code>
        </div>
        {block.result &&
          (names.length ? (
            <div className="tool-chips">
              {names.map((nm, k) => (
                <span key={k} className="tool-chip">
                  {nm}
                </span>
              ))}
            </div>
          ) : (
            <pre className="tool-io">{out || '(no tools)'}</pre>
          ))}
      </div>
    )
  }

  if (/^(agent|task)$/.test(n)) {
    return (
      <div className="tool-body">
        <div className="task-meta">
          <span className="task-type">{str(i.subagent_type) || 'agent'}</span>
          {str(i.model) && <span className="task-model">{str(i.model)}</span>}
          {str(i.description) && <span className="task-desc">{str(i.description)}</span>}
        </div>
        {str(i.prompt) && (
          <details className="task-prompt">
            <summary>prompt</summary>
            <div className="block-text tool-md">
              <Markdown text={str(i.prompt)} />
            </div>
          </details>
        )}
        {block.result && (
          <div className="block-text tool-md">
            <Markdown text={out} />
          </div>
        )}
      </div>
    )
  }

  if (/^todowrite$/.test(n)) {
    const todos = Array.isArray(i.todos) ? i.todos : []
    return (
      <div className="tool-body">
        <ul className="todo-list">
          {todos.map((t, k) => {
            const r = asRecord(t)
            const st = str(r.status)
            const mark = st === 'completed' ? '✓' : st === 'in_progress' ? '◐' : '○'
            return (
              <li key={k} className={`todo ${st}`}>
                <span className="todo-mark">{mark}</span>
                <span className="todo-text">{str(r.content)}</span>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  if (/^webfetch$/.test(n)) {
    return (
      <div className="tool-body">
        <div className="tool-query">
          <span className="q-label">url</span>
          <code>{str(i.url)}</code>
        </div>
        {str(i.prompt) && <div className="shell-desc">{str(i.prompt)}</div>}
        {block.result && (
          <div className="block-text tool-md">
            <Markdown text={out} />
          </div>
        )}
      </div>
    )
  }

  if (/^websearch$/.test(n)) {
    return (
      <div className="tool-body">
        <div className="tool-query">
          <span className="q-label">search</span>
          <code>{str(i.query)}</code>
        </div>
        {block.result && <pre className="tool-io">{out}</pre>}
      </div>
    )
  }

  if (/^skill$/.test(n)) {
    return (
      <div className="tool-body">
        <div className="tool-query">
          <span className="q-label">skill</span>
          <code>{str(i.skill)}</code>
        </div>
        {str(i.args) && <div className="shell-desc">{str(i.args)}</div>}
        {block.result && <pre className="tool-io">{out}</pre>}
      </div>
    )
  }

  if (isContextWrite(block.name)) {
    const c = str(i.content)
    const looksJson = /^\s*[[{]/.test(c)
    return (
      <div className="tool-body">
        <div className="ctx-write">
          {looksJson ? (
            <CodeBlock code={c} lang="json" />
          ) : (
            <div className="block-text">
              <Markdown text={c} />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="tool-body">
      <div className="tool-section-label">input</div>
      <pre className="tool-io">{pretty(block.input)}</pre>
      {block.result && (
        <>
          <div className="tool-section-label">result</div>
          <pre className="tool-io">{out}</pre>
        </>
      )}
    </div>
  )
}

export const ToolCallView = memo(function ToolCallView({ block }: { block: ToolUse }) {
  const s = summary(block.name, block.input)
  const kind = toolKindClass(block.name)
  return (
    <details className="block-tool" open>
      <summary>
        <span className={`tool-name ${kind}`}>{s.label}</span>
        {s.detail && <span className={`tool-detail ${s.mono ? 'mono' : ''}`}>{s.detail}</span>}
        {block.result && (
          <span className={`tool-status ${block.result.ok ? 'ok' : 'err'}`}>
            {block.result.ok ? '✓' : '✕'}
          </span>
        )}
      </summary>
      <ToolBody block={block} />
    </details>
  )
})
