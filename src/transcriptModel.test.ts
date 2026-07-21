import { describe, expect, it } from 'vitest'
import type { AgentEvent, UiStateSnapshot } from '@shared/events'
import { initialState, reduce, type TranscriptState } from './transcriptModel'

const snapshot = (over: Partial<UiStateSnapshot> = {}): UiStateSnapshot => ({
  status: 'working',
  statusSeq: 1,
  facts: { queued: 0, released: true, lastSdkEventAt: null },
  permissionMode: 'bypassPermissions',
  pending: [
    {
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      title: 'Bash',
      input: { command: 'ls' },
      canAllowAlways: false
    }
  ],
  questions: [],
  background: [],
  autoResumeAt: null,
  autoResumeEnabled: false,
  tokens: { output: 42, input: 7 },
  turnStartedAt: null,
  ...over
})

const ev = (state: TranscriptState, event: AgentEvent): TranscriptState =>
  reduce(state, { type: 'event', event })

describe('hydrate (mount-time resync to main)', () => {
  it('replaces live state (status, mode, pending, tokens) but keeps messages', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'hi' })
    s = reduce(s, { type: 'hydrate', snapshot: snapshot() })
    expect(s.status).toBe('working')
    expect(s.permissionMode).toBe('bypassPermissions')
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0].requestId).toBe('r1')
    expect(s.liveTokens).toEqual({ output: 42, input: 7 })
    expect(s.messages).toHaveLength(1) // transcript is hydrated separately
  })

  it('restores a pending approval a remount would otherwise have lost', () => {
    const s = reduce(initialState, { type: 'hydrate', snapshot: snapshot() })
    expect(s.pending[0].toolName).toBe('Bash')
    // ...and a later resolution event still clears it.
    const done = ev(s, { instanceId: 'i', kind: 'permission_resolved', requestId: 'r1' })
    expect(done.pending).toHaveLength(0)
  })

  it('does not duplicate a hydrated request when its push event also arrives', () => {
    let s = reduce(initialState, { type: 'hydrate', snapshot: snapshot() })
    s = ev(s, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      title: 'Bash',
      input: { command: 'ls' },
      canAllowAlways: false
    })
    expect(s.pending).toHaveLength(1)
  })

  it('hydrates an idle snapshot over a stale working display', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working', seq: 1 })
    s = reduce(s, {
      type: 'hydrate',
      snapshot: snapshot({ status: 'idle', statusSeq: 2, pending: [], tokens: { output: 0 } })
    })
    expect(s.status).toBe('idle')
    expect(s.pending).toHaveLength(0)
  })

  it('a stale snapshot cannot regress status (but still refreshes cards/tokens)', () => {
    // A resync captured just before the idle transition arrives after the idle push.
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'idle', seq: 5 })
    s = reduce(s, { type: 'hydrate', snapshot: snapshot({ status: 'working', statusSeq: 4 }) })
    expect(s.status).toBe('idle') // seq 4 < 5 — status untouched
    expect(s.pending).toHaveLength(1) // non-versioned live state still applied
  })

  it('carries the turn clock anchor and auto-resume flag from the snapshot', () => {
    const s = reduce(initialState, {
      type: 'hydrate',
      snapshot: snapshot({ turnStartedAt: 12345, autoResumeEnabled: true })
    })
    expect(s.turnStartedAt).toBe(12345)
    expect(s.autoResumeEnabled).toBe(true)
  })
})

describe('status seq gating (pushes and resyncs cannot race backwards)', () => {
  it('ignores a status push older than the last applied version', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'idle', seq: 3 })
    s = ev(s, { instanceId: 'i', kind: 'status', status: 'working', seq: 2 }) // stale
    expect(s.status).toBe('idle')
    expect(s.statusSeq).toBe(3)
  })

  it('applies equal-seq idempotently (a resync repeating the last push is harmless)', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working', seq: 2 })
    s = ev(s, { instanceId: 'i', kind: 'status', status: 'working', seq: 2 })
    expect(s.status).toBe('working')
  })
})

