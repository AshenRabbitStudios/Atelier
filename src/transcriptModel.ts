import type {
  AgentEvent,
  AgentStatus,
  EffortLevel,
  ForkPoints,
  PermissionMode,
  PermissionRequest,
  QuestionRequest,
  RunningTask,
  TaskItem,
  TranscriptBlock,
  TranscriptMessage,
  UiStateSnapshot
} from '@shared/events'

export interface ToolResult {
  ok: boolean
  output: unknown
}

export type Block =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'thinking'; index: number; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown; result?: ToolResult }

export interface Message {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
}

export interface TranscriptState {
  messages: Message[]
  status: AgentStatus
  // Version of `status` (main's monotonic seq). Status/anchor updates apply only when at least
  // this new, so a push and a resync snapshot can never race the display backwards.
  statusSeq: number
  sessionId?: string
  model?: string
  effort?: EffortLevel
  apiKeySource?: string
  tools: string[]
  pending: PermissionRequest[]
  questions: QuestionRequest[]
  permissionMode: PermissionMode
  forkPoints: ForkPoints
  lastResult?: { costUsd?: number; durationMs?: number; isError: boolean }
  liveTokens?: { output: number; input?: number } // running usage for the in-flight turn
  // Epoch-ms the in-flight run started (null when idle) — the elapsed clock derives from this,
  // so it survives panel remounts instead of restarting on every tab switch.
  turnStartedAt: number | null
  autoResumeEnabled: boolean // the auto-resume toggle (agent-side setting, mirrored here)
  autoResumeAt?: number | null // epoch-ms a usage limit resets when auto-resume is armed (else null)
  errors: AgentError[]
  background: RunningTask[] // subagents/tasks currently running (top indicator + picker)
  // Live activity per background subagent, keyed by its Task call's toolUseId. Kept after the
  // task finishes so the viewer can still show what it did; in-memory only (not persisted).
  taskViews: Record<string, TaskItem[]>
}

export interface AgentError {
  id: string
  message: string
  detail?: unknown
  // Number of messages present when the error occurred. The transcript renders the error right
  // after this many messages, so it scrolls up with the conversation instead of pinning to the
  // bottom of the pane forever. Survives reconciliation because history is append-only.
  after: number
}

export const initialState: TranscriptState = {
  messages: [],
  status: 'idle',
  statusSeq: 0,
  tools: [],
  pending: [],
  questions: [],
  permissionMode: 'default',
  forkPoints: {},
  turnStartedAt: null,
  autoResumeEnabled: false,
  errors: [],
  background: [],
  taskViews: {}
}

export type Action =
  | { type: 'event'; event: AgentEvent }
  | { type: 'hydrate'; snapshot: UiStateSnapshot }
  | { type: 'user'; id: string; text: string }
  | { type: 'resolve-permission'; requestId: string }
  | { type: 'resolve-question'; requestId: string }
  | { type: 'set-model'; model: string }
  | { type: 'set-effort'; effort: EffortLevel }
  | { type: 'set-auto-resume'; enabled: boolean }
  | { type: 'transcript'; messages: TranscriptMessage[] }
  | { type: 'fork-points'; forkPoints: ForkPoints }
  | { type: 'fork-local'; uuid: string; tempId: string; newText: string }
  | { type: 'dismiss-error'; id: string }

function toBlocks(blocks: TranscriptBlock[]): Block[] {
  return blocks.map((b, i) => {
    if (b.kind === 'text') return { kind: 'text', index: i, text: b.text }
    if (b.kind === 'thinking') return { kind: 'thinking', index: i, text: b.text }
    return {
      kind: 'tool_use',
      toolUseId: b.toolUseId,
      name: b.name,
      input: b.input,
      result: b.result
    }
  })
}

