import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomicWrite.js'

// Per-(conversation, plugin) key/value store — the ONLY guaranteed-restorable plugin state
// (PLUGIN_API.md §8). Scoped by path so conversation A's data is invisible to B, even for the
// same plugin id. Mirrors conversationStore's layout; clearPluginData()/deleteConversationData()
// already remove the parent `plugins/` dir.
function storageDir(conversationId: string, pluginId: string): string {
  return join(
    app.getPath('userData'),
    'atelier',
    'conversations',
    conversationId,
    'plugins',
    pluginId
  )
}

function storageFile(conversationId: string, pluginId: string): string {
  return join(storageDir(conversationId, pluginId), 'storage.json')
}

function load(conversationId: string, pluginId: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(storageFile(conversationId, pluginId), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

export function pluginStorageGet(conversationId: string, pluginId: string, key: string): unknown {
  return load(conversationId, pluginId)[key] ?? null
}

export function pluginStorageKeys(conversationId: string, pluginId: string): string[] {
  return Object.keys(load(conversationId, pluginId))
}

export function pluginStorageSet(
  conversationId: string,
  pluginId: string,
  key: string,
  value: unknown
): void {
  const data = load(conversationId, pluginId)
  data[key] = value
  // Atomic (temp + rename): a crash mid-write must never corrupt a plugin's storage — for
  // context-document plugins this file IS the agent's persistent working state.
  writeFileAtomic(storageFile(conversationId, pluginId), JSON.stringify(data, null, 2))
}
