import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  session,
  utilityProcess,
  Notification
} from 'electron'
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
  PluginDataHistorySchema,
  PluginWriteFileSchema,
  PluginNetFetchSchema,
  PluginReadAssetSchema,
  PluginFsListSchema,
  PluginShellOpenSchema,
  PluginNotifySchema,
  PluginFlashFrameSchema,
  PluginBadgeCountSchema,
  PluginConvPluginSchema,
  PluginHistorySchema,
  PluginBackendCallSchema,
  type AgentEvent,
  type OsEvent,
  type AuthStatus
} from './shared/events.js'
import {
  URL_CHANNEL_PREFIX,
  decodePluginHost,
  type DiscoveredPlugin,
  type PluginPermission,
  type RegistryView
} from './shared/plugins.js'
import { PluginRegistry } from './plugin/PluginRegistry.js'
import { WorkspaceRegistries, type WorkspaceChange } from './plugin/WorkspaceRegistries.js'
import { mergeRegistry } from './plugin/registryView.js'
import { DataBus, createFileSource, createUrlSource } from './plugin/DataBus.js'
import { createAssetReader } from './plugin/assets.js'
import { createFileWriter } from './plugin/fileWrite.js'
import { createFsLister } from './plugin/fsList.js'
import { createPathOpener } from './plugin/openPath.js'
import { createNetFetcher } from './plugin/netFetch.js'
import { OsNotifier } from './plugin/osNotify.js'
import { AgentHistoryRing } from './plugin/agentHistory.js'
import {
  PluginBackendManager,
  type BackendTransport,
  type BackendStorageOp
} from './plugin/PluginBackendManager.js'
import { buildPluginToolServers } from './plugin/pluginTools.js'
import { buildEnvironmentBriefing, buildAtelierToolServer } from './plugin/introspection.js'
import { registerPluginScheme, handlePluginProtocol } from './plugin/protocol.js'
import { pluginStorageGet, pluginStorageSet, pluginStorageKeys } from './plugin/pluginStorage.js'
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

// A5 — the bounded per-conversation AgentEvent ring, fed from the single place every event is
// pushed to the renderer. A pane backfills its conversation's recent trace via agent:history.
const history = new AgentHistoryRing()

function sendToRenderer(e: AgentEvent): void {
  if (e.kind === 'system_init' && SAFE_KEY_SOURCES.has(e.apiKeySource)) usingSubscription = true
  history.record(e)
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

// P4 S3: plugin-contributed tool backends run as isolated Electron utility processes (never in
// main — CLAUDE.md). One child per plugin, spawned on first tool call (or on enable for a service);
// the in-process MCP tool just forwards to it. `serviceName` must be [a-zA-Z0-9._-]; plugin ids
// already match. `--max-old-space-size` caps the child's V8 heap so a runaway backend can't exhaust
// memory (containment — ARCH_REVIEW_2026-07-19 P1 #12).
function utilityBackendTransport(backendPath: string, pluginId: string): BackendTransport {
  const child = utilityProcess.fork(backendPath, [], {
    serviceName: `atelier-plugin-${pluginId}`,
    execArgv: ['--max-old-space-size=512']
  })
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => {
      child.on('message', (m: unknown) => cb(m))
    },
    onExit: (cb) => {
      child.on('exit', () => cb())
    },
    kill: () => {
      child.kill()
    }
  }
}
// onPublish routes a service backend's unsolicited push to the DataBus, gated by the plugin's
// declared data:publish permission (the manager already confines it to an enabled conversation).
const backends = new PluginBackendManager(
  utilityBackendTransport,
  undefined,
  (pluginId, conversationId, channel, data) => {
    if (!pluginPermitted(conversationId, pluginId, 'data:publish')) return
    dataBus.publish(conversationId, channel, data)
  },
  // A6 — resolve a conversation's cwd for the hello/enable lifecycle payloads.
  (conversationId) => agents.cwdFor(conversationId),
  // A8 — broker a backend's storage request against the plugin's per-conversation store, gated by
  // the plugin's `storage` permission (throws → the manager replies { id, error } to the backend).
  async (pluginId, req: BackendStorageOp) => {
    const { op, conversationId, key, value } = req
    if (!pluginPermitted(conversationId, pluginId, 'storage')) {
      throw new Error('permission "storage" not granted')
    }
    if (op === 'keys') return pluginStorageKeys(conversationId, pluginId)
    if (op === 'get') {
      if (typeof key !== 'string' || !key) throw new Error('storage.get requires a key')
      return pluginStorageGet(conversationId, pluginId, key)
    }
    if (op === 'set') {
      if (typeof key !== 'string' || !key) throw new Error('storage.set requires a key')
      pluginStorageSet(conversationId, pluginId, key, value)
      return null
    }
    throw new Error(`unknown storage op "${String(op)}"`)
  }
)