describe('turn clock (elapsed anchor survives remounts)', () => {
  it('anchors on the first transition to working and keeps it across repeats', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working', seq: 1 })
    expect(s.turnStartedAt).not.toBeNull()
    const anchor = s.turnStartedAt
    s = ev(s, { instanceId: 'i', kind: 'status', status: 'working', seq: 2 }) // same run
    expect(s.turnStartedAt).toBe(anchor)
  })

  it('clears the anchor when the run ends', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working', seq: 1 })
    s = ev(s, { instanceId: 'i', kind: 'status', status: 'idle', seq: 2 })
    expect(s.turnStartedAt).toBeNull()
  })

  it('set-auto-resume flips the flag', () => {
    const s = reduce(initialState, { type: 'set-auto-resume', enabled: true })
    expect(s.autoResumeEnabled).toBe(true)
  })
})

// ---- Expanded coverage ----

describe('initialState defaults', () => {
  it('has all expected zero-value fields', () => {
    expect(initialState.status).toBe('idle')
    expect(initialState.statusSeq).toBe(0)
    expect(initialState.messages).toEqual([])
    expect(initialState.pending).toEqual([])
    expect(initialState.questions).toEqual([])
    expect(initialState.errors).toEqual([])
    expect(initialState.background).toEqual([])
    expect(initialState.taskViews).toEqual({})
    expect(initialState.permissionMode).toBe('default')
    expect(initialState.forkPoints).toEqual({})
    expect(initialState.turnStartedAt).toBeNull()
    expect(initialState.autoResumeEnabled).toBe(false)
    expect(initialState.model).toBeUndefined()
    expect(initialState.effort).toBeUndefined()
  })
})

describe('system_init event', () => {
  it('records sessionId, model, apiKeySource, and tools without touching messages', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'system_init',
      sessionId: 'sess-1',
      model: 'claude-fable-5',
      apiKeySource: 'oauth',
      tools: ['Read', 'Write', 'Bash']
    })
    expect(s.sessionId).toBe('sess-1')
    expect(s.model).toBe('claude-fable-5')
    expect(s.apiKeySource).toBe('oauth')
    expect(s.tools).toEqual(['Read', 'Write', 'Bash'])
    expect(s.messages).toHaveLength(0)
  })

  it('overwrites previous system_init values (model can change between sessions)', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'system_init',
      sessionId: 'sess-1',
      model: 'old-model',
      apiKeySource: 'none',
      tools: []
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'system_init',
      sessionId: 'sess-2',
      model: 'new-model',
      apiKeySource: 'oauth',
      tools: ['Read']
    })
    expect(s.sessionId).toBe('sess-2')
    expect(s.model).toBe('new-model')
  })
})

describe('user action', () => {
  it('appends a user message with a text block at index 0', () => {
    const s = reduce(initialState, { type: 'user', id: 'u1', text: 'hello world' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ id: 'u1', role: 'user' })
    expect(s.messages[0].blocks[0]).toMatchObject({ kind: 'text', index: 0, text: 'hello world' })
  })

  it('resets liveTokens to zero (optimistic cost reset at send time)', () => {
    const s = reduce(initialState, { type: 'user', id: 'u1', text: 'ping' })
    expect(s.liveTokens).toEqual({ output: 0 })
  })

  it('accumulates multiple user messages in order', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'first' })
    s = reduce(s, { type: 'user', id: 'u2', text: 'second' })
    expect(s.messages).toHaveLength(2)
    expect(s.messages[1].id).toBe('u2')
  })

  it('preserves an empty string body', () => {
    const s = reduce(initialState, { type: 'user', id: 'u1', text: '' })
    const b = s.messages[0].blocks[0]
    expect(b.kind === 'text' && b.text).toBe('')
  })
})

