import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { z } from 'zod'
import { AgentManager } from './agent/AgentManager.js'
import {
  IPC,
  CreateOptsSchema,
  SendSchema,
  InstanceRefSchema,
  RenameSchema,
  SaveLayoutSchema,
  SessionsForSchema,
  ImportSessionSchema,
  PermissionDecisionSchema,
  AnswerQuestionSchema,
  SetPermissionModeSchema,
  SetModelSchema,
  SetEffortSchema,
  SetAutoResumeSchema,
  EditSaveSchema,
  ForkSchema,
  SwitchBranchSchema,
  ConversationRefSchema,
  PluginIdSchema,
  SetPluginEnabledSchema,
  PluginStorageGetSchema,
  PluginStorageSetSchema,
  PluginStorageKeysSchema,
  PluginContextGetSchema,
  PluginContextSetSchema,
  PluginDataChannelSchema,
  PluginDataPublishSchema,
  type AgentEvent,
  type AuthStatus
} from './shared/events.js'
import type { DiscoveredPlugin } from './shared/plugins.js'
import { PluginRegistry } from './plugin/PluginRegistry.js'
import { DataBus, createFileSource } from './plugin/DataBus.js'
import { registerPluginScheme, handlePluginProtocol } from './plugin/protocol.js'
import { pluginStorageSet, pluginStorageKeys } from './plugin/pluginStorage.js'
import {
  buildContextBlock,
  buildContextMcpServers,
  buildSystemInstruction,
  contextStorageKey,
  pluginValueOrDefault
} from './plugin/contextTools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Register the plugin asset scheme as privileged BEFORE app `ready` (Electron requirement).
registerPluginScheme()

// ---- Ensure the spawned agent (and its Bash tool) can find node/npm ----
// When Atelier is launched from a GUI shortcut the inherited PATH may lack Node;
// the agent's tools then fail with exit 127. Prepend a known Node dir if present.
function ensureNodeOnPath(): void {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\nodejs']
      : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
  const current = process.env.PATH ?? ''
  const parts = current.split(sep)
  for (const dir of candidates) {
    if (existsSync(join(dir, exe)) && !parts.includes(dir)) {
      process.env.PATH = dir + sep + current
      return
    }
  }
}

// ---- Billing-safety: never let the API key path bill the user (see SDK_NOTES) ----
// If ANTHROPIC_API_KEY is present it would override the subscription and bill the API
// account. We remove it from the env the SDK child inherits, and surface the fact.
const apiKeyWasPresent = Boolean(process.env.ANTHROPIC_API_KEY)
if (apiKeyWasPresent) {
  delete process.env.ANTHROPIC_API_KEY
  // eslint-disable-next-line no-console
  console.warn(
    '[atelier] ANTHROPIC_API_KEY was set; removing it so Atelier uses your Claude ' +
      'subscription session instead of pay-as-you-go API billing.'
  )
}
let usingSubscription = false

let mainWindow: BrowserWindow | null = null

// 'oauth' = subscription login; 'none' = no API key (ambient Claude Code session).
// Anything else ('user'/'project'/'org'/'temporary') means an API key is in play.
const SAFE_KEY_SOURCES = new Set(['oauth', 'none'])

function sendToRenderer(e: AgentEvent): void {
  if (e.kind === 'system_init' && SAFE_KEY_SOURCES.has(e.apiKeySource)) usingSubscription = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.agentEvent, e)
  }
}

function sendPlugins(list: DiscoveredPlugin[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.pluginsChanged, list)
  }
}

// App-wide plugin catalog. In dev `process.cwd()` is the repo root, so /plugins is discovered;
// overridable for packaging via ATELIER_PLUGINS_DIR.
const PLUGINS_DIR = process.env.ATELIER_PLUGINS_DIR ?? join(process.cwd(), 'plugins')
const plugins = new PluginRegistry(PLUGINS_DIR, sendPlugins)

// Context-document plugins (docs/CONTEXT_SYSTEM.md): inject each conversation's pinned exports as
// per-turn context, and register one update tool per export. Both resolve against the registry.
const agents = new AgentManager(
  sendToRenderer,
  (conversationId, pluginState) => buildContextBlock(plugins, conversationId, pluginState),
  (conversationId, pluginState) =>
    buildContextMcpServers(plugins, conversationId, pluginState, (pluginId, key) => {
      // The agent rewrote a pinned export — push it so the owning pane refreshes (no polling).
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.contextChanged, { conversationId, pluginId, key })
      }
    }),
  (conversationId, pluginState) => buildSystemInstruction(plugins, conversationId, pluginState),
  // Ambient Bash tap → DataBus. Forward-referenced (dataBus is built just below, since it needs
  // agents.cwdFor); the closure only runs later when a Bash hook fires, by which point it's set.
  (conversationId, channel, data) => dataBus.publish(conversationId, channel, data)
)