// Context-document plugins (docs/CONTEXT_SYSTEM.md): inject each conversation's pinned exports as
// per-turn context, and register one update tool per export. Both resolve against the registry.
const agents = new AgentManager(
  sendToRenderer,
  (conversationId, pluginState) =>
    buildContextBlock(registryFor(conversationId), conversationId, pluginState),
  // mcpServers: the context update tools + the plugin-contributed backend tools, merged. All resolve
  // against the conversation's merged view so workspace plugins contribute tools/context too.
  (conversationId, pluginState) => {
    const reg = registryFor(conversationId)
    const ctx = buildContextMcpServers(reg, conversationId, pluginState, (pluginId, key) => {
      // The agent rewrote a pinned export — push it so the owning pane refreshes (no polling).
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.contextChanged, { conversationId, pluginId, key })
      }
    })
    const toolServers = buildPluginToolServers(
      reg,
      pluginState,
      // Forward the per-tool timeout override (5th arg) — dropping it pins every tool to the 30s
      // default and defeats manifest `timeoutMs` (e.g. a long build).
      // A6 — pass the conversationId (captured by this per-conversation closure) so each tool invoke
      // posted to the backend carries `{ id, tool, input, conversationId }`.
      (pluginId, backendPath, t, i, timeoutMs) =>
        backends.invoke(pluginId, backendPath, t, i, timeoutMs, conversationId)
    )
    // The built-in `atelier` introspection server is always present (independent of enablement) so
    // the agent can always inspect its environment; merged with the per-conversation servers.
    const atelier = buildAtelierToolServer(reg, pluginState)
    return { ...atelier, ...(ctx ?? {}), ...(toolServers ?? {}) }
  },
  // System-prompt append: the always-on environment briefing first (so a fresh conversation knows
  // it is inside Atelier and what plugins exist), then any enabled plugin's standing instruction.
  (conversationId, pluginState) => {
    const reg = registryFor(conversationId)
    const env = buildEnvironmentBriefing(reg, agents.cwdFor(conversationId) ?? undefined)
    const si = buildSystemInstruction(reg, conversationId, pluginState)
    return si ? `${env}\n\n${si}` : env
  },
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
  [createFileSource(resolveWithinCwd), createUrlSource()]
)

// Binary sibling of the file: source: read a cwd-scoped image as a data: URL for a pane that can't
// fetch it as a subresource (opaque origin, no conversation context in the request). Same scoping.
const readCwdAsset = createAssetReader(resolveWithinCwd)

// Write sibling of the file: source — a pane-produced artifact, atomically written and bounded to
// the conversation cwd by the same resolver (permission data:write).
const writeCwdFile = createFileWriter(resolveWithinCwd)

// A1 — non-recursive, cwd-scoped directory listing (permission fs:list). Same resolver bounds `dir`;
// `.gitignore` is evaluated against the conversation's cwd root.
const listCwdDir = createFsLister(resolveWithinCwd, (conversationId) =>
  agents.cwdFor(conversationId)
)

// A2 — open a cwd-scoped file in the OS default handler (permission shell:open). Re-gated wrapper
// around shell.openPath — never the renderer's unscoped app.openPath.
const openCwdPath = createPathOpener(resolveWithinCwd, (abs) => shell.openPath(abs))

// A4 — OS attention (permission os:notify): notifications with tag coalescing + a host-side rate cap,
// taskbar flash/badge, and window-focus queries, all against the single Atelier window.
const osNotifier = new OsNotifier({
  show: (opts, onClick) => {
    const n = new Notification({ title: opts.title, body: opts.body, silent: opts.silent })
    n.on('click', onClick)
    n.show()
    return { close: () => n.close() }
  },
  focusWindow: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  },
  flashFrame: (on) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(on)
  },
  setBadgeCount: (count) => {
    // Cross-platform best-effort: app.setBadgeCount is a no-op on Windows (returns false) but is the
    // documented API; a taskbar overlay icon is deliberately not over-engineered here (HOST-ADDENDUM A4).
    try {
      app.setBadgeCount(count)
    } catch {
      /* unsupported platform */
    }
  },
  isWindowFocused: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
  emitClick: (pluginId, notificationId) =>
    sendOsEvent({ kind: 'notification-click', pluginId, notificationId })
})

