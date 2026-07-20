import { app } from 'electron'
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomicWrite.js'
import type { ConversationPluginState } from './shared/plugins.js'
import type { PermissionMode } from './shared/events.js'

/** One branch (SDK session) in a conversation's fork tree. */
export interface PersistedBranch {
  sessionId: string
  parentSessionId?: string
  forkPointUuid?: string
  forkAnchorUuid?: string | null
  label: string
  createdAt: number
}

/** A conversation = a self-contained, restorable document (SPEC §4.5). */
export interface ConversationManifest {
  id: string
  title: string
  cwd: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  branches: PersistedBranch[]
  activeBranch?: string // sessionId of the active branch
  // Tool-approval mode (e.g. bypass). Persisted so a relaunch/reopen doesn't silently revert
  // an enabled bypass to 'default' — the prompts coming back would contradict the user's toggle.
  permissionMode?: PermissionMode
  layout?: unknown // per-conversation Dockview serialization (reserved)
  // Per-conversation plugin enablement + pinned exports (app-wide registry, per-conversation
  // enabled set — PLUGIN_ARCHITECTURE.md §1). Keyed by plugin id.
  plugins?: Record<string, ConversationPluginState>
  createdAt: number
  updatedAt: number
}

const root = () => join(app.getPath('userData'), 'atelier')
const convDir = () => join(root(), 'conversations')
const manifestPath = (id: string) => join(convDir(), id, 'conversation.json')
const statePath = () => join(root(), 'state.json')

export function listConversations(): ConversationManifest[] {
  try {
    if (!existsSync(convDir())) return []
    const out: ConversationManifest[] = []
    for (const id of readdirSync(convDir())) {
      const p = manifestPath(id)
      if (!existsSync(p)) continue
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')) as ConversationManifest)
      } catch {
        /* skip corrupt manifest */
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  } catch {
    return []
  }
}

export function saveConversation(m: ConversationManifest): void {
  try {
    writeFileAtomic(manifestPath(m.id), JSON.stringify(m, null, 2))
  } catch {
    /* best-effort persistence */
  }
}

// Runtime state: which conversation is active, which are "open", last-known usage.
interface AppState {
  activeId?: string | null
  openIds?: string[]
  lastUsage?: unknown
  // The permission mode new conversations start in (the user treats bypass as one app-wide
  // switch, not something to re-enable per conversation). Updated on every toggle.
  defaultPermissionMode?: PermissionMode
}

function loadState(): AppState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as AppState
  } catch {
    return {}
  }
}

function saveState(s: AppState): void {
  try {
    writeFileAtomic(statePath(), JSON.stringify(s))
  } catch {
    /* best-effort */
  }
}

export function getActiveConversationId(): string | null {
  return loadState().activeId ?? null
}

export function setActiveConversationId(id: string | null): void {
  saveState({ ...loadState(), activeId: id })
}

export function getOpenConversationIds(): string[] {
  return loadState().openIds ?? []
}

export function setOpenConversationIds(ids: string[]): void {
  saveState({ ...loadState(), openIds: ids })
}

export function getDefaultPermissionMode(): PermissionMode {
  return loadState().defaultPermissionMode ?? 'default'
}

export function setDefaultPermissionMode(mode: PermissionMode): void {
  saveState({ ...loadState(), defaultPermissionMode: mode })
}

export function getLastUsage(): unknown {
  return loadState().lastUsage ?? null
}

export function setLastUsage(usage: unknown): void {
  saveState({ ...loadState(), lastUsage: usage })
}

/** Clear a conversation's plugin data/state (its per-plugin storage). */
export function clearPluginData(conversationId: string): void {
  try {
    rmSync(join(convDir(), conversationId, 'plugins'), { recursive: true, force: true })
  } catch {
    /* nothing to clear */
  }
}

/** Permanently remove a conversation's manifest + plugin data (its store folder). */
export function deleteConversationData(conversationId: string): void {
  try {
    rmSync(join(convDir(), conversationId), { recursive: true, force: true })
  } catch {
    /* already gone */
  }
}