export function reduce(state: TranscriptState, action: Action): TranscriptState {
  if (action.type === 'hydrate') {
    // Resync to main's authoritative live state (store creation, panel mount, window focus,
    // and periodically while working — docs/STATUS_LOCKSTEP.md). Status and its clock anchor
    // apply only when the snapshot is at least as new as the last seen seq, so a snapshot
    // captured just before a status push can't regress the display.
    const s = action.snapshot
    const fresh = s.statusSeq >= state.statusSeq
    return {
      ...state,
      ...(fresh
        ? { status: s.status, statusSeq: s.statusSeq, turnStartedAt: s.turnStartedAt }
        : {}),
      permissionMode: s.permissionMode,
      pending: s.pending,
      questions: s.questions,
      background: s.background,
      autoResumeAt: s.autoResumeAt,
      autoResumeEnabled: s.autoResumeEnabled,
      liveTokens: s.tokens
    }
  }
  if (action.type === 'set-model') {
    return { ...state, model: action.model }
  }
  if (action.type === 'set-effort') {
    return { ...state, effort: action.effort }
  }
  if (action.type === 'set-auto-resume') {
    return { ...state, autoResumeEnabled: action.enabled }
  }
  if (action.type === 'dismiss-error') {
    return { ...state, errors: state.errors.filter((x) => x.id !== action.id) }
  }
  if (action.type === 'transcript') {
    return {
      ...state,
      messages: action.messages.map((m) => ({
        id: m.uuid,
        role: m.role,
        blocks: toBlocks(m.blocks)
      }))
    }
  }
  if (action.type === 'fork-points') {
    return { ...state, forkPoints: action.forkPoints }
  }
  if (action.type === 'fork-local') {
    // Truncate to before the forked message and show the edited message immediately,
    // so the stale tail clears the moment Fork is pressed (the new reply then streams).
    const idx = state.messages.findIndex((m) => m.id === action.uuid)
    const head = idx >= 0 ? state.messages.slice(0, idx) : state.messages
    const userMsg: Message = {
      id: action.tempId,
      role: 'user',
      blocks: [{ kind: 'text', index: 0, text: action.newText }]
    }
    return {
      ...state,
      messages: [...head, userMsg],
      status: 'working',
      turnStartedAt: Date.now(),
      liveTokens: { output: 0 }
    }
  }
  if (action.type === 'user') {
    const msg: Message = {
      id: action.id,
      role: 'user',
      blocks: [{ kind: 'text', index: 0, text: action.text }]
    }
    return { ...state, messages: [...state.messages, msg], liveTokens: { output: 0 } }
  }
  if (action.type === 'resolve-permission') {
    return { ...state, pending: state.pending.filter((p) => p.requestId !== action.requestId) }
  }
  if (action.type === 'resolve-question') {
    return { ...state, questions: state.questions.filter((q) => q.requestId !== action.requestId) }
  }
  return applyEvent(state, action.event)
}