/** Push an OS event (notification click / window focus change) to the renderer relay (A4). */
function sendOsEvent(e: OsEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.osEvent, e)
}

// Host-side HTTP for panes (permission net:fetch): a real request verb (method/headers/body/binary,
// capped, cookie-isolated) beyond the one-shot url: DataBus channel.
const netFetch = createNetFetcher()

// Phase 7 — workspace-local plugins (docs/roadmap/07-workspace-plugins.md). One PluginRegistry per
// distinct open cwd (rooted at <cwd>/.atelier/plugins), refcounted by the conversations on it.
const workspaces = new WorkspaceRegistries(
  (root, onChange) => new PluginRegistry(root, () => onChange()),
  (change) => onWorkspaceChange(change)
)

/** The registry view a conversation resolves against: the global catalog merged with its cwd's
 *  workspace registry (global wins id collisions). Every plugin consumer goes through this. */
function registryFor(conversationId: string): RegistryView {
  const cwd = agents.cwdFor(conversationId)
  if (!cwd) return plugins
  const ws = workspaces.registryForCwd(cwd)
  return ws ? mergeRegistry(plugins, ws, workspaces.keyForCwd(cwd)) : plugins
}

/** Keep the workspace registries tracking exactly the live conversations (create/open/close/restore).
 *  Creates a cwd's registry on its first conversation, releases it (fs watcher freed) on the last. */
function reconcileWorkspaces(): void {
  workspaces.reconcile(agents.openConversations())
}

/** Apply an enable/disable for (conversation, plugin): service lifecycle + agent tool/context rebind.
 *  Shared by the IPC handler and workspace auto-enable so both paths behave identically. */
function applyPluginEnabled(
  conversationId: string,
  pluginId: string,
  enabled: boolean,
  view: RegistryView
): void {
  const manifest = view.get(pluginId)?.manifest
  const exportKeys = (manifest?.contextExports ?? []).map((e) => e.key)
  const hasTools = !!(
    manifest?.backend &&
    manifest.tools.length > 0 &&
    manifest.permissions.includes('tools')
  )
  const backendDir = view.dirOf(pluginId)
  const isService = !!(manifest?.service && manifest.backend && backendDir)
  if (isService) {
    const backendPath = join(backendDir!, manifest!.backend!)
    if (enabled) backends.startService(pluginId, backendPath, conversationId)
    else backends.stopService(pluginId, conversationId)
  } else if (!enabled && hasTools) {
    backends.stop(pluginId) // on-demand tool backend: free the child process on disable
  }
  agents.setPluginEnabled(conversationId, pluginId, enabled, exportKeys, hasTools)
}

/** D2 — a freshly-authored workspace plugin auto-enables for the conversations on its cwd (no click).
 *  Only VALID, newly-added, non-shadowed ids; a broken/colliding manifest surfaces in the rail but
 *  never mounts. Then the renderer is nudged to refetch the per-conversation catalog + enabled set. */
function onWorkspaceChange(change: WorkspaceChange): void {
  for (const pluginId of change.added) {
    if (plugins.get(pluginId)) continue // shadowed by a global plugin → global wins, don't auto-enable
    for (const conversationId of change.convs) {
      applyPluginEnabled(conversationId, pluginId, true, registryFor(conversationId))
    }
  }
  notifyPluginsChanged()
}

/** Signal the renderer that the plugin catalog changed (global or workspace); it refetches per the
 *  active conversation. Payload carries the global list for back-compat but is treated as a nudge. */
function notifyPluginsChanged(): void {
  sendPlugins(plugins.list())
}

