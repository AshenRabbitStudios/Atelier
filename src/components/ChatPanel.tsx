import { Fragment, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  KNOWN_MODELS,
  type EffortLevel,
  type ForkPoint,
  type ModelOption,
  type PermissionRequest,
  type Question,
  type QuestionRequest,
  type RunningTask,
  type TaskItem
} from '@shared/events'
import type { AgentError, Block, Message } from '../transcriptModel'
import { storeFor } from '../services/conversationViewStore'
import { Markdown } from './Markdown'
import { ToolCallView } from './ToolCall'

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
  // All conversation state lives in the per-conversation store (services/conversationViewStore),
  // which outlives this panel — Dockview disposes panels on tab switch, and events keep reducing
  // into the store while this conversation is hidden. This component is a disposable view.
  const store = useMemo(() => storeFor(instanceId), [instanceId])
  const state = useSyncExternalStore(store.subscribeTranscript, store.getTranscript)
  const view = useSyncExternalStore(store.subscribeView, store.getView)
  const [models, setModels] = useState<ModelOption[]>(KNOWN_MODELS)
  const bottomRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // 1s re-render tick while working — the elapsed clock's ANCHOR lives in state.turnStartedAt.
  const [, setNowTick] = useState(0)

  // Current model/effort for the header controls (system_init may predate the store).
  useEffect(() => {
    void window.atelier.agent
      .list()
      .then((list) => {
        const inst = list.find((i) => i.id === instanceId)
        if (inst?.model) store.dispatch({ type: 'set-model', model: inst.model })
        if (inst?.effort) store.dispatch({ type: 'set-effort', effort: inst.effort })
      })
      .catch(() => {})
  }, [instanceId, store])

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
    store.dispatch({ type: 'set-model', model })
    void window.atelier.agent.setModel(instanceId, model)
  }

  const effortLevels = models.find((m) => m.value === state.model)?.supportedEffortLevels ?? []
  const onEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const effort = e.target.value as EffortLevel
    store.dispatch({ type: 'set-effort', effort })
    void window.atelier.agent.setEffort(instanceId, effort)
  }

  // Restore the persisted scroll position on (re)mount: tail-pinned users land at the tail,
  // scrolled-up readers land where they left off (Dockview disposed the DOM on tab switch).
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    if (store.scrollAtBottom) bottomRef.current?.scrollIntoView({ block: 'end' })
    else el.scrollTop = store.scrollTop
  }, [store])

  // Stick to the bottom only when the user is already watching the tail; if they
  // have scrolled up to read, leave their position alone as new text streams in.
  // `status` is a dep too so the thinking/activity spinner (which appears when the turn
  // starts, before any message delta) scrolls into view instead of dropping below the fold.
  useEffect(() => {
    if (view.viewTask === null && store.scrollAtBottom)
      bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state.messages, state.pending, state.status, view.viewTask, store])

  // Returning from a background-task view lands you back at the bottom of the chat. TRANSITION
  // only (not on mount, which must respect the restored scroll position instead).
  const prevViewTaskRef = useRef(view.viewTask)
  useEffect(() => {
    const was = prevViewTaskRef.current
    prevViewTaskRef.current = view.viewTask
    if (was !== null && view.viewTask === null) {
      store.scrollAtBottom = true
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [view.viewTask, store])

  // Closing a dock panel (e.g. a bottom-docked plugin) makes Dockview reparent this scroll
  // container, which resets its native scrollTop to 0 — leaving a tail-pinned user stranded at the
  // top with no state change to re-scroll them. Re-pin to the tail on any resize when they were at
  // the bottom (also keeps the tail glued through window/panel resizes generally).
  useEffect(() => {
    const el = transcriptRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (view.viewTask === null && store.scrollAtBottom)
        bottomRef.current?.scrollIntoView({ block: 'end' })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [view.viewTask, store])

  const onTranscriptScroll = () => {
    const el = transcriptRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    store.scrollAtBottom = distanceFromBottom <= 40
    store.scrollTop = el.scrollTop
  }

  const busy = state.status === 'working'

  // Run a 1s clock while working so the elapsed readout updates. The start time is store
  // state (anchored by main), so the clock survives tab switches instead of restarting.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [busy])
  const elapsedSec = state.turnStartedAt
    ? Math.max(0, Math.floor((Date.now() - state.turnStartedAt) / 1000))
    : 0

  const send = (raw: string) => {
    const text = raw.trim()
    if (!text) return // allowed while busy: the message queues and runs after the current turn
    store.scrollAtBottom = true // sending is an explicit action — jump to the tail
    store.dispatch({ type: 'user', id: crypto.randomUUID(), text })
    void window.atelier.agent.send(instanceId, text)
  }

  const interrupt = () => void window.atelier.agent.interrupt(instanceId)

  const decide: DecideFn = (requestId, behavior, allowAlways) => {
    void window.atelier.agent.decide(instanceId, requestId, behavior, allowAlways)
    store.dispatch({ type: 'resolve-permission', requestId })
  }

  const answer: AnswerFn = (requestId, answers, response) => {
    void window.atelier.agent.answer(instanceId, requestId, answers, response)
    store.dispatch({ type: 'resolve-question', requestId })
  }

  const bypass = state.permissionMode === 'bypassPermissions'
  const toggleBypass = (e: React.ChangeEvent<HTMLInputElement>) => {
    void window.atelier.agent.setPermissionMode(
      instanceId,
      e.target.checked ? 'bypassPermissions' : 'default'
    )
  }

  const toggleAutoResume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const on = e.target.checked
    store.dispatch({ type: 'set-auto-resume', enabled: on })
    void window.atelier.agent.setAutoResume(instanceId, on)
  }

  const startEdit = (m: Message) => store.setView({ editing: { id: m.id, draft: messageText(m) } })
  const cancelEdit = () => store.setView({ editing: null })
  const changeDraft = (draft: string) =>
    store.setView({ editing: view.editing ? { ...view.editing, draft } : null })

  const saveEdit = async () => {
    if (!view.editing) return
    const id = view.editing.id
    const draft = view.editing.draft
    store.setView({ editing: null })
    const t = await window.atelier.agent.editSave(instanceId, id, draft)
    store.dispatch({ type: 'transcript', messages: t })
    store.dispatch({
      type: 'fork-points',
      forkPoints: await window.atelier.agent.forkPoints(instanceId)
    })
  }

  const forkEdit = () => {
    if (!view.editing) return
    store.scrollAtBottom = true
    // Clear the stale tail immediately, then the new branch streams in.
    store.dispatch({
      type: 'fork-local',
      uuid: view.editing.id,
      tempId: crypto.randomUUID(),
      newText: view.editing.draft
    })
    void window.atelier.agent.fork(instanceId, view.editing.id, view.editing.draft)
    store.setView({ editing: null })
  }

  const switchBranch = async (sessionId: string) => {
    const res = await window.atelier.agent.switchBranch(instanceId, sessionId)
    store.dispatch({ type: 'transcript', messages: res.transcript })
    store.dispatch({ type: 'fork-points', forkPoints: res.forkPoints })
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
        <label
          className={`switch ${state.autoResumeEnabled ? 'on' : ''}`}
          title="When a usage limit interrupts the chat, wait for it to reset and resume automatically — no polling, no requests while limited"
        >
          <input type="checkbox" checked={state.autoResumeEnabled} onChange={toggleAutoResume} />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span className="switch-text">auto-resume</span>
        </label>
        {/* A turn blocked on an approval/question is NOT "working" — say what it's waiting for. */}
        {state.pending.length > 0 || state.questions.length > 0 ? (
          <span className="status status-approval">needs approval</span>
        ) : (
          <span className={`status status-${state.status}`}>{state.status}</span>
        )}
      </header>

      <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
        {view.viewTask !== null && (
          <TaskViewer
            taskId={view.viewTask}
            task={state.background.find((t) => t.kind === 'subagent' && t.id === view.viewTask)}
            items={state.taskViews[view.viewTask] ?? []}
            onBack={() => store.setView({ viewTask: null })}
          />
        )}
        {view.viewTask === null && state.messages.length > view.visibleCount && (
          <button
            className="load-earlier"
            onClick={() => store.setView({ visibleCount: view.visibleCount + 200 })}
            title="Older messages are hidden to keep the UI responsive"
          >
            Show earlier messages ({state.messages.length - view.visibleCount} hidden)
          </button>
        )}
        {view.viewTask === null &&
          (() => {
            // Interleave errors into the message stream at the point they occurred (err.after = the
            // message count at error time), so an error scrolls up with the conversation instead of
            // staying pinned below the newest message. Errors anchored above the visible window or
            // past the current end fall back to the end (rare: truncated view / after an edit-fork).
            const msgs = state.messages
            const offset = msgs.length > view.visibleCount ? msgs.length - view.visibleCount : 0
            const shown = msgs.slice(offset)
            const errorNote = (err: AgentError): React.JSX.Element => (
              <details key={err.id} className="error-note" open>
                <summary>
                  <span className="error-msg">{err.message}</span>
                  <button
                    className="error-dismiss"
                    title="Dismiss"
                    aria-label="Dismiss error"
                    onClick={() => store.dispatch({ type: 'dismiss-error', id: err.id })}
                  >
                    ×
                  </button>
                </summary>
                {err.detail !== undefined && (
                  <pre className="error-detail">{pretty(err.detail)}</pre>
                )}
              </details>
            )
            return (
              <>
                {shown.map((m, i) => (
                  <Fragment key={m.id}>
                    <MessageView
                      message={m}
                      live={busy && m.role === 'assistant' && i === shown.length - 1}
                      editing={view.editing?.id === m.id ? view.editing.draft : null}
                      forkPoint={state.forkPoints[m.id]}
                      onSwitch={switchBranch}
                      onStartEdit={() => startEdit(m)}
                      onChangeDraft={changeDraft}
                      onSave={saveEdit}
                      onFork={forkEdit}
                      onCancel={cancelEdit}
                    />
                    {state.errors.filter((e) => e.after === offset + i + 1).map(errorNote)}
                  </Fragment>
                ))}
                {state.errors
                  .filter((e) => e.after <= offset || e.after > msgs.length)
                  .map(errorNote)}
              </>
            )
          })()}
        {view.viewTask === null &&
          busy &&
          state.pending.length === 0 &&
          state.questions.length === 0 && (
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
        {view.viewTask === null && !busy && typeof state.autoResumeAt === 'number' && (
          <div className="resume-banner">
            <span className="spinner" />
            <span>
              Usage limit reached — auto-resuming at <strong>{fmtClock(state.autoResumeAt)}</strong>
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

      {state.background.length > 0 && (
        <div className="background">
          <button
            className="background-bar"
            onClick={() => store.setView({ showBackground: !view.showBackground })}
            title="Background subagents and tasks running for this conversation"
          >
            <span className="spinner" />
            <span className="background-count">
              {state.background.length} running in the background
            </span>
            <span className="background-caret">{view.showBackground ? '▾' : '▸'}</span>
          </button>
          {view.showBackground && (
            <ul className="background-list">
              {state.background.map((t) => (
                <li key={`${t.kind}:${t.id}`}>
                  <button
                    className="background-item"
                    disabled={t.kind !== 'subagent'}
                    title={
                      t.kind === 'subagent'
                        ? 'View this subagent’s live activity'
                        : 'No live view for this task kind'
                    }
                    onClick={() => store.setView({ viewTask: t.id, showBackground: false })}
                  >
                    <span className={`background-kind background-kind-${t.kind}`}>
                      {t.kind === 'subagent' ? 'agent' : 'task'}
                    </span>
                    <span className="background-label">{t.label}</span>
                    {t.detail && <span className="background-detail">{t.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Composer
        busy={busy}
        initialDraft={store.draft}
        onDraftChange={(t) => {
          store.draft = t
        }}
        onSend={send}
        onInterrupt={interrupt}
      />
    </div>
  )
}

/**
 * Live view of one background subagent's activity (its forwarded conversation), shown in the
 * transcript area while the user peeks at it. Purely a view — sending still goes to the main
 * thread, and the Back button returns to the chat.
 */
function TaskViewer({
  taskId,
  task,
  items,
  onBack
}: {
  taskId: string
  task?: RunningTask
  items: TaskItem[]
  onBack: () => void
}) {
  return (
    <div className="task-view">
      <div className="task-banner">
        <button className="task-back" onClick={onBack} title="Return to the main conversation">
          ‹ Back to chat
        </button>
        <span className="task-title">
          {task ? task.label : 'background task'}
          {task?.detail ? ` — ${task.detail}` : ''}
        </span>
        <span className={`task-state ${task ? 'running' : 'done'}`}>
          {task ? 'running' : 'finished'}
        </span>
      </div>
      {items.length === 0 && (
        <div className="task-empty">
          No activity captured yet{task ? ' — it should appear here as the agent works' : ''}.
          <span className="task-empty-id"> (task {taskId.slice(0, 12)}…)</span>
        </div>
      )}
      {items.map((item, i) => {
        if (item.kind === 'text') {
          return (
            <div key={i} className="task-item-text">
              <Markdown text={item.text} />
            </div>
          )
        }
        if (item.kind === 'thinking') {
          return (
            <details key={i} className="task-item-thinking">
              <summary>thinking</summary>
              <div>{item.text}</div>
            </details>
          )
        }
        if (item.kind === 'tool_use') {
          return (
            <details key={i} className="task-item-tool">
              <summary>
                <span className="task-tool-name">{item.name}</span>
              </summary>
              <pre>{pretty(item.input)}</pre>
            </details>
          )
        }
        return (
          <details key={i} className={`task-item-result ${item.ok ? '' : 'failed'}`}>
            <summary>{item.ok ? 'result' : 'result (error)'}</summary>
            <pre>{pretty(item.output)}</pre>
          </details>
        )
      })}
      {task && (
        <div className="activity">
          <span className="spinner" />
          <span>working…</span>
        </div>
      )}
    </div>
  )
}

/**
 * The composer owns its own input state so typing never re-renders the (potentially
 * huge) transcript — that was the source of multi-second keystroke lag on long chats.
 * The draft is written through to the store (non-reactively) so it survives the panel
 * being disposed on a conversation switch.
 */
function Composer({
  busy,
  initialDraft,
  onDraftChange,
  onSend,
  onInterrupt
}: {
  busy: boolean
  initialDraft: string
  onDraftChange: (text: string) => void
  onSend: (text: string) => void
  onInterrupt: () => void
}) {
  const [input, setInput] = useState(initialDraft)
  const change = (t: string) => {
    setInput(t)
    onDraftChange(t)
  }
  const submit = () => {
    const t = input.trim()
    if (!t) return // allowed while busy — the message queues for after the current turn
    onSend(t)
    change('')
  }
  return (
    <div className="composer">
      <div className="composer-field">
        <textarea
          value={input}
          onChange={(e) => change(e.target.value)}
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
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
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