function applyEvent(state: TranscriptState, e: AgentEvent): TranscriptState {
  switch (e.kind) {
    case 'system_init':
      return {
        ...state,
        sessionId: e.sessionId,
        model: e.model,
        apiKeySource: e.apiKeySource,
        tools: e.tools
      }
    case 'status':
      // Anchor the elapsed clock on the first transition to working; keep it across queued
      // turns within the run (main mirrors this — hydrate carries the authoritative value).
      if (e.seq < state.statusSeq) return state // stale push (a newer resync already landed)
      return {
        ...state,
        status: e.status,
        statusSeq: e.seq,
        turnStartedAt: e.status === 'working' ? (state.turnStartedAt ?? Date.now()) : null
      }
    case 'tokens':
      return { ...state, liveTokens: { output: e.output, input: e.input } }
    case 'auto_resume':
      return { ...state, autoResumeAt: e.resetsAt }
    case 'permission_request':
      if (state.pending.some((p) => p.requestId === e.requestId)) return state
      return {
        ...state,
        pending: [
          ...state.pending,
          {
            requestId: e.requestId,
            toolUseId: e.toolUseId,
            toolName: e.toolName,
            title: e.title,
            input: e.input,
            canAllowAlways: e.canAllowAlways
          }
        ]
      }
    case 'permission_resolved':
      return { ...state, pending: state.pending.filter((p) => p.requestId !== e.requestId) }
    case 'question_request':
      if (state.questions.some((q) => q.requestId === e.requestId)) return state
      return {
        ...state,
        questions: [
          ...state.questions,
          { requestId: e.requestId, toolUseId: e.toolUseId, questions: e.questions }
        ]
      }
    case 'question_resolved':
      return { ...state, questions: state.questions.filter((q) => q.requestId !== e.requestId) }
    case 'permission_mode':
      return { ...state, permissionMode: e.mode }
    case 'text':
      return appendDelta(state, e.messageId, 'text', e.index, e.delta)
    case 'thinking':
      return appendDelta(state, e.messageId, 'thinking', e.index, e.delta)
    case 'tool_use':
      return addToolUse(state, e.messageId, e.toolUseId, e.name, e.input)
    case 'tool_result':
      return setToolResult(state, e.toolUseId, { ok: e.ok, output: e.output })
    case 'result':
      return {
        ...state,
        lastResult: { costUsd: e.costUsd, durationMs: e.durationMs, isError: e.isError }
      }
    case 'background':
      return { ...state, background: e.tasks }
    case 'task_activity': {
      const items = state.taskViews[e.taskId] ?? []
      // Bound each task's buffer so a chatty subagent can't grow memory without limit.
      const next = items.length >= 500 ? [...items.slice(-499), e.item] : [...items, e.item]
      return { ...state, taskViews: { ...state.taskViews, [e.taskId]: next } }
    }
    case 'error':
      return {
        ...state,
        errors: [
          ...state.errors,
          {
            id: crypto.randomUUID(),
            message: e.message,
            detail: e.detail,
            after: state.messages.length
          }
        ]
      }
    default:
      return state
  }
}

/** Find (or append) the assistant message with `id` and transform its blocks. */
function withAssistant(
  state: TranscriptState,
  id: string,
  fn: (blocks: Block[]) => Block[]
): TranscriptState {
  let found = false
  const messages = state.messages.map((m) => {
    if (m.id === id && m.role === 'assistant') {
      found = true
      return { ...m, blocks: fn(m.blocks) }
    }
    return m
  })
  if (!found) messages.push({ id, role: 'assistant', blocks: fn([]) })
  return { ...state, messages }
}

function appendDelta(
  state: TranscriptState,
  id: string,
  kind: 'text' | 'thinking',
  index: number,
  delta: string
): TranscriptState {
  return withAssistant(state, id, (blocks) => {
    const i = blocks.findIndex(
      (b) => (b.kind === 'text' || b.kind === 'thinking') && b.kind === kind && b.index === index
    )
    if (i >= 0) {
      const b = blocks[i] as Extract<Block, { kind: 'text' | 'thinking' }>
      const copy = blocks.slice()
      copy[i] = { ...b, text: b.text + delta }
      return copy
    }
    return [...blocks, { kind, index, text: delta }]
  })
}

function addToolUse(
  state: TranscriptState,
  messageId: string,
  toolUseId: string,
  name: string,
  input: unknown
): TranscriptState {
  return withAssistant(state, messageId, (blocks) => {
    if (blocks.some((b) => b.kind === 'tool_use' && b.toolUseId === toolUseId)) return blocks
    return [...blocks, { kind: 'tool_use', toolUseId, name, input }]
  })
}

function setToolResult(
  state: TranscriptState,
  toolUseId: string,
  result: ToolResult
): TranscriptState {
  const messages = state.messages.map((m) => ({
    ...m,
    blocks: m.blocks.map((b) =>
      b.kind === 'tool_use' && b.toolUseId === toolUseId ? { ...b, result } : b
    )
  }))
  return { ...state, messages }
}