describe('text delta streaming (appendDelta)', () => {
  it('creates a new assistant message on the first delta', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'text',
      messageId: 'm1',
      index: 0,
      delta: 'Hello'
    })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ id: 'm1', role: 'assistant' })
    expect(s.messages[0].blocks[0]).toMatchObject({ kind: 'text', index: 0, text: 'Hello' })
  })

  it('concatenates subsequent deltas onto the same text block', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'text',
      messageId: 'm1',
      index: 0,
      delta: 'Hello'
    })
    s = ev(s, { instanceId: 'i', kind: 'text', messageId: 'm1', index: 0, delta: ', world' })
    expect(s.messages[0].blocks[0]).toMatchObject({ kind: 'text', text: 'Hello, world' })
    expect(s.messages[0].blocks).toHaveLength(1) // no new block added
  })

  it('creates a separate block for a different index (interleaved blocks)', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'text',
      messageId: 'm1',
      index: 0,
      delta: 'A'
    })
    s = ev(s, { instanceId: 'i', kind: 'text', messageId: 'm1', index: 2, delta: 'B' })
    expect(s.messages[0].blocks).toHaveLength(2)
    expect(s.messages[0].blocks[0]).toMatchObject({ index: 0, text: 'A' })
    expect(s.messages[0].blocks[1]).toMatchObject({ index: 2, text: 'B' })
  })

  it('does not merge a text delta onto a thinking block at the same index', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'thinking',
      messageId: 'm1',
      index: 0,
      delta: 'thought'
    })
    s = ev(s, { instanceId: 'i', kind: 'text', messageId: 'm1', index: 0, delta: 'reply' })
    const kinds = s.messages[0].blocks.map((b) => b.kind)
    expect(kinds).toEqual(['thinking', 'text'])
  })

  it('reuses the existing assistant message rather than appending a new one', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'text',
      messageId: 'm1',
      index: 0,
      delta: 'x'
    })
    s = ev(s, { instanceId: 'i', kind: 'text', messageId: 'm1', index: 0, delta: 'y' })
    expect(s.messages).toHaveLength(1)
  })
})

describe('thinking delta streaming', () => {
  it('accumulates thinking deltas into a thinking block', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'thinking',
      messageId: 'm1',
      index: 0,
      delta: 'hmm'
    })
    s = ev(s, { instanceId: 'i', kind: 'thinking', messageId: 'm1', index: 0, delta: '...' })
    expect(s.messages[0].blocks[0]).toMatchObject({ kind: 'thinking', text: 'hmm...' })
  })

  it('does not merge a thinking delta onto a text block at the same index', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'text',
      messageId: 'm1',
      index: 0,
      delta: 'answer'
    })
    s = ev(s, { instanceId: 'i', kind: 'thinking', messageId: 'm1', index: 0, delta: 'reconsider' })
    const kinds = s.messages[0].blocks.map((b) => b.kind)
    expect(kinds).toEqual(['text', 'thinking'])
  })
})

