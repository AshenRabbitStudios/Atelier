import { initialState, reduce, type Action, type TranscriptState } from '../transcriptModel'

/**
 * Per-conversation view state that lives OUTSIDE the React tree, so visible and hidden
 * conversations function identically. Dockview disposes a conversation's panels on tab switch;
 * anything held in component state dies with them — which is how streamed deltas went missing,
 * the elapsed clock restarted, and composer drafts vanished. Here, one app-level event
 * subscription reduces every AgentEvent into its conversation's store whether or not a panel is
 * mounted; panels are pure views that subscribe (useSyncExternalStore) and render.
 *
 * Ownership hierarchy: main process = durable truth (uiState snapshot + on-disk transcript) →
 * this store = live working copy → components = disposable views.
 */

/** Reactive view preferences (low-frequency: open/close/select). Changing these re-renders the
 *  panel — high-frequency state (composer draft, scroll) is write-through instead, below. */
export interface ViewState {
  visibleCount: number
  viewTask: string | null
  showBackground: boolean
  editing: { id: string; draft: string } | null
}

// Render only the last N messages by default; "Show earlier" raises it. Keeps a huge transcript
// from blocking the main thread (markdown + Shiki tokenize synchronously per block).
export const VISIBLE_DEFAULT = 60

const initialView: ViewState = {
  visibleCount: VISIBLE_DEFAULT,
  viewTask: null,
  showBackground: false,
  editing: null
}

export class ConversationViewStore {
  private transcript: TranscriptState = initialState
  private view: ViewState = initialView
  private transcriptListeners = new Set<() => void>()
  private viewListeners = new Set<() => void>()
  // Generation guard: a canonical load that resolves after a newer one (or after reset) is
  // dropped, so stale messages can't repopulate a just-cleared chat.
  private loadGen = 0

  // Write-through fields: persisted across panel remounts but deliberately NOT reactive —
  // a keystroke or scroll tick must never re-render the (potentially huge) transcript.
  /** The composer's unsent draft text. */
  draft = ''
  /** Whether the user is at (or near) the transcript tail (tail-pinning). */
  scrollAtBottom = true
  /** Last scrollTop, restored on remount when the user was NOT tail-pinned. */
  scrollTop = 0

  constructor(private readonly instanceId: string) {}

  getTranscript = (): TranscriptState => this.transcript
  getView = (): ViewState => this.view

  subscribeTranscript = (fn: () => void): (() => void) => {
    this.transcriptListeners.add(fn)
    return () => {
      this.transcriptListeners.delete(fn)
    }
  }

  subscribeView = (fn: () => void): (() => void) => {
    this.viewListeners.add(fn)
    return () => {
      this.viewListeners.delete(fn)
    }
  }

  dispatch = (action: Action): void => {
    this.transcript = reduce(this.transcript, action)
    for (const fn of this.transcriptListeners) fn()
    // After each completed turn, reconcile to the on-disk transcript so messages carry real
    // uuids (needed for edit/fork) and tool results are fully paired. Store-level, so it
    // happens even while this conversation's panel is hidden.
    if (action.type === 'event' && action.event.kind === 'result') {
      setTimeout(() => void this.loadCanonical(), 150)
    }
  }

  setView = (patch: Partial<ViewState>): void => {
    this.view = { ...this.view, ...patch }
    for (const fn of this.viewListeners) fn()
  }

  /** Load the authoritative transcript (with on-disk uuids) + fork points. Gen-guarded. */
  loadCanonical = async (): Promise<void> => {
    const gen = ++this.loadGen
    // Independent so a transcript failure can't also drop the fork-point update.
    try {
      const messages = await window.atelier.agent.transcript(this.instanceId)
      if (gen === this.loadGen) this.dispatch({ type: 'transcript', messages })
    } catch {
      /* transcript not available yet */
    }
    try {
      const forkPoints = await window.atelier.agent.forkPoints(this.instanceId)
      if (gen === this.loadGen) this.dispatch({ type: 'fork-points', forkPoints })
    } catch {
      /* fork points not available yet */
    }
  }

  /** Initial sync with main's authoritative live state (also heals a renderer crash-reload). */
  hydrate = (): void => {
    void window.atelier.agent
      .uiState(this.instanceId)
      .then((s) => this.dispatch({ type: 'hydrate', snapshot: s }))
      .catch(() => {})
    void this.loadCanonical()
  }

  /** Clear-chat: drop to the empty state and re-sync (the fresh session's transcript is empty). */
  reset = (): void => {
    this.loadGen++ // invalidate any in-flight canonical load
    this.transcript = initialState
    for (const fn of this.transcriptListeners) fn()
    this.setView({ viewTask: null, editing: null, visibleCount: VISIBLE_DEFAULT })
    this.hydrate()
  }
}

const stores = new Map<string, ConversationViewStore>()
let wired = false

/**
 * The single app-level event subscription: every AgentEvent reduces into its conversation's
 * store immediately, mounted panel or not. Routes only to EXISTING stores — App eagerly creates
 * one per open conversation (and ChatPanel ensures one on mount), while events for
 * closed/dropped conversations fall through harmlessly instead of resurrecting zombie stores.
 */
function wire(): void {
  if (wired) return
  wired = true
  window.atelier.agent.onEvent((e) => {
    stores.get(e.instanceId)?.dispatch({ type: 'event', event: e })
  })
}

/** The store for a conversation, created (and hydrated from main) on first use. */
export function storeFor(instanceId: string): ConversationViewStore {
  wire()
  let s = stores.get(instanceId)
  if (!s) {
    s = new ConversationViewStore(instanceId)
    stores.set(instanceId, s) // registered BEFORE hydrate so routed events apply on top
    s.hydrate()
  }
  return s
}

/** Drop a conversation's store (close/delete — its live session is gone). */
export function dropStore(instanceId: string): void {
  stores.delete(instanceId)
}

/** Drop everything (test isolation). */
export function dropAllStores(): void {
  stores.clear()
}
