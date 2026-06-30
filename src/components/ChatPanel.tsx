import { memo, useEffect, useReducer, useRef, useState } from 'react'
import {
  KNOWN_MODELS,
  type EffortLevel,
  type ForkPoint,
  type ModelOption,
  type PermissionRequest,
  type Question,
  type QuestionRequest
} from '@shared/events'
import { initialState, reduce, type Block, type Message } from '../transcriptModel'
import { Markdown } from './Markdown'
import { ToolCallView } from './ToolCall'

// Render only the last N messages by default; older ones load on demand. Keeps a huge
// transcript from blocking the main thread (markdown + Shiki tokenize synchronously per block).
const VISIBLE_DEFAULT = 60

type DecideFn = (requestId: string, behavior: 'allow' | 'deny', allowAlways?: boolean) => void
type AnswerFn = (requestId: string, answers: Record<string, string>, response?: string) => void

/** The editable text of a message = its text blocks joined. */
function messageText(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('')
}

export function ChatPanel({ instanceId }: { instanceId: string }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const [models, setModels] = useState<ModelOption[]>(KNOWN_MODELS)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Whether the user is at (or near) the tail. Updated on scroll; not state, so
  // it never triggers a re-render. Starts true so the first messages stick.
  const atBottomRef = useRef(true)
  // Only render the last N messages so a huge transcript doesn't block the main thread
  // (markdown + Shiki are synchronous per block). "Show earlier" raises this on demand.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_DEFAULT)
  // Generation guard: ignore a transcript load that resolves after a newer one (e.g. a
  // mount-time load landing after Clear chat) so stale messages can't repopulate.
  const loadGenRef = useRef(0)
  // Elapsed-time clock for the in-flight turn (ticks once a second while working).
  const turnStartRef = useRef<number | null>(null)
  const [, setNowTick] = useState(0)

  // Load the authoritative transcript (with on-disk uuids) + branch list.
  const loadCanonical = async () => {
    const gen = ++loadGenRef.current
    // Independent so a transcript failure can't also drop the branch update.
    try {
      const messages = await window.atelier.agent.transcript(instanceId)
      if (gen === loadGenRef.current) dispatch({ type: 'transcript', messages })
    } catch {
      /* transcript not available yet */
    }
    try {
      const forkPoints = await window.atelier.agent.forkPoints(instanceId)
      if (gen === loadGenRef.current) dispatch({ type: 'fork-points', forkPoints })
    } catch {
      /* fork points not available yet */
    }
  }

  useEffect(() => {
    const off = window.atelier.agent.onEvent((e) => {
      if (e.instanceId !== instanceId) return
      dispatch({ type: 'event', event: e })
      // After each completed turn, reconcile to the on-disk transcript so messages
      // carry real uuids (needed for edit/fork) and tool results are fully paired.
      if (e.kind === 'result') setTimeout(() => void loadCanonical(), 150)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // Clear-chat resets the transcript VIEW (not the dock layout, so plugin panes are
  // untouched). App dispatches this after agent.clearChat starts a fresh session.
  useEffect(() => {
    const onReload = (e: Event) => {
      if ((e as CustomEvent).detail !== instanceId) return
      dispatch({ type: 'transcript', messages: [] })
      void loadCanonical()
    }
    window.addEventListener('atelier-reload-transcript', onReload)
    return () => window.removeEventListener('atelier-reload-transcript', onReload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // Hydrate when (re)mounted onto an existing instance: load its transcript and
  // current model, since system_init already fired before this panel mounted.
  useEffect(() => {
    void loadCanonical()
    void window.atelier.agent
      .list()
      .then((list) => {
        const inst = list.find((i) => i.id === instanceId)
        if (inst?.model) dispatch({ type: 'set-model', model: inst.model })
        if (inst?.effort) dispatch({ type: 'set-effort', effort: inst.effort })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  useEffect(() => {
    let alive = true
    void window.atelier.agent
      .models(instanceId)
      .then((list) => {
        if (!alive) return
        // Start from the curated full list; append any extra full model IDs the
        // SDK reports (skip the bare family aliases like sonnet/opus/haiku).
        const have = new Set(KNOWN_MODELS.map((m) => m.value))
        const extra = list.filter((m) => m.value.startsWith('claude-') && !have.has(m.value))
        setModels([...KNOWN_MODELS, ...extra])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [instanceId])

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const model = e.target.value
    dispatch({ type: 'set-model', model })
    void window.atelier.agent.setModel(instanceId, model)
  }

  const effortLevels = models.find((m) => m.value === state.model)?.supportedEffortLevels ?? []
  const onEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const effort = e.target.value as EffortLevel
    dispatch({ type: 'set-effort', effort })
    void window.atelier.agent.setEffort(instanceId, effort)
  }

  // Stick to the bottom only when the user is already watching the tail; if they
  // have scrolled up to read, leave their position alone as new text streams in.
  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state.messages, state.pending])

  const onTranscriptScroll = () => {
    const el = transcriptRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottomRef.current = distanceFromBottom <= 40
  }

  const busy = state.status === 'working'

  // Run a 1s clock while working so the elapsed time updates; stop (and reset) when idle.
  useEffect(() => {
    if (!busy) {
      turnStartRef.current = null
      return
    }
    if (turnStartRef.current === null) turnStartRef.current = Date.now()
    const t = setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [busy])
  const elapsedSec = turnStartRef.current
    ? Math.floor((Date.now() - turnStartRef.current) / 1000)
    : 0

  const send = (raw: string) => {
    const text = raw.trim()
    if (!text) return // allowed while busy: the message queues and runs after the current turn
    atBottomRef.current = true // sending is an explicit action — jump to the tail
    dispatch({ type: 'user', id: crypto.randomUUID(), text })
    void window.atelier.agent.send(instanceId, text)
  }

  const interrupt = () => void window.atelier.agent.interrupt(instanceId)

  const decide: DecideFn = (requestId, behavior, allowAlways) => {
    void window.atelier.agent.decide(instanceId, requestId, behavior, allowAlways)
    dispatch({ type: 'resolve-permission', requestId })
  }

  const answer: AnswerFn = (requestId, answers, response) => {
    void window.atelier.agent.answer(instanceId, requestId, answers, response)
    dispatch({ type: 'resolve-question', requestId })
  }

  const bypass = state.permissionMode === 'bypassPermissions'
  const toggleBypass = (e: React.ChangeEvent<HTMLInputElement>) => {
    void window.atelier.agent.setPermissionMode(
      instanceId,
      e.target.checked ? 'bypassPermissions' : 'default'
    )
  }

  const startEdit = (m: Message) => setEditing({ id: m.id, draft: messageText(m) })
  const cancelEdit = () => setEditing(null)
  const changeDraft = (draft: string) => setEditing((e) => (e ? { ...e, draft } : e))

  const saveEdit = async () => {
    if (!editing) return
    const id = editing.id
    const draft = editing.draft
    setEditing(null)
    const t = await window.atelier.agent.editSave(instanceId, id, draft)
    dispatch({ type: 'transcript', messages: t })
    dispatch({ type: 'fork-points', forkPoints: await window.atelier.agent.forkPoints(instanceId) })
  }

  const forkEdit = () => {
    if (!editing) return
    atBottomRef.current = true
    // Clear the stale tail immediately, then the new branch streams in.
    dispatch({
      type: 'fork-local',
      uuid: editing.id,
      tempId: crypto.randomUUID(),
      newText: editing.draft
    })
    void window.atelier.agent.fork(instanceId, editing.id, editing.draft) // streams; result reloads
    setEditing(null)
  }

  const switchBranch = async (sessionId: string) => {
    const res = await window.atelier.agent.switchBranch(instanceId, sessionId)
    dispatch({ type: 'transcript', messages: res.transcript })
    dispatch({ type: 'fork-points', forkPoints: res.forkPoints })
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <select
          className="model-select"
          value={state.model ?? ''}
          onChange={onModelChange}
          disabled={models.length === 0}
          title="Model for this instance"
        >
          {state.model && !models.some((m) => m.value === state.model) && (
            <option value={state.model}>{state.model}</option>
          )}
          {models.length === 0 && !state.model && <option value="">model…</option>}
          {models.map((m) => (
            <option key={m.value} value={m.value} disabled={m.disabled}>
              {m.displayName}
            </option>
          ))}
        </select>
        {effortLevels.length > 0 && (
          <select
            className="model-select effort-select"
            value={state.effort ?? 'high'}
            onChange={onEffortChange}
            title="Reasoning effort for this conversation"
          >
            {effortLevels.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        )}
        {state.apiKeySource && (
          <span
            className={`badge ${isSubscription(state.apiKeySource) ? 'badge-ok' : 'badge-warn'}`}
            title={
              isSubscription(state.apiKeySource)
                ? 'Using your Claude subscription session (no API key)'
                : `API key in use (source: ${state.apiKeySource}) — this may bill the API`
            }
          >
            {isSubscription(state.apiKeySource) ? 'subscription' : `API: ${state.apiKeySource}`}
          </span>
        )}
        <label
          className={`switch ${bypass ? 'on' : ''}`}
          title="Skip all tool approval prompts (equivalent to --dangerously-skip-permissions)"
        >
          <input type="checkbox" checked={bypass} onChange={toggleBypass} />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span className="switch-text">bypass approvals</span>
        </label>
        <span className={`status status-${state.status}`}>{state.status}</span>
      </header>

      <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
        {state.messages.length > visibleCount && (
          <button
            className="load-earlier"
            onClick={() => setVisibleCount((v) => v + 200)}
            title="Older messages are hidden to keep the UI responsive"
          >
            Show earlier messages ({state.messages.length - visibleCount} hidden)
          </button>
        )}
        {(state.messages.length > visibleCount
          ? state.messages.slice(-visibleCount)
          : state.messages
        ).map((m, i, shown) => (
          <MessageView
            key={m.id}
            message={m}
            live={busy && m.role === 'assistant' && i === shown.length - 1}
            editing={editing?.id === m.id ? editing.draft : null}
            forkPoint={state.forkPoints[m.id]}
            onSwitch={switchBranch}
            onStartEdit={() => startEdit(m)}
            onChangeDraft={changeDraft}
            onSave={saveEdit}
            onFork={forkEdit}
            onCancel={cancelEdit}
          />
        ))}
        {state.errors.map((err, i) => (
          <details key={`err-${i}`} className="error-note" open>
            <summary>{err.message}</summary>
            {err.detail !== undefined && <pre className="error-detail">{pretty(err.detail)}</pre>}
          </details>
        ))}
        {busy && state.pending.length === 0 && state.questions.length === 0 && (
          <div className="activity">
            <span className="spinner" />
            <span>{activityLabel(state.messages)}</span>
            <span className="activity-meta">
              {state.liveTokens && state.liveTokens.output > 0
                ? `${fmtTokens(state.liveTokens.output)} tokens · `
                : ''}
              {fmtElapsed(elapsedSec)}
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {state.questions.length > 0 && (
        <div className="questions">
          {state.questions.map((q) => (
            <QuestionCard key={q.requestId} req={q} onAnswer={answer} />
          ))}
        </div>
      )}

      {state.pending.length > 0 && (
        <div className="permissions">
          {state.pending.map((p) => (
            <PermissionCard key={p.requestId} req={p} onDecide={decide} />
          ))}
        </div>
      )}

      <Composer busy={busy} onSend={send} onInterrupt={interrupt} />
    </div>
  )
}

/**
 * The composer owns its own input state so typing never re-renders the (potentially
 * huge) transcript — that was the source of multi-second keystroke lag on long chats.
 */
function Composer({
  busy,
  onSend,
  onInterrupt
}: {
  busy: boolean
  onSend: (text: string) => void
  onInterrupt: () => void
}) {
  const [input, setInput] = useState('')
  const submit = () => {
    const t = input.trim()
    if (!t) return // allowed while busy — the message queues for after the current turn
    onSend(t)
    setInput('')
  }
  return (
    <div className="composer">
      <div className="composer-field">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={
            busy
              ? 'Queue a message…  (sent after the current step; Stop to interrupt)'
              : 'Message the agent…  (Enter to send, Shift+Enter for newline)'
          }
          rows={3}
        />
        {busy && (
          <button className="stop-btn" onClick={onInterrupt} title="Stop the current turn">
            ■
          </button>
        )}
        <button
          className="send-btn"
          onClick={submit}
          disabled={!input.trim()}
          title={busy ? 'Queue this message' : 'Send'}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

interface MessageViewProps {
  message: Message
  live: boolean // this is the in-progress assistant turn (auto-expand its thinking)
  editing: string | null // the draft text if this message is being edited, else null
  forkPoint?: ForkPoint
  onSwitch: (sessionId: string) => void
  onStartEdit: () => void
  onChangeDraft: (s: string) => void
  onSave: () => void
  onFork: () => void
  onCancel: () => void
}

// Memoized so a streaming token only re-renders the ONE growing message, not the whole
// visible transcript (markdown + Shiki are expensive). Compare the data props only; the
// handler closures change identity every render but are behaviorally stable (they act via
// setters + the stable message ref), so ignoring them here is safe and is the whole point.
const MessageView = memo(MessageViewImpl, (a, b) => {
  return (
    a.message === b.message &&
    a.live === b.live &&
    a.editing === b.editing &&
    a.forkPoint === b.forkPoint
  )
})

function MessageViewImpl({
  message,
  live,
  editing,
  forkPoint,
  onSwitch,
  onStartEdit,
  onChangeDraft,
  onSave,
  onFork,
  onCancel
}: MessageViewProps) {
  const canEdit = message.blocks.some((b) => b.kind === 'text')
  const isEditing = editing !== null

  const go = (delta: number) => {
    if (!forkPoint) return
    const target = forkPoint.versions[forkPoint.index + delta]
    if (target) onSwitch(target)
  }

  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-role">
        {message.role}
        {canEdit && !isEditing && (
          <button className="msg-edit-btn" title="Edit this message" onClick={onStartEdit}>
            ✎
          </button>
        )}
        {forkPoint && forkPoint.versions.length > 1 && (
          <span className="branch-nav" title="Switch between forked versions of this message">
            <button className="branch-arrow" disabled={forkPoint.index <= 0} onClick={() => go(-1)}>
              ‹
            </button>
            <span className="branch-pos">
              {forkPoint.index + 1}/{forkPoint.versions.length}
            </span>
            <button
              className="branch-arrow"
              disabled={forkPoint.index >= forkPoint.versions.length - 1}
              onClick={() => go(1)}
            >
              ›
            </button>
          </span>
        )}
      </div>
      {isEditing ? (
        <div className="msg-editor">
          <textarea value={editing} onChange={(e) => onChangeDraft(e.target.value)} rows={6} />
          <div className="msg-editor-actions">
            <button className="btn btn-send" onClick={onSave} title="Save in place (no re-run)">
              Save
            </button>
            {message.role === 'user' && (
              <button
                className="btn btn-allow-always"
                onClick={onFork}
                title="Branch a new version from here"
              >
                Fork
              </button>
            )}
            <button className="btn btn-stop" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="msg-body">
          {message.blocks.map((b, i) => (
            <BlockView key={i} block={b} live={live} />
          ))}
        </div>
      )}
    </div>
  )
}

function BlockView({ block, live }: { block: Block; live: boolean }) {
  switch (block.kind) {
    case 'text':
      return (
        <div className="block-text">
          <Markdown text={block.text} />
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={block.text} live={live} />
    case 'tool_use':
      return <ToolCallView block={block} />
  }
}

function PermissionCard({ req, onDecide }: { req: PermissionRequest; onDecide: DecideFn }) {
  return (
    <div className="perm-card">
      <div className="perm-head">
        <span className="perm-label">Approval needed</span>
        <span className="perm-tool">{req.toolName}</span>
      </div>
      <div className="perm-title">{req.title}</div>
      <pre className="perm-input">{pretty(req.input)}</pre>
      <div className="perm-actions">
        <button className="btn btn-allow" onClick={() => onDecide(req.requestId, 'allow')}>
          Allow
        </button>
        {req.canAllowAlways && (
          <button
            className="btn btn-allow-always"
            onClick={() => onDecide(req.requestId, 'allow', true)}
          >
            Allow always
          </button>
        )}
        <button className="btn btn-deny" onClick={() => onDecide(req.requestId, 'deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}

function QuestionCard({ req, onAnswer }: { req: QuestionRequest; onAnswer: AnswerFn }) {
  // Per-question selected option labels (multi-select keeps several).
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [freeform, setFreeform] = useState('')

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[qi] ?? []
      if (multi) {
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
        return { ...prev, [qi]: next }
      }
      return { ...prev, [qi]: cur[0] === label ? [] : [label] }
    })
  }

  const allAnswered = req.questions.every((_, qi) => (picked[qi]?.length ?? 0) > 0)
  const canSubmit = allAnswered || freeform.trim().length > 0

  const submit = () => {
    const answers: Record<string, string> = {}
    req.questions.forEach((q, qi) => {
      const sel = picked[qi] ?? []
      if (sel.length) answers[q.question] = sel.join(', ')
    })
    onAnswer(req.requestId, answers, freeform.trim() || undefined)
  }

  return (
    <div className="q-card">
      <div className="q-head">
        <span className="q-label">The agent is asking you</span>
      </div>
      {req.questions.map((q: Question, qi) => (
        <div key={qi} className="q-block">
          <div className="q-meta">
            <span className="q-chip">{q.header}</span>
            {q.multiSelect && <span className="q-multi">choose any</span>}
          </div>
          <div className="q-question">{q.question}</div>
          <div className="q-options">
            {q.options.map((opt) => {
              const on = (picked[qi] ?? []).includes(opt.label)
              return (
                <button
                  key={opt.label}
                  className={`q-option${on ? ' q-option-on' : ''}`}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                  title={opt.description}
                >
                  <span className="q-option-label">{opt.label}</span>
                  {opt.description && <span className="q-option-desc">{opt.description}</span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <input
        className="q-freeform"
        value={freeform}
        onChange={(e) => setFreeform(e.target.value)}
        placeholder="Or type a different answer…"
      />
      <div className="q-actions">
        <button className="btn btn-allow" onClick={submit} disabled={!canSubmit}>
          Submit
        </button>
        <button className="btn btn-deny" onClick={() => onAnswer(req.requestId, {})}>
          Skip
        </button>
      </div>
    </div>
  )
}

// A thinking block that auto-expands while the model is actively reasoning, so the chain of
// thought streams in live. Collapses to a toggle afterward (left where the user puts it).
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live)
  useEffect(() => {
    if (live) setOpen(true)
  }, [live])
  return (
    <div className={`block-thinking ${open ? 'open' : ''}`}>
      <button className="block-summary" onClick={() => setOpen((o) => !o)}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className={`thinking-label ${live ? 'live' : ''}`}>
          {live ? 'Thinking…' : 'Thought process'}
        </span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}
function fmtElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// A short description of what the agent is doing right now (for the working spinner row).
function activityLabel(messages: Message[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return 'Thinking…'
  const lb = last.blocks[last.blocks.length - 1]
  if (!lb) return 'Thinking…'
  if (lb.kind === 'tool_use') return lb.result ? 'Working…' : `Running ${lb.name}…`
  if (lb.kind === 'thinking') return 'Thinking…'
  return 'Writing…'
}

// Tint a tool by kind (DESIGN_SYSTEM.md §5): read=accent, edit=warn, bash=ok.

// 'oauth' = subscription login, 'none' = no API key (ambient session). Both are safe.
function isSubscription(source: string): boolean {
  return source === 'oauth' || source === 'none'
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