// Main-side enforcement of a plugin's declared coupling contract: a privileged handler confirms the
// plugin is enabled for the conversation AND declares the permission, instead of trusting the
// renderer relay's check alone (ARCH_REVIEW_2026-07-19 P0 #1). New verbs are built with this from
// the start; the pre-existing data/storage/context handlers are retrofitted separately.
function pluginPermitted(
  conversationId: string,
  pluginId: string,
  permission: PluginPermission
): boolean {
  const manifest = registryFor(conversationId).get(pluginId)?.manifest
  if (!manifest) return false
  if (!agents.pluginStateFor(conversationId)[pluginId]?.enabled) return false
  return manifest.permissions.includes(permission)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0e1014',
    title: 'Atelier',
    icon: join(app.getAppPath(), 'resources/atelier.ico'),
    frame: false, // custom 36px title bar (DESIGN_SYSTEM.md M3); controls via window:* IPC
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      // Enables the <webview> tag the renderer uses for the host-owned browser surface
      // (permission "browser:embed"). Every attach is hardened in installWebviewGuard.
      webviewTag: true
    }
  })

  installSpellcheckMenu(mainWindow)
  installWebviewGuard(mainWindow)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  installCrashRecovery(mainWindow)

  // A4 — surface window focus changes to any pane that subscribed via os.onWindowFocusChange.
  mainWindow.on('focus', () => sendOsEvent({ kind: 'window-focus', focused: true }))
  mainWindow.on('blur', () => sendOsEvent({ kind: 'window-focus', focused: false }))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Hardening for the host-owned browser surface (<webview>, permission "browser:embed"). The guest
// page runs arbitrary remote JS, so every attach is forced down to zero privilege regardless of
// what the renderer asked for: no preload, no node, OS sandbox on, isolated world, http(s)-only.
// Popups never open OS windows — a window.open/_blank becomes an in-place navigation instead.
function installWebviewGuard(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    const src = params.src ?? ''
    if (src && !/^(https?:|about:blank)/i.test(src)) event.preventDefault()
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      // Deferred: navigating the guest from inside its own open-handler (before the deny is
      // returned) can wedge the pending window creation.
      if (/^https?:/i.test(url)) setImmediate(() => void guest.loadURL(url))
      return { action: 'deny' }
    })
    // will-attach only hardens the INITIAL src; page JS / meta-refresh / a server redirect can
    // still send the guest to file:// or any other scheme afterward. Confine every subsequent
    // navigation to http(s) too (ARCH_REVIEW_2026-07-19 P0 #2). The guest stays sandboxed/no-node
    // regardless, so this is surface reduction, not the sole containment.
    const blockNonHttp = (details: Electron.Event & { url: string }): void => {
      if (details.url && !/^https?:\/\//i.test(details.url)) details.preventDefault()
    }
    guest.on('will-navigate', blockNonHttp)
    guest.on('will-redirect', blockNonHttp)
  })
}

