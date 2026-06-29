// Shared, Node-free contract between main, preload, and renderer.
// Every cross-boundary payload is validated with these Zod schemas at the receiving side.
import { z } from 'zod'
import type { DiscoveredPlugin, ConversationPluginState } from './plugins.js'

export type AgentStatus = 'idle' | 'working' | 'error' | 'closed'

// Mirrors the SDK's PermissionMode union (kept Node-free here so the renderer can use it).
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A selectable model for the chat header dropdown. */
export interface ModelOption {
  value: string
  displayName: string
  /** Shown but not selectable (e.g. not available on the current plan). */
  disabled?: boolean
  /** Effort levels this model accepts; omitted/empty = model has no effort control. */
  supportedEffortLevels?: EffortLevel[]
}

/**
 * Curated full list of selectable models (specific IDs, not just family aliases).
 * `supportedModels()` only returns aliases, so we pre-populate these and merge in
 * any additional full IDs the SDK reports at runtime. Source: claude-api reference.
 */
const FULL_EFFORT: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: EffortLevel[] = ['low', 'medium', 'high', 'max']
export const KNOWN_MODELS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: FULL_EFFORT },
  {
    value: 'claude-fable-5',
    displayName: 'Fable 5 (unavailable)',
    disabled: true,
    supportedEffortLevels: FULL_EFFORT
  },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportedEffortLevels: FULL_EFFORT },
  { value: 'claude-opus-4-7', displayName: 'Opus 4.7', supportedEffortLevels: FULL_EFFORT },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', supportedEffortLevels: NO_XHIGH },
  {
    value: 'claude-opus-4-5',
    displayName: 'Opus 4.5',
    supportedEffortLevels: ['low', 'medium', 'high']
  },
  { value: 'claude-opus-4-1', displayName: 'Opus 4.1' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', supportedEffortLevels: NO_XHIGH },
  { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' }
]

// ---- Canonical transcript (parsed from the on-disk session JSONL) ----

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_use'
      toolUseId: string
      name: string
      input: unknown
      result?: { ok: boolean; output: unknown }
    }

export interface TranscriptMessage {
  uuid: string
  role: 'user' | 'assistant'
  blocks: TranscriptBlock[]
}

/** A branch in the conversation tree (one SDK session each). */
export interface BranchInfo {
  sessionId: string
  parentSessionId?: string
  forkPointUuid?: string
  label: string
  createdAt: number
  current: boolean
}

/** Version-switch info for a divergence message: the sibling branches and which is current. */
export interface ForkPoint {
  versions: string[] // session ids, ordered (original first)
  index: number // index of the current branch within `versions`
}
/** Map of (current-branch message uuid that is a fork junction) → its ForkPoint. */
export type ForkPoints = Record<string, ForkPoint>

/** One subscription rate-limit window for the header usage bars. */
export interface UsageWindow {
  key: string
  label: string
  utilization: number // 0-100
  resetsAt?: string // ISO 8601
}
export interface UsageInfo {
  available: boolean
  subscriptionType?: string | null
  windows: UsageWindow[]
}

/** A pending tool-approval request surfaced to the UI. */
export interface PermissionRequest {
  requestId: string
  toolUseId: string
  toolName: string
  title: string
  input: unknown
  canAllowAlways: boolean
}

/** One selectable choice in an AskUserQuestion question. */
export interface QuestionOption {
  label: string
  description: string
  preview?: string
}
/** One question the agent is asking the user (AskUserQuestion tool). */
export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}
/** A pending AskUserQuestion request surfaced to the UI as an answerable card. */
export interface QuestionRequest {
  requestId: string
  toolUseId: string
  questions: Question[]
}

export interface AgentInstance {
  id: string
  cwd: string
  title: string
  sessionId?: string
  model?: string
  effort?: EffortLevel
  status: AgentStatus
}

/** A persisted conversation as listed in the dropdown (open + closed). */
export interface ConversationSummary {
  id: string
  title: string
  cwd: string
  updatedAt: number
  open: boolean
}

/** A prior Claude SDK session found in a folder (for the import/recover flow). */
export interface SessionSummary {
  sessionId: string
  summary: string
  firstPrompt?: string
  lastModified: number
}

/**
 * Normalized UI events (SPEC §3.1), emitted per instance from main → renderer.
 * The renderer renders these structured blocks directly — it never parses a TUI.
 */
