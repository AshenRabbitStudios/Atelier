import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { TranscriptBlock, TranscriptMessage } from '../shared/events.js'

// Claude Code stores one JSONL file per session under ~/.claude/projects/<slug>/.
// We locate by filename (robust to the slug derivation) and cache the hit.
const fileCache = new Map<string, string>()

export function sessionFilePath(sessionId: string): string | null {
  const cached = fileCache.get(sessionId)
  if (cached && existsSync(cached)) return cached
  const root = join(homedir(), '.claude', 'projects')
  const found = findFile(root, `${sessionId}.jsonl`, 0)
  if (found) fileCache.set(sessionId, found)
  return found
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth > 6) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const p = join(dir, entry)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      const hit = findFile(p, name, depth + 1)
      if (hit) return hit
    } else if (entry === name) {
      return p
    }
  }
  return null
}

interface RawLine {
  type?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  message?: { role?: string; content?: unknown }
}

/** The parentUuid of the message with the given uuid (for forking just before it). */
export function parentUuidOf(sessionId: string, uuid: string): string | null {
  const file = sessionFilePath(sessionId)
  if (!file) return null
  for (const line of parseLines(file)) {
    if (line.uuid === uuid) return line.parentUuid ?? null
  }
  return null
}

/**
 * The uuid of the (unique) message whose parent is `anchor` in this branch — i.e.
 * the divergence message for a fork anchored just above it. `anchor` null = root.
 */
export function childUuidOf(sessionId: string, anchor: string | null): string | null {
  const file = sessionFilePath(sessionId)
  if (!file) return null
  for (const line of parseLines(file)) {
    if (!line.uuid) continue
    if ((line.parentUuid ?? null) === anchor) return line.uuid
  }
  return null
}

interface RawBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function parseLines(file: string): RawLine[] {
  const raw = readFileSync(file, 'utf8')
  const out: RawLine[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as RawLine)
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

/**
 * Parse a session JSONL into the ordered, paired transcript we render: real
 * user/assistant turns only (no sidechains/attachments), with tool_result blocks
 * folded back onto their originating tool_use block.
 */
export function readTranscript(sessionId: string): TranscriptMessage[] {
  const file = sessionFilePath(sessionId)
  if (!file) return []
  const messages: TranscriptMessage[] = []
  const toolUseLocation = new Map<string, { msg: number; block: number }>()

  for (const line of parseLines(file)) {
    if (line.isSidechain) continue
    if (line.type !== 'user' && line.type !== 'assistant') continue
    const content = line.message?.content
    const uuid = line.uuid ?? ''

    if (line.type === 'assistant') {
      const blocks: TranscriptBlock[] = []
      for (const b of Array.isArray(content) ? (content as RawBlock[]) : []) {
        if (b.type === 'text' && b.text) blocks.push({ kind: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking)
          blocks.push({ kind: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use') {
          toolUseLocation.set(b.id ?? '', { msg: messages.length, block: blocks.length })
          blocks.push({
            kind: 'tool_use',
            toolUseId: b.id ?? '',
            name: b.name ?? 'tool',
            input: b.input
          })
        }
      }
      if (blocks.length) messages.push({ uuid, role: 'assistant', blocks })
      continue
    }

    // user
    if (typeof content === 'string') {
      messages.push({ uuid, role: 'user', blocks: [{ kind: 'text', text: content }] })
      continue
    }
    if (Array.isArray(content)) {
      const arr = content as RawBlock[]
      const toolResults = arr.filter((b) => b.type === 'tool_result')
      if (toolResults.length) {
        for (const r of toolResults) {
          const loc = toolUseLocation.get(r.tool_use_id ?? '')
          if (!loc) continue
          const block = messages[loc.msg]?.blocks[loc.block]
          if (block && block.kind === 'tool_use') {
            block.result = { ok: r.is_error !== true, output: r.content }
          }
        }
        continue
      }
      const text = arr
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('')
      if (text) messages.push({ uuid, role: 'user', blocks: [{ kind: 'text', text }] })
    }
  }
  return messages
}

/**
 * Edit a message's text content in place on disk (Save — no regeneration).
 * For user messages the content is replaced wholesale; for assistant messages the
 * text blocks collapse to a single edited text block while thinking/tool_use blocks
 * are preserved in order.
 */
export function editMessageText(sessionId: string, uuid: string, newText: string): boolean {
  const file = sessionFilePath(sessionId)
  if (!file) return false
  const lines = readFileSync(file, 'utf8').split('\n')
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    let obj: RawLine
    try {
      obj = JSON.parse(lines[i]) as RawLine
    } catch {
      continue
    }
    if (obj.uuid !== uuid || !obj.message) continue

    const content = obj.message.content
    if (obj.type === 'user' || typeof content === 'string') {
      obj.message.content = newText
    } else if (Array.isArray(content)) {
      const blocks = content as RawBlock[]
      const firstText = blocks.findIndex((b) => b.type === 'text')
      const kept = blocks.filter((b) => b.type !== 'text')
      const insertAt = firstText === -1 ? kept.length : Math.min(firstText, kept.length)
      kept.splice(insertAt, 0, { type: 'text', text: newText })
      obj.message.content = kept
    } else {
      obj.message.content = newText
    }
    lines[i] = JSON.stringify(obj)
    changed = true
    break
  }

  if (changed) writeFileSync(file, lines.join('\n'), 'utf8')
  return changed
}