describe('tool_use and tool_result events', () => {
  it('tool_use creates an assistant message with a tool_use block', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu1',
      name: 'Read',
      input: { file_path: '/foo.ts' }
    })
    const msg = s.messages[0]
    expect(msg.role).toBe('assistant')
    const b = msg.blocks[0]
    expect(b.kind).toBe('tool_use')
    if (b.kind === 'tool_use') {
      expect(b.toolUseId).toBe('tu1')
      expect(b.name).toBe('Read')
      expect(b.input).toEqual({ file_path: '/foo.ts' })
      expect(b.result).toBeUndefined()
    }
  })

  it('tool_use is idempotent — a duplicate event does not add a second block', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu1',
      name: 'Read',
      input: {}
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu1',
      name: 'Read',
      input: {}
    })
    expect(s.messages[0].blocks).toHaveLength(1)
  })

  it('tool_result attaches the ok result to the matching tool_use block', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu1',
      name: 'Read',
      input: {}
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'tool_result',
      toolUseId: 'tu1',
      ok: true,
      output: 'file contents'
    })
    const b = s.messages[0].blocks[0]
    if (b.kind === 'tool_use') {
      expect(b.result).toEqual({ ok: true, output: 'file contents' })
    }
  })

  it('tool_result with ok:false records an error result', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu1',
      name: 'Bash',
      input: { command: 'ls /nope' }
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'tool_result',
      toolUseId: 'tu1',
      ok: false,
      output: 'ls: /nope: No such file or directory'
    })
    const b = s.messages[0].blocks[0]
    if (b.kind === 'tool_use') {
      expect(b.result?.ok).toBe(false)
    }
  })

  it('tool_result for an unknown toolUseId is a no-op (no throw, no new messages)', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'tool_result',
      toolUseId: 'unknown',
      ok: true,
      output: 'x'
    })
    expect(s.messages).toHaveLength(0)
  })

  it('multiple tool uses in the same message each get their own block', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu1',
      name: 'Read',
      input: {}
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'tool_use',
      messageId: 'm1',
      toolUseId: 'tu2',
      name: 'Write',
      input: {}
    })
    expect(s.messages[0].blocks).toHaveLength(2)
    const ids = s.messages[0].blocks.map((b) => b.kind === 'tool_use' && b.toolUseId)
    expect(ids).toEqual(['tu1', 'tu2'])
  })
})

describe('result event', () => {
  it('stores cost and duration in lastResult', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'result',
      messageId: 'm1',
      costUsd: 0.0042,
      durationMs: 3200,
      isError: false
    })
    expect(s.lastResult).toEqual({ costUsd: 0.0042, durationMs: 3200, isError: false })
  })

  it('records an error turn (isError: true)', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'result',
      messageId: 'm1',
      isError: true
    })
    expect(s.lastResult?.isError).toBe(true)
  })

  it('handles omitted costUsd and durationMs gracefully', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'result',
      messageId: 'm1',
      isError: false
    })
    expect(s.lastResult?.costUsd).toBeUndefined()
    expect(s.lastResult?.durationMs).toBeUndefined()
  })
})

describe('tokens event', () => {
  it('updates liveTokens with both output and input', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'tokens', output: 100, input: 200 })
    expect(s.liveTokens).toEqual({ output: 100, input: 200 })
  })

  it('works with output-only (no input field)', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'tokens', output: 50 })
    expect(s.liveTokens?.output).toBe(50)
  })
})

describe('error event', () => {
  it('appends an error whose `after` equals the current message count', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'ping' })
    s = ev(s, { instanceId: 'i', kind: 'error', message: 'SDK error', detail: { code: 42 } })
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0].message).toBe('SDK error')
    expect(s.errors[0].detail).toEqual({ code: 42 })
    expect(s.errors[0].after).toBe(1)
  })

  it('accumulates multiple errors in order', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'error', message: 'err1' })
    s = ev(s, { instanceId: 'i', kind: 'error', message: 'err2' })
    expect(s.errors).toHaveLength(2)
    expect(s.errors[0].message).toBe('err1')
    expect(s.errors[1].message).toBe('err2')
  })

  it('assigns a unique id to each error', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'error', message: 'e' })
    s = ev(s, { instanceId: 'i', kind: 'error', message: 'e' })
    expect(s.errors[0].id).not.toBe(s.errors[1].id)
  })

  it('error with no detail stores undefined (not null)', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'error', message: 'bare error' })
    expect(s.errors[0].detail).toBeUndefined()
  })
})

