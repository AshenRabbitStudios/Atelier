import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'

// The DataBus (ROADMAP P4): a per-conversation pub/sub fabric between plugins and ambient
// "sources" that live in main. A plugin subscribes to a named channel; main fans every value
// published on that channel out to the channel's subscribers (tagged with the target pluginId so
// the renderer routes each to the right pane). Built-in sources (e.g. files) lazily start on the
// channel's first subscriber and stop on its last — so nothing is watched unless a pane is looking.
//
// This is the same main→pane push shape the context system uses (context:changed); it is the
// *bounded* capability that lets a sandboxed plugin observe the outside world without ever
// touching fs/IPC directly (architecture invariant #3).

const SEP = '\u0000' // conversationId/channel separator — neither value contains a NUL
const keyOf = (conversationId: string, channel: string): string => conversationId + SEP + channel

/** One message delivered to a single subscribing pane. */
export interface DataMessage {
  conversationId: string
  pluginId: string
  channel: string
  data: unknown
}

export type DataSink = (msg: DataMessage) => void

/** A live producer for a channel; closed when the channel loses its last subscriber. */
export interface SourceHandle {
  close(): void
}

/**
 * A provider of channel data. `owns` claims a channel namespace (by prefix); `open` starts
 * producing for one (conversation, channel) and pushes each value through `emit`. May throw to
 * reject the subscription (e.g. a file path that escapes the conversation folder).
 */
export interface DataSource {
  owns(channel: string): boolean
  open(
    channel: string,
    conversationId: string,
    emit: (data: unknown) => void
  ): SourceHandle | Promise<SourceHandle>
}

export class DataBus {
  private subs = new Map<string, Set<string>>() // (conv,channel) -> subscribing pluginIds
  private handles = new Map<string, SourceHandle>() // (conv,channel) -> open source
  private last = new Map<string, unknown>() // (conv,channel) -> last value (replayed to late joiners)

  constructor(
    private sink: DataSink,
    private sources: DataSource[] = []
  ) {}

  /** Subscribe a plugin to a channel. Opens the backing source on the channel's first subscriber. */
  async subscribe(conversationId: string, pluginId: string, channel: string): Promise<void> {
    const k = keyOf(conversationId, channel)
    let set = this.subs.get(k)
    const firstForChannel = !set || set.size === 0
    if (!set) {
      set = new Set()
      this.subs.set(k, set)
    }
    set.add(pluginId)

    if (firstForChannel) {
      const source = this.sources.find((s) => s.owns(channel))
      if (source) {
        try {
          const handle = await source.open(channel, conversationId, (data) =>
            this.emit(conversationId, channel, data)
          )
          this.handles.set(k, handle)
        } catch (err) {
          // open() rejected (bad path, etc.) — roll the subscription back and surface the error.
          set.delete(pluginId)
          if (set.size === 0) this.subs.delete(k)
          throw err
        }
      }
    } else if (this.last.has(k)) {
      // A late joiner gets the channel's current value immediately, not only on the next change.
      this.sink({ conversationId, pluginId, channel, data: this.last.get(k) })
    }
  }

  /** Remove one subscriber; closes the backing source when the channel goes quiet. */
  unsubscribe(conversationId: string, pluginId: string, channel: string): void {
    const k = keyOf(conversationId, channel)
    const set = this.subs.get(k)
    if (!set) return
    set.delete(pluginId)
    if (set.size === 0) this.closeChannel(k)
  }

  /** A plugin publishes onto a channel; fans out to every subscriber of that channel. */
  publish(conversationId: string, channel: string, data: unknown): void {
    this.emit(conversationId, channel, data)
  }

  /** Tear down every channel for a conversation (e.g. when it closes) — releases watchers. */
  dropConversation(conversationId: string): void {
    const prefix = conversationId + SEP
    for (const k of [...this.subs.keys()]) {
      if (k.startsWith(prefix)) this.closeChannel(k)
    }
  }

  private closeChannel(k: string): void {
    this.handles.get(k)?.close()
    this.handles.delete(k)
    this.subs.delete(k)
    this.last.delete(k)
  }

  private emit(conversationId: string, channel: string, data: unknown): void {
    const k = keyOf(conversationId, channel)
    this.last.set(k, data)
    const set = this.subs.get(k)
    if (!set) return
    for (const pluginId of set) this.sink({ conversationId, pluginId, channel, data })
  }
}

// ---- Built-in source: files ----

export const FILE_PREFIX = 'file:'

/**
 * A source that tails a text file. The channel is `file:<relpath>`; `resolvePath` maps it to an
 * absolute path scoped to the conversation (returns null if it escapes the folder — the only place
 * a plugin's reach into the filesystem is bounded). Emits the full file contents on open and on
 * every change (debounced); a read/watch failure emits `{ error }` rather than throwing.
 */
export function createFileSource(
  resolvePath: (conversationId: string, rel: string) => string | null
): DataSource {
  return {
    owns: (channel) => channel.startsWith(FILE_PREFIX),
    open: (channel, conversationId, emit) => {
      const rel = channel.slice(FILE_PREFIX.length)
      const abs = resolvePath(conversationId, rel)
      if (!abs) throw new Error(`file channel "${rel}" is outside the conversation folder`)

      let closed = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let watcher: FSWatcher | null = null

      const push = async (): Promise<void> => {
        try {
          const text = await readFile(abs, 'utf8')
          if (!closed) emit(text)
        } catch (err) {
          if (!closed) emit({ error: err instanceof Error ? err.message : String(err) })
        }
      }

      void push() // initial contents
      try {
        watcher = watch(abs, () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => void push(), 50) // editors fire several events per save
        })
      } catch {
        // File doesn't exist yet (or can't be watched) — the initial push already emitted the error.
      }

      return {
        close: () => {
          closed = true
          if (timer) clearTimeout(timer)
          watcher?.close()
        }
      }
    }
  }
}