export type AgentEvent =
  | {
      instanceId: string
      kind: 'system_init'
      sessionId: string
      model: string
      apiKeySource: string
      tools: string[]
    }
  | { instanceId: string; kind: 'text'; messageId: string; index: number; delta: string } // streamed
  | { instanceId: string; kind: 'thinking'; messageId: string; index: number; delta: string } // streamed
  | {
      instanceId: string
      kind: 'tool_use'
      messageId: string
      toolUseId: string
      name: string
      input: unknown
    }
  | { instanceId: string; kind: 'tool_result'; toolUseId: string; ok: boolean; output: unknown }
  | {
      instanceId: string
      kind: 'result'
      messageId: string
      costUsd?: number
      durationMs?: number
      isError: boolean
    }
  | { instanceId: string; kind: 'status'; status: AgentStatus }
  | {
      instanceId: string
      kind: 'permission_request'
      requestId: string
      toolUseId: string
      toolName: string
      title: string
      input: unknown
      canAllowAlways: boolean
    }
  | { instanceId: string; kind: 'permission_resolved'; requestId: string }
  | {
      instanceId: string
      kind: 'question_request'
      requestId: string
      toolUseId: string
      questions: Question[]
    }
  | { instanceId: string; kind: 'question_resolved'; requestId: string }
  | { instanceId: string; kind: 'permission_mode'; mode: PermissionMode }
  | { instanceId: string; kind: 'error'; message: string; detail?: unknown }

// ---- Request payloads (renderer → main), Zod-validated in main ----

export const CreateOptsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().optional(),
  title: z.string().optional()
})
export type CreateOpts = z.infer<typeof CreateOptsSchema>

export const SendSchema = z.object({
  instanceId: z.string().min(1),
  text: z.string()
})

export const InstanceRefSchema = z.object({
  instanceId: z.string().min(1)
})

export const RenameSchema = z.object({
  instanceId: z.string().min(1),
  title: z.string().min(1)
})

export const SaveLayoutSchema = z.object({
  instanceId: z.string().min(1),
  layout: z.unknown()
})

export const SessionsForSchema = z.object({ cwd: z.string().min(1) })

export const ImportSessionSchema = z.object({
  cwd: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().optional()
})

export const PermissionDecisionSchema = z.object({
  instanceId: z.string().min(1),
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  allowAlways: z.boolean().optional()
})

export const AnswerQuestionSchema = z.object({
  instanceId: z.string().min(1),
  requestId: z.string().min(1),
  // question text -> chosen label (multi-select: comma-joined labels)
  answers: z.record(z.string(), z.string()),
  response: z.string().optional()
})

export const SetPermissionModeSchema = z.object({
  instanceId: z.string().min(1),
  mode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'])
})

export const SetModelSchema = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1)
})

export const SetEffortSchema = z.object({
  instanceId: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
})

export const EditSaveSchema = z.object({
  instanceId: z.string().min(1),
  uuid: z.string().min(1),
  newText: z.string()
})

export const ForkSchema = z.object({
  instanceId: z.string().min(1),
  uuid: z.string().min(1),
  newText: z.string()
})

export const SwitchBranchSchema = z.object({
  instanceId: z.string().min(1),
  sessionId: z.string().min(1)
})

// ---- Plugin host payloads ----

export const ConversationRefSchema = z.object({ conversationId: z.string().min(1) })

export const PluginIdSchema = z.object({ pluginId: z.string().min(1) })

export const SetPluginEnabledSchema = z.object({
  conversationId: z.string().min(1),
  pluginId: z.string().min(1),
  enabled: z.boolean()
})

export const PluginStorageGetSchema = z.object({
  conversationId: z.string().min(1),
  pluginId: z.string().min(1),
  key: z.string().min(1)
})

export const PluginStorageSetSchema = z.object({
  conversationId: z.string().min(1),
  pluginId: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown()
})

export const PluginStorageKeysSchema = z.object({
  conversationId: z.string().min(1),
  pluginId: z.string().min(1)
})

// ---- Auth safety (billing) ----

export interface AuthStatus {
  /** ANTHROPIC_API_KEY was present in the launch environment. */
  apiKeyWasPresent: boolean
  /** True once an instance reports init with an oauth (subscription) credential. */
  usingSubscription: boolean
  note: string
}

// ---- IPC channel names ----