describe('dismiss-error action', () => {
  it('removes the matching error by id', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'error', message: 'boom' })
    const id = s.errors[0].id
    const cleared = reduce(s, { type: 'dismiss-error', id })
    expect(cleared.errors).toHaveLength(0)
  })

  it('leaves other errors intact when dismissing one', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'error', message: 'e1' })
    s = ev(s, { instanceId: 'i', kind: 'error', message: 'e2' })
    const id = s.errors[0].id
    const trimmed = reduce(s, { type: 'dismiss-error', id })
    expect(trimmed.errors).toHaveLength(1)
    expect(trimmed.errors[0].message).toBe('e2')
  })

  it('is a no-op for an unknown id', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'error', message: 'oops' })
    const same = reduce(s, { type: 'dismiss-error', id: 'no-such-id' })
    expect(same.errors).toHaveLength(1)
  })
})

describe('permission_request and permission_resolved events', () => {
  it('adds a pending request from a push event', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'req1',
      toolUseId: 'tu1',
      toolName: 'Write',
      title: 'Write file',
      input: { file_path: '/x' },
      canAllowAlways: true
    })
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0].requestId).toBe('req1')
    expect(s.pending[0].canAllowAlways).toBe(true)
  })

  it('permission_resolved (event) removes the matching request', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'req1',
      toolUseId: 'tu1',
      toolName: 'Write',
      title: 'Write',
      input: {},
      canAllowAlways: false
    })
    s = ev(s, { instanceId: 'i', kind: 'permission_resolved', requestId: 'req1' })
    expect(s.pending).toHaveLength(0)
  })

  it('resolve-permission action removes the request', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'req2',
      toolUseId: 'tu2',
      toolName: 'Bash',
      title: 'Bash',
      input: {},
      canAllowAlways: false
    })
    s = reduce(s, { type: 'resolve-permission', requestId: 'req2' })
    expect(s.pending).toHaveLength(0)
  })

  it('resolving an unknown requestId is a no-op', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'permission_resolved', requestId: 'nope' })
    expect(s.pending).toHaveLength(0)
  })

  it('multiple requests accumulate and can be resolved independently', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'A',
      toolUseId: 'tu1',
      toolName: 'Write',
      title: 'W',
      input: {},
      canAllowAlways: false
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'B',
      toolUseId: 'tu2',
      toolName: 'Bash',
      title: 'B',
      input: {},
      canAllowAlways: false
    })
    expect(s.pending).toHaveLength(2)
    s = ev(s, { instanceId: 'i', kind: 'permission_resolved', requestId: 'A' })
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0].requestId).toBe('B')
  })
})

describe('question_request and question_resolved events', () => {
  const qEvent = (): AgentEvent => ({
    instanceId: 'i',
    kind: 'question_request',
    requestId: 'qr1',
    toolUseId: 'tu1',
    questions: [
      {
        question: 'Which approach?',
        header: 'Choose',
        options: [{ label: 'A', description: 'Option A' }],
        multiSelect: false
      }
    ]
  })

  it('adds a pending question from a push event', () => {
    const s = ev(initialState, qEvent())
    expect(s.questions).toHaveLength(1)
    expect(s.questions[0].requestId).toBe('qr1')
  })

  it('does not duplicate a question if the same push arrives twice', () => {
    let s = ev(initialState, qEvent())
    s = ev(s, qEvent())
    expect(s.questions).toHaveLength(1)
  })

  it('question_resolved (event) removes the matching question', () => {
    let s = ev(initialState, qEvent())
    s = ev(s, { instanceId: 'i', kind: 'question_resolved', requestId: 'qr1' })
    expect(s.questions).toHaveLength(0)
  })

  it('resolve-question action removes the question', () => {
    let s = ev(initialState, qEvent())
    s = reduce(s, { type: 'resolve-question', requestId: 'qr1' })
    expect(s.questions).toHaveLength(0)
  })
})

describe('permission_mode event', () => {
  it('updates the permission mode', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'permission_mode', mode: 'acceptEdits' })
    expect(s.permissionMode).toBe('acceptEdits')
  })

  it('cycles through every valid mode', () => {
    const modes = [
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'dontAsk',
      'auto'
    ] as const
    for (const mode of modes) {
      const s = ev(initialState, { instanceId: 'i', kind: 'permission_mode', mode })
      expect(s.permissionMode).toBe(mode)
    }
  })
})

