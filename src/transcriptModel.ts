import type {
  AgentEvent,
  AgentStatus,
  EffortLevel,
  ForkPoints,
  PermissionMode,
  PermissionRequest,
  QuestionRequest,
  TranscriptBlock,
  TranscriptMessage
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
  autoResumeAt?: number | null // epoch-ms a usage limit resets when auto-resume is armed (else null)
  errors: AgentError[]
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
  tools: [],
  pending: [],
  questions: [],
  permissionMode: 'default',
  forkPoints: {},
  errors: []
}

export type Action =
  | { type: 'event'; event: AgentEvent }
  | { type: 'user'; id: string; text: string }
  | { type: 'resolve-permission'; requestId: string }
  | { type: 'resolve-question'; requestId: string }
  | { type: 'set-model'; model: string }
  | { type: 'set-effort'; effort: EffortLevel }
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
  if (action.type === 'set-model') {
    return { ...state, model: action.model }
  }
  if (action.type === 'set-effort') {
    return { ...state, effort: action.effort }
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
    return { ...state, messages: [...head, userMsg], status: 'working', liveTokens: { output: 0 } }
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
      return { ...state, status: e.status }
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