// Right-click menu for editable fields: spellcheck suggestions + standard clipboard actions.
// Electron ships no default context menu, so without this the built-in spellchecker underlines
// misspellings but offers no way to correct them. Only shown over editable content.
function installSpellcheckMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return
    const wc = win.webContents
    const items: Electron.MenuItemConstructorOptions[] = []

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) })
      }
      if (params.dictionarySuggestions.length === 0) {
        items.push({ label: 'No suggestions', enabled: false })
      }
      items.push(
        { type: 'separator' },
        {
          label: 'Add to dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        },
        { type: 'separator' }
      )
    }

    items.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' }
    )

    Menu.buildFromTemplate(items).popup({ window: win })
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
    const id = agents.create({ ...opts, cwd: opts.cwd })
    reconcileWorkspaces() // a new cwd may need its workspace registry started
    return id
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
    reconcileWorkspaces() // may release the cwd's workspace registry if this was its last conversation
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

  ipcMain.handle(IPC.agentUiState, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    return agents.uiState(instanceId)
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
    const id = agents.importSession(cwd, sessionId, title)
    reconcileWorkspaces()
    return id
  })

  ipcMain.handle(IPC.agentOpen, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    const id = agents.open(instanceId)
    reconcileWorkspaces()
    return id
  })

  ipcMain.handle(IPC.agentClearChat, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    agents.clearChat(instanceId)
    history.clear(instanceId) // A5 — a cleared chat starts a fresh trace
  })

  ipcMain.handle(IPC.agentClearPlugins, (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    agents.clearPlugins(instanceId)
  })

  ipcMain.handle(IPC.agentDelete, async (_e, payload) => {
    const { instanceId } = InstanceRefSchema.parse(payload)
    await agents.deleteConversation(instanceId)
    history.clear(instanceId) // A5 — drop the deleted conversation's trace
    reconcileWorkspaces()
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

  ipcMain.handle(IPC.pluginsList, (_e, payload) => {
    // Per-conversation catalog: the global list merged with the conversation's workspace plugins
    // (Phase 7). No conversationId → the bare global list (e.g. before any conversation is active).
    const { conversationId } = z
      .object({ conversationId: z.string().min(1).optional() })
      .parse(payload ?? {})
    return conversationId ? registryFor(conversationId).list() : plugins.list()
  })

  ipcMain.handle(IPC.pluginsEnabledFor, (_e, payload) => {
    const { conversationId } = ConversationRefSchema.parse(payload)
    return agents.pluginStateFor(conversationId)
  })

  ipcMain.handle(IPC.pluginsSetEnabled, (_e, payload) => {
    const { conversationId, pluginId, enabled } = SetPluginEnabledSchema.parse(payload)
    // Resolve against the conversation's merged view so a workspace plugin enables like a global one
    // (auto-pin exports, service lifecycle, tool rebind — all in applyPluginEnabled).
    applyPluginEnabled(conversationId, pluginId, enabled, registryFor(conversationId))
  })

  ipcMain.handle(IPC.pluginsReload, async (_e, payload) => {
    const { pluginId } = PluginIdSchema.parse(payload)
    // Reset ONLY the reloaded plugin's backend (fresh module + cleared crash/wedge state, re-spawned
    // if it's a still-enabled service) — reloading one plugin must not kill unrelated backends
    // mid-call (ARCH_REVIEW_2026-07-19 P1 #11).
    backends.reset(pluginId)
    // Reload must guarantee fresh files BY CONSTRUCTION, not via header semantics: flush the
    // HTTP + compiled-script caches BEFORE the renderer remounts panes, so a pane can never
    // come back with a stale script against a fresh index.html (the dead-pane class of bug —
    // protocol.ts serves no-store now, but this also evicts anything cached before that and
    // survives any future header regression). Local-file cache; clearing it costs nothing.
    await session.defaultSession.clearCache()
    await session.defaultSession.clearCodeCaches({}).catch(() => {})
    plugins.scan() // re-read global manifests; workspace registries self-watch their own dirs
    notifyPluginsChanged() // renderer refetches per-conversation + remounts affected panes
  })

  ipcMain.handle(IPC.pluginStorageGet, (_e, payload) => {
    const { conversationId, pluginId, key } = PluginStorageGetSchema.parse(payload)
    return pluginValueOrDefault(registryFor(conversationId), conversationId, pluginId, key)
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
    const v = pluginValueOrDefault(
      registryFor(conversationId),
      conversationId,
      pluginId,
      contextStorageKey(key)
    )
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

  ipcMain.handle(IPC.pluginDataHistory, (_e, payload) => {
    const { conversationId, pluginId, channel, limit } = PluginDataHistorySchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'data:subscribe')) {
      throw new Error('permission "data:subscribe" not granted')
    }
    if (
      channel.startsWith(URL_CHANNEL_PREFIX) &&
      !pluginPermitted(conversationId, pluginId, 'net:fetch')
    ) {
      throw new Error('permission "net:fetch" not granted')
    }
    return dataBus.getHistory(conversationId, channel, limit)
  })

  ipcMain.handle(IPC.pluginWriteFile, (_e, payload) => {
    const { conversationId, pluginId, path, content } = PluginWriteFileSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'data:write')) {
      throw new Error('permission "data:write" not granted')
    }
    return writeCwdFile(conversationId, path, content)
  })

  ipcMain.handle(IPC.pluginNetFetch, (_e, payload) => {
    const { conversationId, pluginId, url, opts } = PluginNetFetchSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'net:fetch')) {
      throw new Error('permission "net:fetch" not granted')
    }
    return netFetch(url, opts)
  })

  ipcMain.handle(IPC.pluginReadAsset, (_e, payload) => {
    const { conversationId, path } = PluginReadAssetSchema.parse(payload)
    return readCwdAsset(conversationId, path)
  })

  // A1 — non-recursive, cwd-scoped directory listing (permission fs:list). Refusal is `{ error }`.
  ipcMain.handle(IPC.pluginFsList, (_e, payload) => {
    const { conversationId, pluginId, dir } = PluginFsListSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'fs:list')) {
      return { error: 'permission "fs:list" not granted' }
    }
    return listCwdDir(conversationId, dir)
  })

  // A2 — open a cwd-scoped file in the OS default handler (permission shell:open). Refusal is `{ error }`.
  ipcMain.handle(IPC.pluginShellOpen, async (_e, payload) => {
    const { conversationId, pluginId, path } = PluginShellOpenSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'shell:open')) {
      return { error: 'permission "shell:open" not granted' }
    }
    return openCwdPath(conversationId, path)
  })

  // A4 — OS notification (permission os:notify). Returns { id } | { error }.
  ipcMain.handle(IPC.pluginNotify, (_e, payload) => {
    const { conversationId, pluginId, title, body, sound, tag } = PluginNotifySchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'os:notify')) {
      return { error: 'permission "os:notify" not granted' }
    }
    return osNotifier.notify(pluginId, { title, body, sound, tag })
  })

  ipcMain.handle(IPC.pluginFlashFrame, (_e, payload) => {
    const { conversationId, pluginId, on } = PluginFlashFrameSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'os:notify')) return
    osNotifier.flashFrame(on)
  })

  ipcMain.handle(IPC.pluginBadgeCount, (_e, payload) => {
    const { conversationId, pluginId, count } = PluginBadgeCountSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'os:notify')) return
    osNotifier.setBadgeCount(count)
  })

  ipcMain.handle(IPC.pluginWindowFocused, (_e, payload) => {
    const { conversationId, pluginId } = PluginConvPluginSchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'os:notify')) return false
    return osNotifier.isWindowFocused()
  })

  // A5 — bounded backfill of this conversation's AgentEvent trace (existing agent:read).
  ipcMain.handle(IPC.pluginAgentHistory, (_e, payload) => {
    const { conversationId, pluginId, limit } = PluginHistorySchema.parse(payload)
    if (!pluginPermitted(conversationId, pluginId, 'agent:read')) {
      return { error: 'permission "agent:read" not granted' }
    }
    return history.get(conversationId, limit)
  })

  // A7 — panel→own-service-backend RPC. No new permission; the plugin must have a live service
  // backend enabled in this conversation. Returns { result } | { error } (never throws to the pane).
  ipcMain.handle(IPC.pluginBackendCall, async (_e, payload) => {
    const { conversationId, pluginId, op, params, timeoutMs } =
      PluginBackendCallSchema.parse(payload)
    // Confirm the plugin is enabled here and actually declares a service backend before dispatching.
    const manifest = registryFor(conversationId).get(pluginId)?.manifest
    if (!manifest || !agents.pluginStateFor(conversationId)[pluginId]?.enabled) {
      return { error: 'plugin not enabled for this conversation' }
    }
    if (!(manifest.service && manifest.backend)) {
      return { error: 'plugin does not declare a service backend' }
    }
    try {
      const result = await backends.callRpc(pluginId, op, conversationId, params, timeoutMs)
      return { result }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}

app.whenReady().then(() => {
  ensureNodeOnPath()
  registerIpc()
  // Serve plugin assets: a bare host resolves globally; a `w--<key>--<id>` host resolves against
  // that workspace's registry (Phase 7). Decode + dispatch here so protocol.ts stays mechanics-only.
  handlePluginProtocol((host) => {
    const { pluginId, workspaceKey } = decodePluginHost(host)
    if (workspaceKey) return workspaces.registryForKey(workspaceKey)?.get(pluginId)
    return plugins.get(pluginId)
  })
  plugins.start() // discover /plugins and watch for changes
  // Stand up each soon-to-be-restored conversation's workspace registry BEFORE restore builds its
  // query, so a restored conversation's workspace plugins contribute tools/context from turn one
  // (PluginRegistry.start scans synchronously, so the merged view is populated immediately).
  workspaces.reconcile(agents.restorableOpen())
  agents.restore() // recreate persisted conversations, resuming each active branch
  reconcileWorkspaces() // exact reconcile against the live set (drops any that didn't restore)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void agents.closeAll()
  plugins.stop()
  workspaces.stopAll() // release every per-cwd workspace registry's fs watcher
  backends.stopAll() // kill any plugin backend child processes
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void agents.closeAll()
  backends.stopAll()
})