describe('auto_resume event', () => {
  it('stores the reset epoch-ms when a limit fires', () => {
    const s = ev(initialState, { instanceId: 'i', kind: 'auto_resume', resetsAt: 9999 })
    expect(s.autoResumeAt).toBe(9999)
  })

  it('clears autoResumeAt when resetsAt is null (fired or cancelled)', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'auto_resume', resetsAt: 1000 })
    s = ev(s, { instanceId: 'i', kind: 'auto_resume', resetsAt: null })
    expect(s.autoResumeAt).toBeNull()
  })
})

describe('background event', () => {
  it('replaces the full background task list (snapshot, not append)', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'background',
      tasks: [{ id: 'task1', kind: 'subagent', label: 'Subagent 1', startedAt: 100 }]
    })
    expect(s.background).toHaveLength(1)
    s = ev(s, { instanceId: 'i', kind: 'background', tasks: [] })
    expect(s.background).toHaveLength(0)
  })
})

describe('task_activity event', () => {
  it('appends items to the task view for the given taskId', () => {
    const s = ev(initialState, {
      instanceId: 'i',
      kind: 'task_activity',
      taskId: 'task1',
      item: { kind: 'text', text: 'Running...' }
    })
    expect(s.taskViews['task1']).toHaveLength(1)
    expect(s.taskViews['task1'][0]).toMatchObject({ kind: 'text', text: 'Running...' })
  })

  it('accumulates items for the same taskId in order', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'task_activity',
      taskId: 'task1',
      item: { kind: 'text', text: 'step 1' }
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'task_activity',
      taskId: 'task1',
      item: { kind: 'text', text: 'step 2' }
    })
    expect(s.taskViews['task1']).toHaveLength(2)
    expect((s.taskViews['task1'][1] as { kind: string; text: string }).text).toBe('step 2')
  })

  it('isolates different taskIds from each other', () => {
    let s = ev(initialState, {
      instanceId: 'i',
      kind: 'task_activity',
      taskId: 'A',
      item: { kind: 'text', text: 'a1' }
    })
    s = ev(s, {
      instanceId: 'i',
      kind: 'task_activity',
      taskId: 'B',
      item: { kind: 'text', text: 'b1' }
    })
    expect(s.taskViews['A']).toHaveLength(1)
    expect(s.taskViews['B']).toHaveLength(1)
  })

  it('caps each task buffer at 500 entries (drops the oldest)', () => {
    let s = initialState
    for (let i = 0; i <= 500; i++) {
      s = ev(s, {
        instanceId: 'i',
        kind: 'task_activity',
        taskId: 'big',
        item: { kind: 'text', text: `msg ${i}` }
      })
    }
    const items = s.taskViews['big']
    expect(items.length).toBe(500)
    // The very first message (msg 0) is evicted; last item should be msg 500.
    const firstText = (items[0] as { kind: string; text: string }).text
    const lastText = (items[499] as { kind: string; text: string }).text
    expect(firstText).toBe('msg 1')
    expect(lastText).toBe('msg 500')
  })
})

