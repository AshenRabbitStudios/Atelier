import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AgentEvent, type AtelierAPI } from './shared/events.js'

// The ONLY bridge between the sandboxed renderer and the privileged main process.
const api: AtelierAPI = {
  agent: {
    create: (opts) => ipcRenderer.invoke(IPC.agentCreate, opts),
    send: (instanceId, text) => ipcRenderer.invoke(IPC.agentSend, { instanceId, text }),
    interrupt: (instanceId) => ipcRenderer.invoke(IPC.agentInterrupt, { instanceId }),
    list: () => ipcRenderer.invoke(IPC.agentList),
    listAll: () => ipcRenderer.invoke(IPC.agentListAll),
    sessionsFor: (cwd) => ipcRenderer.invoke(IPC.agentSessionsFor, { cwd }),
    importSession: (cwd, sessionId, title) =>
      ipcRenderer.invoke(IPC.agentImportSession, { cwd, sessionId, title }),
    open: (conversationId) => ipcRenderer.invoke(IPC.agentOpen, { instanceId: conversationId }),
    clearChat: (instanceId) => ipcRenderer.invoke(IPC.agentClearChat, { instanceId }),
    clearPlugins: (instanceId) => ipcRenderer.invoke(IPC.agentClearPlugins, { instanceId }),
    delete: (conversationId) => ipcRenderer.invoke(IPC.agentDelete, { instanceId: conversationId }),
    setActive: (instanceId) => ipcRenderer.invoke(IPC.agentSetActive, { instanceId }),
    activeId: () => ipcRenderer.invoke(IPC.agentActiveId),
    saveLayout: (instanceId, layout) => ipcRenderer.invoke(IPC.agentSaveLayout, { instanceId, layout }),
    getLayout: (instanceId) => ipcRenderer.invoke(IPC.agentGetLayout, { instanceId }),
    close: (instanceId) => ipcRenderer.invoke(IPC.agentClose, { instanceId }),
    rename: (instanceId, title) => ipcRenderer.invoke(IPC.agentRename, { instanceId, title }),
    decide: (instanceId, requestId, behavior, allowAlways) =>
      ipcRenderer.invoke(IPC.agentDecide, { instanceId, requestId, behavior, allowAlways }),
    answer: (instanceId, requestId, answers, response) =>
      ipcRenderer.invoke(IPC.agentAnswer, { instanceId, requestId, answers, response }),
    setPermissionMode: (instanceId, mode) =>
      ipcRenderer.invoke(IPC.agentSetMode, { instanceId, mode }),
    models: (instanceId) => ipcRenderer.invoke(IPC.agentModels, { instanceId }),
    setModel: (instanceId, model) => ipcRenderer.invoke(IPC.agentSetModel, { instanceId, model }),
    setEffort: (instanceId, effort) => ipcRenderer.invoke(IPC.agentSetEffort, { instanceId, effort }),
    usage: (instanceId) => ipcRenderer.invoke(IPC.agentUsage, { instanceId }),
    transcript: (instanceId) => ipcRenderer.invoke(IPC.agentTranscript, { instanceId }),
    editSave: (instanceId, uuid, newText) =>
      ipcRenderer.invoke(IPC.agentEditSave, { instanceId, uuid, newText }),
    fork: (instanceId, uuid, newText) =>
      ipcRenderer.invoke(IPC.agentFork, { instanceId, uuid, newText }),
    forkPoints: (instanceId) => ipcRenderer.invoke(IPC.agentForkPoints, { instanceId }),
    switchBranch: (instanceId, sessionId) =>
      ipcRenderer.invoke(IPC.agentSwitchBranch, { instanceId, sessionId }),
    onEvent: (cb) => {
      const listener = (_e: IpcRendererEvent, evt: AgentEvent) => cb(evt)
      ipcRenderer.on(IPC.agentEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.agentEvent, listener)
      }
    }
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus)
  },
  app: {
    defaultCwd: () => ipcRenderer.invoke(IPC.appDefaultCwd),
    pickFolder: () => ipcRenderer.invoke(IPC.appPickFolder),
    openPath: (path) => ipcRenderer.invoke(IPC.appOpenPath, path)
  }
}

contextBridge.exposeInMainWorld('atelier', api)
