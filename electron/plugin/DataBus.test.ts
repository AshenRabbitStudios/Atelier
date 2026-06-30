import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DataBus,
  createFileSource,
  FILE_PREFIX,
  type DataMessage,
  type DataSource,
  type SourceHandle
} from './DataBus.js'

const CONV = 'conv-1'

/** A controllable source: captures its `emit` so a test can push values on demand. */
function fakeSource(prefix: string): {
  source: DataSource
  emit: (data: unknown) => void
  closed: () => number
} {
  let emitFn: ((data: unknown) => void) | null = null
  let closeCount = 0
  const source: DataSource = {
    owns: (channel) => channel.startsWith(prefix),
    open: (_channel, _conv, emit) => {
      emitFn = emit
      const handle: SourceHandle = {
        close: () => {
          closeCount++
        }
      }
      return handle
    }
  }
  return {
    source,
    emit: (data) => emitFn?.(data),
    closed: () => closeCount
  }
}

const waitFor = async (pred: () => boolean, ms = 500): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('DataBus', () => {
  it('fans a published value out to every subscriber of the channel', () => {
    const sink = vi.fn<(m: DataMessage) => void>()
    const bus = new DataBus(sink)
    void bus.subscribe(CONV, 'plugin-a', 'topic:x')
    void bus.subscribe(CONV, 'plugin-b', 'topic:x')

    bus.publish(CONV, 'topic:x', { n: 1 })

    expect(sink).toHaveBeenCalledTimes(2)
    const targets = sink.mock.calls.map((c) => c[0].pluginId).sort()
    expect(targets).toEqual(['plugin-a', 'plugin-b'])
    expect(sink.mock.calls[0][0].data).toEqual({ n: 1 })
  })

  it('does not leak across conversations or channels', () => {
    const sink = vi.fn<(m: DataMessage) => void>()
    const bus = new DataBus(sink)
    void bus.subscribe(CONV, 'plugin-a', 'topic:x')
    void bus.subscribe('conv-2', 'plugin-b', 'topic:x')

    bus.publish(CONV, 'topic:x', 1)
    bus.publish(CONV, 'topic:y', 2) // no subscribers

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0].conversationId).toBe(CONV)
  })

  it('replays the current value to a late joiner', () => {
    const sink = vi.fn<(m: DataMessage) => void>()
    const bus = new DataBus(sink)
    void bus.subscribe(CONV, 'plugin-a', 'topic:x')
    bus.publish(CONV, 'topic:x', 'hello')
    sink.mockClear()

    void bus.subscribe(CONV, 'plugin-b', 'topic:x')

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toMatchObject({ pluginId: 'plugin-b', data: 'hello' })
  })

  it('opens the source on the first subscriber and closes it on the last', async () => {
    const fake = fakeSource('topic:')
    const sink = vi.fn<(m: DataMessage) => void>()
    const bus = new DataBus(sink, [fake.source])

    await bus.subscribe(CONV, 'plugin-a', 'topic:x')
    await bus.subscribe(CONV, 'plugin-b', 'topic:x')
    fake.emit('from-source')
    expect(sink).toHaveBeenCalledTimes(2)

    bus.unsubscribe(CONV, 'plugin-a', 'topic:x')
    expect(fake.closed()).toBe(0) // still one subscriber
    bus.unsubscribe(CONV, 'plugin-b', 'topic:x')
    expect(fake.closed()).toBe(1) // last one left → source closed
  })

  it('dropConversation closes all of a conversation’s channels', async () => {
    const fake = fakeSource('topic:')
    const bus = new DataBus(vi.fn(), [fake.source])
    await bus.subscribe(CONV, 'plugin-a', 'topic:x')
    bus.dropConversation(CONV)
    expect(fake.closed()).toBe(1)
  })

  it('surfaces a source that rejects the subscription (and rolls it back)', async () => {
    const bad: DataSource = {
      owns: () => true,
      open: () => {
        throw new Error('nope')
      }
    }
    const sink = vi.fn()
    const bus = new DataBus(sink, [bad])
    await expect(bus.subscribe(CONV, 'plugin-a', 'topic:x')).rejects.toThrow('nope')
    // Rolled back: a later publish reaches no one.
    bus.publish(CONV, 'topic:x', 1)
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('createFileSource', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-databus-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits the file contents on subscribe', async () => {
    writeFileSync(join(dir, 'note.md'), 'hello world')
    const source = createFileSource((_c, rel) => join(dir, rel))
    const sink = vi.fn<(m: DataMessage) => void>()
    const bus = new DataBus(sink, [source])

    await bus.subscribe(CONV, 'plugin-a', FILE_PREFIX + 'note.md')
    await waitFor(() => sink.mock.calls.length > 0)
    expect(sink.mock.calls[0][0].data).toBe('hello world')
    bus.dropConversation(CONV) // close the fs watcher before the temp dir is removed
  })

  it('rejects a channel whose path escapes the conversation folder', async () => {
    const source = createFileSource(() => null) // resolver denies everything (out of bounds)
    const bus = new DataBus(vi.fn(), [source])
    await expect(bus.subscribe(CONV, 'plugin-a', FILE_PREFIX + '../secret')).rejects.toThrow(
      /outside the conversation folder/
    )
  })
})