describe('transcript action (canonical reconciliation)', () => {
  it('replaces live streamed messages with the authoritative transcript', () => {
    let s = reduce(initialState, { type: 'user', id: 'temp1', text: 'hi' })
    s = reduce(s, {
      type: 'transcript',
      messages: [
        { uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'hi' }] },
        {
          uuid: 'a1',
          role: 'assistant',
          blocks: [
            { kind: 'text', text: 'hello' },
            {
              kind: 'tool_use',
              toolUseId: 'tu1',
              name: 'Read',
              input: {},
              result: { ok: true, output: 'x' }
            }
          ]
        }
      ]
    })
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0].id).toBe('u1')
    expect(s.messages[1].id).toBe('a1')
    const b = s.messages[1].blocks[1]
    if (b.kind === 'tool_use') {
      expect(b.result?.ok).toBe(true)
    }
  })

  it('maps thinking blocks to the right kind', () => {
    const s = reduce(initialState, {
      type: 'transcript',
      messages: [
        { uuid: 'a1', role: 'assistant', blocks: [{ kind: 'thinking', text: 'pondering' }] }
      ]
    })
    expect(s.messages[0].blocks[0]).toMatchObject({ kind: 'thinking', text: 'pondering' })
  })

  it('clears messages when the transcript is empty', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'x' })
    s = reduce(s, { type: 'transcript', messages: [] })
    expect(s.messages).toHaveLength(0)
  })

  it('preserves tool_use result from the transcript', () => {
    const s = reduce(initialState, {
      type: 'transcript',
      messages: [
        {
          uuid: 'a1',
          role: 'assistant',
          blocks: [
            {
              kind: 'tool_use',
              toolUseId: 'tu1',
              name: 'Bash',
              input: { command: 'echo hi' },
              result: { ok: false, output: 'error' }
            }
          ]
        }
      ]
    })
    const b = s.messages[0].blocks[0]
    if (b.kind === 'tool_use') {
      expect(b.result).toEqual({ ok: false, output: 'error' })
    }
  })
})

describe('fork-points action', () => {
  it('replaces the forkPoints map', () => {
    const s = reduce(initialState, {
      type: 'fork-points',
      forkPoints: { 'uuid-x': { versions: ['sess-a', 'sess-b'], index: 1 } }
    })
    expect(s.forkPoints['uuid-x']).toEqual({ versions: ['sess-a', 'sess-b'], index: 1 })
  })

  it('an empty map clears previous fork points', () => {
    let s = reduce(initialState, {
      type: 'fork-points',
      forkPoints: { x: { versions: ['a', 'b'], index: 0 } }
    })
    s = reduce(s, { type: 'fork-points', forkPoints: {} })
    expect(s.forkPoints).toEqual({})
  })
})

describe('fork-local action', () => {
  it('truncates messages before the forked message and inserts the edited user message', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'original' })
    s = ev(s, {
      instanceId: 'i',
      kind: 'text',
      messageId: 'a1',
      index: 0,
      delta: 'assistant reply'
    })
    expect(s.messages).toHaveLength(2)

    s = reduce(s, { type: 'fork-local', uuid: 'u1', tempId: 'temp-fork', newText: 'revised' })
    // head = messages before index 0 (empty) → only the temp msg
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].id).toBe('temp-fork')
    expect(s.messages[0].role).toBe('user')
    const b = s.messages[0].blocks[0]
    expect(b.kind === 'text' && b.text).toBe('revised')
  })

  it('transitions to working and resets liveTokens', () => {
    const s = reduce(initialState, {
      type: 'fork-local',
      uuid: 'no-match',
      tempId: 'tmp',
      newText: 'x'
    })
    expect(s.status).toBe('working')
    expect(s.liveTokens).toEqual({ output: 0 })
  })

  it('always includes the temp user message even when the uuid is not found', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'hi' })
    s = reduce(s, { type: 'fork-local', uuid: 'nonexistent', tempId: 'tmp', newText: 'text' })
    expect(s.messages.find((m) => m.id === 'tmp')).toBeDefined()
  })
})

describe('set-model and set-effort actions', () => {
  it('set-model updates the model field', () => {
    const s = reduce(initialState, { type: 'set-model', model: 'claude-opus-4-8' })
    expect(s.model).toBe('claude-opus-4-8')
  })

  it('set-effort updates the effort field', () => {
    const s = reduce(initialState, { type: 'set-effort', effort: 'high' })
    expect(s.effort).toBe('high')
  })

  it('set-effort accepts every valid level', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
    for (const effort of levels) {
      expect(reduce(initialState, { type: 'set-effort', effort }).effort).toBe(effort)
    }
  })
})