// DataBus (P4): pub/sub between plugins and ambient sources. The file source maps a `file:<rel>`
// channel to a path scoped within the owning conversation's cwd (never outside — invariant #3).
function resolveWithinCwd(conversationId: string, rel: string): string | null {
  const cwd = agents.cwdFor(conversationId)
  if (!cwd) return null
  const base = resolve(cwd)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return null
  return full
}
const dataBus = new DataBus(
  (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.dataMessage, msg)
  },
  [createFileSource(resolveWithinCwd)]
)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0e1014',
    title: 'Atelier',
    frame: false, // custom 36px title bar (DESIGN_SYSTEM.md M3); controls via window:* IPC
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  installCrashRecovery(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Auto-recover from a renderer that dies outright (OOM, a native/WebGL fault, etc.) by reloading
// the window — but cap reloads so a load that crashes on sight can't spin a reload loop forever.
// (React render exceptions, which leave the process alive, are caught by the renderer's
// ErrorBoundary instead; this is only for the process actually going away.)
const CRASH_WINDOW_MS = 10_000
const CRASH_LIMIT = 3
function installCrashRecovery(win: BrowserWindow): void {
  let crashes: number[] = []
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    crashes = crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    crashes.push(now)
    // Too many crashes in a row → stop reloading and leave the failed state visible to debug.
    if (crashes.length > CRASH_LIMIT) return
    win.reload()
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.agentCreate, (_e, payload) => {
    const opts = CreateOptsSchema.parse(payload)
    return agents.create({ ...opts, cwd: opts.cwd })
  })

  ipcMain.handle(IPC.agentSend, (_e, payload) => {
    const { instanceId, text } = SendSchema.parse(payload)
    agents.send(instanceId, text)
  })

  ipcMain.handle(IPC.agentInterrupt, async (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    await agents.interrupt(instanceId)
  })

  ipcMain.handle(IPC.agentClose, async (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    dataBus.dropConversation(instanceId) // release any file watchers this conversation opened
    await agents.close(instanceId)
  })

  ipcMain.handle(IPC.agentDecide, (_e, payload) => {
    const { instanceId, requestId, behavior, allowAlways } = PermissionDecisionSchema.parse(payload)
    agents.decide(instanceId, requestId, behavior, allowAlways)
  })

  ipcMain.handle(IPC.agentAnswer, (_e, payload) => {
    const { instanceId, requestId, answers, response } = AnswerQuestionSchema.parse(payload)
    agents.answer(instanceId, requestId, answers, response)
  })

  ipcMain.handle(IPC.agentSetMode, async (_e, payload) => {
    const { instanceId, mode } = SetPermissionModeSchema.parse(payload)
    await agents.setPermissionMode(instanceId, mode)
  })

  ipcMain.handle(IPC.agentModels, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.models(instanceId)
  })

  ipcMain.handle(IPC.agentSetModel, async (_e, payload) => {
    const { instanceId, model } = SetModelSchema.parse(payload)
    await agents.setModel(instanceId, model)
  })

  ipcMain.handle(IPC.agentSetEffort, (_e, payload) => {
    const { instanceId, effort } = SetEffortSchema.parse(payload)
    agents.setEffort(instanceId, effort)
  })

  ipcMain.handle(IPC.agentSetAutoResume, (_e, payload) => {
    const { instanceId, enabled } = SetAutoResumeSchema.parse(payload)
    agents.setAutoResume(instanceId, enabled)
  })

  ipcMain.handle(IPC.agentUsage, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.usage(instanceId)
  })

  ipcMain.handle(IPC.agentTranscript, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.transcript(instanceId)
  })

  ipcMain.handle(IPC.agentEditSave, (_e, payload) => {
    const { instanceId, uuid, newText } = EditSaveSchema.parse(payload)
    return agents.editSave(instanceId, uuid, newText)
  })

  ipcMain.handle(IPC.agentFork, (_e, payload) => {
    const { instanceId, uuid, newText } = ForkSchema.parse(payload)
    return agents.fork(instanceId, uuid, newText)
  })

  ipcMain.handle(IPC.agentForkPoints, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.forkPoints(instanceId)
  })

  ipcMain.handle(IPC.agentSwitchBranch, (_e, payload) => {
    const { instanceId, sessionId } = SwitchBranchSchema.parse(payload)
    return agents.switchBranch(instanceId, sessionId)
  })

  ipcMain.handle(IPC.agentList, () => agents.list())

  ipcMain.handle(IPC.agentListAll, () => agents.listAll())

  ipcMain.handle(IPC.agentSessionsFor, (_e, payload) => {
    const { cwd } = SessionsForSchema.parse(payload)
    return agents.sessionsFor(cwd)
  })

  ipcMain.handle(IPC.agentImportSession, (_e, payload) => {
    const { cwd, sessionId, title } = ImportSessionSchema.parse(payload)
    return agents.importSession(cwd, sessionId, title)
  })

  ipcMain.handle(IPC.agentOpen, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.open(instanceId)
  })

  ipcMain.handle(IPC.agentClearChat, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    agents.clearChat(instanceId)
  })

  ipcMain.handle(IPC.agentClearPlugins, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    agents.clearPlugins(instanceId)
  })

  ipcMain.handle(IPC.agentDelete, async (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    await agents.deleteConversation(instanceId)
  })

  ipcMain.handle(IPC.agentSetActive, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    agents.setActive(instanceId)
  })

  ipcMain.handle(IPC.agentActiveId, () => agents.activeId())

  ipcMain.handle(IPC.agentSaveLayout, (_e, payload) => {
    const { instanceId, layout } = SaveLayoutSchema.parse(payload)
    agents.setLayout(instanceId, layout)
  })

  ipcMain.handle(IPC.agentGetLayout, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.getLayout(instanceId)
  })

  ipcMain.handle(IPC.authStatus, (): AuthStatus => ({
    apiKeyWasPresent,
    usingSubscription,
    note: apiKeyWasPresent
      ? 'ANTHROPIC_API_KEY was removed; using your Claude subscription session.'
      : 'No API key set; using your Claude subscription session.'
  }))

  ipcMain.handle(IPC.appDefaultCwd, () => process.cwd())

  ipcMain.handle(IPC.agentRename, (_e, payload) => {
    const { instanceId, title } = RenameSchema.parse(payload)
    agents.rename(instanceId, title)
  })

  ipcMain.handle(IPC.appPickFolder, async () => {
    const win = mainWindow ?? undefined
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.appOpenPath, async (_e, payload) => {
    const path = z.string().min(1).parse(payload)
    await shell.openPath(path)
  })

  // ---- Frameless window controls ----
  ipcMain.handle(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.handle(IPC.windowMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle(IPC.windowClose, () => mainWindow?.close())

  // ---- Plugin host ----

  ipcMain.handle(IPC.pluginsList, () => plugins.list())

  ipcMain.handle(IPC.pluginsEnabledFor, (_e, payload) => {
    const { conversationId } = ConversationRefSchema.parse(payload)
    return agents.pluginStateFor(conversationId)
  })

  ipcMain.handle(IPC.pluginsSetEnabled, (_e, payload) => {
    const { conversationId, pluginId, enabled } = SetPluginEnabledSchema.parse(payload)
    // Auto-pin the plugin's context exports on enable (docs/CONTEXT_SYSTEM.md).
    const exportKeys = (plugins.get(pluginId)?.manifest?.contextExports ?? []).map((e) => e.key)
    agents.setPluginEnabled(conversationId, pluginId, enabled, exportKeys)
  })

  ipcMain.handle(IPC.pluginsReload, (_e, payload) => {
    PluginIdSchema.parse(payload)
    plugins.scan() // re-read manifests; the renderer remounts affected panes
    sendPlugins(plugins.list())
  })

  ipcMain.handle(IPC.pluginStorageGet, (_e, payload) => {
    const { conversationId, pluginId, key } = PluginStorageGetSchema.parse(payload)
    return pluginValueOrDefault(plugins, conversationId, pluginId, key)
  })

  ipcMain.handle(IPC.pluginStorageSet, (_e, payload) => {
    const { conversationId, pluginId, key, value } = PluginStorageSetSchema.parse(payload)
    pluginStorageSet(conversationId, pluginId, key, value)
  })

  ipcMain.handle(IPC.pluginStorageKeys, (_e, payload) => {
    const { conversationId, pluginId } = PluginStorageKeysSchema.parse(payload)
    return pluginStorageKeys(conversationId, pluginId)
  })

  ipcMain.handle(IPC.pluginContextGet, (_e, payload) => {
    const { conversationId, pluginId, key } = PluginContextGetSchema.parse(payload)
    const v = pluginValueOrDefault(plugins, conversationId, pluginId, contextStorageKey(key))
    return typeof v === 'string' ? v : ''
  })

  ipcMain.handle(IPC.pluginContextSet, (_e, payload) => {
    const { conversationId, pluginId, key, value } = PluginContextSetSchema.parse(payload)
    pluginStorageSet(conversationId, pluginId, contextStorageKey(key), value)
  })

  ipcMain.handle(IPC.pluginDataSubscribe, async (_e, payload) => {
    const { conversationId, pluginId, channel } = PluginDataChannelSchema.parse(payload)
    await dataBus.subscribe(conversationId, pluginId, channel)
  })

  ipcMain.handle(IPC.pluginDataUnsubscribe, (_e, payload) => {
    const { conversationId, pluginId, channel } = PluginDataChannelSchema.parse(payload)
    dataBus.unsubscribe(conversationId, pluginId, channel)
  })

  ipcMain.handle(IPC.pluginDataPublish, (_e, payload) => {
    const { conversationId, channel, data } = PluginDataPublishSchema.parse(payload)
    dataBus.publish(conversationId, channel, data)
  })
}

app.whenReady().then(() => {
  ensureNodeOnPath()
  registerIpc()
  handlePluginProtocol(plugins) // serve plugin assets to sandboxes (after ready)
  plugins.start() // discover /plugins and watch for changes
  agents.restore() // recreate persisted conversations, resuming each active branch
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void agents.closeAll()
  plugins.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void agents.closeAll()
})