export const IPC = {
  agentCreate: 'agent:create',
  agentSend: 'agent:send',
  agentInterrupt: 'agent:interrupt',
  agentList: 'agent:list',
  agentListAll: 'agent:list-all',
  agentSessionsFor: 'agent:sessions-for',
  agentImportSession: 'agent:import-session',
  agentOpen: 'agent:open',
  agentClearChat: 'agent:clear-chat',
  agentClearPlugins: 'agent:clear-plugins',
  agentDelete: 'agent:delete',
  agentSetActive: 'agent:set-active',
  agentActiveId: 'agent:active-id',
  agentSaveLayout: 'agent:save-layout',
  agentGetLayout: 'agent:get-layout',
  agentClose: 'agent:close',
  agentRename: 'agent:rename',
  agentDecide: 'agent:decide',
  agentAnswer: 'agent:answer',
  agentSetMode: 'agent:set-mode',
  agentModels: 'agent:models',
  agentSetModel: 'agent:set-model',
  agentSetEffort: 'agent:set-effort',
  agentUsage: 'agent:usage',
  agentTranscript: 'agent:transcript',
  agentEditSave: 'agent:edit-save',
  agentFork: 'agent:fork',
  agentBranches: 'agent:branches',
  agentForkPoints: 'agent:fork-points',
  agentSwitchBranch: 'agent:switch-branch',
  pluginsList: 'plugins:list',
  pluginsEnabledFor: 'plugins:enabled-for',
  pluginsSetEnabled: 'plugins:set-enabled',
  pluginsReload: 'plugins:reload',
  pluginStorageGet: 'plugin:storage-get',
  pluginStorageSet: 'plugin:storage-set',
  pluginStorageKeys: 'plugin:storage-keys',
  authStatus: 'auth:status',
  appDefaultCwd: 'app:default-cwd',
  appPickFolder: 'app:pick-folder',
  appOpenPath: 'app:open-path',
  // push (main → renderer)
  agentEvent: 'agent:event',
  pluginsChanged: 'plugins:changed'
} as const

/** The typed surface exposed on `window.atelier` by the preload bridge. */
export interface AtelierAPI {
  agent: {
    create(opts: CreateOpts): Promise<string>
    send(instanceId: string, text: string): Promise<void>
    interrupt(instanceId: string): Promise<void>
    list(): Promise<AgentInstance[]>
    listAll(): Promise<ConversationSummary[]>
    sessionsFor(cwd: string): Promise<SessionSummary[]>
    importSession(cwd: string, sessionId: string, title?: string): Promise<string>
    open(conversationId: string): Promise<string | null>
    clearChat(instanceId: string): Promise<void>
    clearPlugins(instanceId: string): Promise<void>
    delete(conversationId: string): Promise<void>
    setActive(instanceId: string): Promise<void>
    activeId(): Promise<string | null>
    saveLayout(instanceId: string, layout: unknown): Promise<void>
    getLayout(instanceId: string): Promise<unknown>
    close(instanceId: string): Promise<void>
    rename(instanceId: string, title: string): Promise<void>
    decide(
      instanceId: string,
      requestId: string,
      behavior: 'allow' | 'deny',
      allowAlways?: boolean
    ): Promise<void>
    answer(
      instanceId: string,
      requestId: string,
      answers: Record<string, string>,
      response?: string
    ): Promise<void>
    setPermissionMode(instanceId: string, mode: PermissionMode): Promise<void>
    models(instanceId: string): Promise<ModelOption[]>
    setModel(instanceId: string, model: string): Promise<void>
    setEffort(instanceId: string, effort: EffortLevel): Promise<void>
    usage(instanceId: string): Promise<UsageInfo>
    transcript(instanceId: string): Promise<TranscriptMessage[]>
    editSave(instanceId: string, uuid: string, newText: string): Promise<TranscriptMessage[]>
    fork(instanceId: string, uuid: string, newText: string): Promise<BranchInfo[]>
    forkPoints(instanceId: string): Promise<ForkPoints>
    switchBranch(
      instanceId: string,
      sessionId: string
    ): Promise<{ transcript: TranscriptMessage[]; forkPoints: ForkPoints }>
    onEvent(cb: (e: AgentEvent) => void): () => void
  }
  plugins: {
    list(): Promise<DiscoveredPlugin[]>
    enabledFor(conversationId: string): Promise<Record<string, ConversationPluginState>>
    setEnabled(conversationId: string, pluginId: string, enabled: boolean): Promise<void>
    reload(pluginId: string): Promise<void>
    storageGet(conversationId: string, pluginId: string, key: string): Promise<unknown>
    storageSet(conversationId: string, pluginId: string, key: string, value: unknown): Promise<void>
    storageKeys(conversationId: string, pluginId: string): Promise<string[]>
    onChanged(cb: (plugins: DiscoveredPlugin[]) => void): () => void
  }
  auth: {
    status(): Promise<AuthStatus>
  }
  app: {
    defaultCwd(): Promise<string>
    pickFolder(): Promise<string | null>
    openPath(path: string): Promise<void>
  }
}
