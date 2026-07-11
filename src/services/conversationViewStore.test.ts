import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, UiStateSnapshot } from '@shared/events'

const snapshot = (over: Partial<UiStateSnapshot> = {}): UiStateSnapshot => ({
  status: 'idle',
  permissionMode: 'default',
  pending: [],
  questions: [],
  background: [],
  autoResumeAt: null,
  autoResumeEnabled: false,
  tokens: { output: 0 },
  turnStartedAt: null,
  ...over
})

// The store reads window.atelier lazily; stub it BEFORE importing the module so wire()
// captures our fake onEvent. `routeEvent` is what main's push becomes in these tests.
let routeEvent: ((e: AgentEvent) => void) | null = null
const uiState = vi.fn(async () => snapshot())
const transcript = vi.fn(async () => [])
const forkPoints = vi.fn(async () => ({}))
;(globalThis as unknown as { window: unknown }).window = {
  atelier: {
    agent: {
      onEvent: (cb: (e: AgentEvent) => void) => {
        routeEvent = cb
        return () => {}
      },
      uiState,
      transcript,
      forkPoints
    }
  }
}

const { storeFor, dropStore, dropAllStores } = await import('./conversationViewStore')

const statusEvent = (instanceId: string, status: 'working' | 'idle'): AgentEvent => ({
  instanceId,
  kind: 'status',
  status
})

beforeEach(() => {
  dropAllStores()
  uiState.mockClear()
  transcript.mockClear()
})

describe('conversationViewStore', () => {
  it('returns the same store per conversation and hydrates it once on creation', async () => {
    const a = storeFor('a')
    expect(storeFor('a')).toBe(a)
    await vi.waitFor(() => expect(uiState).toHaveBeenCalledTimes(1))
  })

  it('routes events into the store whether or not any panel is subscribed', () => {
    const a = storeFor('a')
    routeEvent!(statusEvent('a', 'working'))
    expect(a.getTranscript().status).toBe('working')
    expect(a.getTranscript().turnStartedAt).not.toBeNull()
  })

  it('accumulates streamed deltas while "hidden" (no subscribers at all)', () => {
    const a = storeFor('a')
    routeEvent!({ instanceId: 'a', kind: 'text', messageId: 'm1', index: 0, delta: 'hel' })
    routeEvent!({ instanceId: 'a', kind: 'text', messageId: 'm1', index: 0, delta: 'lo' })
    const msg = a.getTranscript().messages.find((m) => m.id === 'm1')
    expect(msg?.blocks[0]).toMatchObject({ kind: 'text', text: 'hello' })
  })

  it('ignores events for conversations without a store (closed/dropped)', () => {
    const a = storeFor('a')
    dropStore('a')
    routeEvent!(statusEvent('a', 'working'))
    // A later reopen gets a FRESH store, not the dropped one with stale state.
    expect(storeFor('a')).not.toBe(a)
  })

  it('notifies transcript and view subscribers independently (slice isolation)', () => {
    const a = storeFor('a')
    const onTranscript = vi.fn()
    const onView = vi.fn()
    a.subscribeTranscript(onTranscript)
    a.subscribeView(onView)
    a.dispatch({ type: 'user', id: 'u1', text: 'hi' })
    expect(onTranscript).toHaveBeenCalledTimes(1)
    expect(onView).not.toHaveBeenCalled()
    a.setView({ showBackground: true })
    expect(onView).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledTimes(1)
    expect(a.getView().showBackground).toBe(true)
  })

  it('unsubscribe stops notifications', () => {
    const a = storeFor('a')
    const fn = vi.fn()
    const off = a.subscribeTranscript(fn)
    off()
    a.dispatch({ type: 'user', id: 'u1', text: 'hi' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('write-through fields (draft/scroll) persist on the store across "remounts"', () => {
    const a = storeFor('a')
    a.draft = 'half-typed message'
    a.scrollAtBottom = false
    a.scrollTop = 420
    // A remount re-fetches the same store instance — nothing was lost with the panel.
    const again = storeFor('a')
    expect(again.draft).toBe('half-typed message')
    expect(again.scrollAtBottom).toBe(false)
    expect(again.scrollTop).toBe(420)
  })

  it('reset clears the transcript and re-hydrates (clear chat)', async () => {
    const a = storeFor('a')
    a.dispatch({ type: 'user', id: 'u1', text: 'hi' })
    a.setView({ viewTask: 't1', editing: { id: 'u1', draft: 'x' } })
    a.reset()
    expect(a.getTranscript().messages).toHaveLength(0)
    expect(a.getView().viewTask).toBeNull()
    expect(a.getView().editing).toBeNull()
    await vi.waitFor(() => expect(uiState).toHaveBeenCalledTimes(2)) // creation + reset
  })

  it('reconciles to the on-disk transcript after a result event', async () => {
    const a = storeFor('a')
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledTimes(1)) // creation hydrate
    a.dispatch({
      type: 'event',
      event: { instanceId: 'a', kind: 'result', messageId: 'm1', isError: false }
    })
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledTimes(2))
  })
})
