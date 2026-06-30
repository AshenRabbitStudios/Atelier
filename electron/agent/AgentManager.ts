import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  query,
  listSessions,
  deleteSession,
  type HookInput,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  BASH_STREAM_CHANNEL,
  type AgentEvent,
  type AgentInstance,
  type AgentStatus,
  type BashStreamMessage,
  type BranchInfo,
  type CreateOpts,
  type EffortLevel,
  type ForkPoints,
  type ModelOption,
  type Question,
  type SessionSummary,
  type TranscriptMessage,
  type UsageInfo,
  type UsageWindow
} from '../shared/events.js'
import type { ConversationPluginState } from '../shared/plugins.js'
import { readTranscript, editMessageText, parentUuidOf, childUuidOf } from './sessionStore.js'
import { bashResponseText, type BashPublish } from './bashTap.js'
import {
  listConversations,
  saveConversation,
  getActiveConversationId,
  setActiveConversationId,
  getOpenConversationIds,
  setOpenConversationIds,
  getLastUsage,
  setLastUsage,
  clearPluginData,
  deleteConversationData,
  type ConversationManifest,
  type PersistedBranch
} from '../conversationStore.js'

interface RestoreData {
  id: string
  sessionId?: string
  branches?: PersistedBranch[]
  createdAt?: number
  effort?: EffortLevel
  layout?: unknown
  plugins?: Record<string, ConversationPluginState>
}

/**
 * Minimal async queue used as the streaming `prompt` for a long-lived `query()`.
 * Pushing a user message resolves the iterator, keeping one SDK session alive
 * across turns (multi-turn streaming input mode).
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null
  private done = false

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    }
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: msg, done: false })
    } else {
      this.items.push(msg)
    }
  }

  end(): void {
    this.done = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined as unknown as SDKUserMessage, done: true })
    }
  }

  /** A message has been queued (e.g. sent while a turn was running) but not yet consumed. */
  hasPending(): boolean {
    return this.items.length > 0
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!
        continue
      }
      if (this.done) return
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiter = resolve
      })
      if (next.done) return
      yield next.value
    }
  }
}

// Narrow views over the Anthropic streaming/content shapes we actually read.
// Kept local + defensive so a minor SDK version drift can't crash the pump.
// Models that accept adaptive thinking (claude-api reference). For these we force summarized
// display so the chain of reasoning is visible — Opus 4.8/4.7/Fable default `display` to 'omitted'
// (empty thinking blocks). Older models (Opus 4.1, Sonnet 4.5, Haiku 4.5) only take budget_tokens
// thinking and would reject `type: 'adaptive'`, so for those we leave `thinking` unset and let the
// claude_code preset's default stand. 'default'/unset resolves to the recommended (adaptive) model.
const ADAPTIVE_THINKING_MODELS = new Set([
  'default',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6'
])

// Sent automatically (no user action) when a usage-limit interrupt clears and auto-resume is on.
const AUTO_RESUME_PROMPT = 'Tokens are back — resume where you left off.'
// Never schedule a wake-up further out than this (guards against a bogus/huge resetsAt).
const AUTO_RESUME_MAX_MS = 8 * 24 * 60 * 60 * 1000
// Small cushion past the reported reset so a little clock skew doesn't trigger an instant re-reject.
const AUTO_RESUME_BUFFER_MS = 8000

interface StreamEvent {
  type: string
  index?: number
  message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  delta?: { type?: string; text?: string; thinking?: string }
  usage?: { input_tokens?: number; output_tokens?: number } // on message_delta (cumulative output)
}
interface ContentBlock {
  type: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** Supplies the per-turn context block + the per-conversation MCP tool server (context plugins). */
type ContextProvider = (
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>
) => string
type McpProvider = (
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>
) => Options['mcpServers'] | undefined
/** Supplies the standing instruction appended to the system prompt (instructions plugin). */
type InstructionProvider = (
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>
) => string

/** One isolated agent instance: its own cwd, SDK session, and transcript stream. */
class Session {
  readonly id: string
  cwd: string
  title: string
  model?: string
  effort?: EffortLevel
  layout?: unknown
  // Permission mode (e.g. bypass approvals). Remembered so it survives a rebind — buildOptions
  // reapplies it, instead of every clear-chat/fork/effort change silently reverting to 'default'.
  permissionMode: PermissionMode = 'default'
  pluginState: Record<string, ConversationPluginState> = {}
  sessionId?: string
  status: AgentStatus = 'idle'
  readonly createdAt: number
  /** Called whenever persistent state changes, so the manager can save the manifest. */
  onChange?: () => void
  /** Context-plugin hooks (set by the manager): per-turn injection + per-conversation tools. */
  contextProvider?: ContextProvider
  mcpProvider?: McpProvider
  instructionProvider?: InstructionProvider
  /** Ambient Bash tap: publishes the agent's real shell I/O onto the bash-stream DataBus channel. */
  bashProvider?: BashPublish

  private input = new InputQueue()
  // Auto-resume: when on, a usage-limit interrupt schedules a one-shot wake-up at the reported reset
  // time that re-sends the resume prompt — no polling, no queries to Claude while limited.
  private autoResume = false
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  // The instruction string baked into the live query's systemPrompt. Compared on each send so we
  // only rebind (and pay the one-time history cache invalidation) when it actually changes.
  private appliedInstruction = ''
  private q!: Query
  private currentMessageId = ''
  // Live token usage for the in-flight turn (reset each send). Output is summed across the turn's
  // assistant messages (cumulative within a message via message_delta, rolled over on message_start).
  private turnInputTokens = 0
  private turnOutputTokens = 0
  private curMsgOutTokens = 0
  private restarts = 0
  private closed = false
  // Set when the user presses Stop; lets the next `result` render as a clean
  // "stopped" turn instead of the abort's internal `[ede_diagnostic]` error.
  private interrupted = false
  // Identifies the live query. A rebind bumps it so the previous pump (which throws
  // when its query is closed) goes quiet instead of triggering error recovery.
  private activeToken = 0
  // Conversation branch tree (one SDK session per branch). `sessionId` is the active branch.
  private branches: {
    sessionId: string
    parentSessionId?: string
    forkPointUuid?: string
    forkAnchorUuid?: string | null
    label: string
    createdAt: number
  }[] = []
  private pendingFork?: {
    parentSessionId: string
    forkPointUuid: string
    forkAnchorUuid: string | null
  }
  // Tool-approval requests awaiting a user decision from the renderer.
  private pending = new Map<
    string,
    {
      resolve: (r: PermissionResult) => void
      input: Record<string, unknown>
      suggestions?: PermissionUpdate[]
      isQuestion?: boolean
    }
  >()

  constructor(
    opts: CreateOpts,
    private emit: (e: AgentEvent) => void,
    restore?: RestoreData,
    hooks?: {
      context?: ContextProvider
      mcp?: McpProvider
      instruction?: InstructionProvider
      bash?: BashPublish
    }
  ) {
    // Set before start() so a restored conversation's context tools are present on the first query.
    this.contextProvider = hooks?.context
    this.mcpProvider = hooks?.mcp
    this.instructionProvider = hooks?.instruction
    this.bashProvider = hooks?.bash
    this.id = restore?.id ?? randomUUID()
    this.cwd = opts.cwd
    this.title = opts.title ?? (basename(opts.cwd) || opts.cwd)
    this.model = opts.model
    this.createdAt = restore?.createdAt ?? Date.now()
    this.effort = restore?.effort
    this.layout = restore?.layout
    if (restore?.plugins) this.pluginState = restore.plugins
    if (restore?.sessionId) this.sessionId = restore.sessionId
    if (restore?.branches) this.branches = restore.branches
    this.start() // resumes this.sessionId (the active branch) when restoring
  }

  toManifest(): ConversationManifest {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      layout: this.layout,
      plugins: this.pluginState,
      branches: this.branches,
      activeBranch: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: Date.now()
    }
  }

  setLayout(layout: unknown): void {
    this.layout = layout
    this.onChange?.()
  }

  /** Enable/disable a plugin for THIS conversation; auto-pin its context exports. Rebinds so the
   *  SDK query picks up (or drops) the plugin's generated tools. */
  setPluginEnabled(pluginId: string, enabled: boolean, exportKeys: string[]): void {
    this.pluginState[pluginId] = { enabled, pinnedExports: enabled ? exportKeys : [] }
    this.onChange?.()
    if (exportKeys.length > 0) this.rebind() // tool set changed
  }

  pluginStateFor(): Record<string, ConversationPluginState> {
    return this.pluginState
  }

  private buildOptions(opts?: { resumeAt?: string; fork?: boolean }): Options {
    // Standing instruction (instructions plugin) appended to the system prompt. Read here and
    // remembered so `send()` can detect a change and rebind; unchanged → byte-identical prefix →
    // stays prompt-cached across turns (docs/CONTEXT_SYSTEM.md).
    const append = (this.instructionProvider?.(this.id, this.pluginState) ?? '').trim()
    this.appliedInstruction = append
    return {
      cwd: this.cwd,
      includePartialMessages: true,
      // Stream a readable summary of the model's reasoning into the thinking block. Opus 4.8/4.7
      // default `display` to 'omitted' — thinking still happens (and is billed the same), but the
      // blocks arrive empty, so a long reasoning phase shows only a bare "Thinking…" spinner. With
      // 'summarized' the chain of reasoning streams live into the (auto-expanding) thinking block.
      // Only for adaptive-capable models; older models reject `type: 'adaptive'`.
      ...(ADAPTIVE_THINKING_MODELS.has(this.model || 'default')
        ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
        : {}),
      // Load this project's CLAUDE.md (requires the claude_code preset too); append the standing
      // instruction (if any) after it so it shares the same cached system block.
      settingSources: ['project'],
      systemPrompt: append
        ? { type: 'preset', preset: 'claude_code', append }
        : { type: 'preset', preset: 'claude_code' },
      // Route every approval prompt to the UI; default to asking, never auto-allow.
      canUseTool: (toolName, input, ctx) => this.requestPermission(toolName, input, ctx),
      // Permit switching to bypass mode at runtime via the UI toggle.
      allowDangerouslySkipPermissions: true,
      // Reapply the remembered mode so bypass survives a rebind (clear chat / fork / effort).
      permissionMode: this.permissionMode,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      // Context plugins: register one update tool per pinned export (or nothing).
      ...(() => {
        const servers = this.mcpProvider?.(this.id, this.pluginState)
        return servers ? { mcpServers: servers } : {}
      })(),
      // Ambient Bash tap: observe (never block) Bash tool calls and stream their I/O to the pane.
      ...(this.bashProvider ? { hooks: this.buildBashHooks(this.bashProvider) } : {}),
      // Resume the active branch's session so history is preserved.
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      ...(opts?.resumeAt ? { resumeSessionAt: opts.resumeAt } : {}),
      ...(opts?.fork ? { forkSession: true } : {})
    }
  }

  /**
   * Read-only Pre/PostToolUse hooks scoped to the Bash tool. PreToolUse announces the command;
   * PostToolUse(/Failure) publishes its full output (ANSI intact) — there is no streaming-stdout
   * hook, so this is command-granular (see docs/SDK_NOTES.md). Hooks return `{ continue: true }`
   * so the tap never blocks execution; permission still flows through `canUseTool`.
   */
  private buildBashHooks(publish: BashPublish): Options['hooks'] {
    const tap = (msg: BashStreamMessage): void => publish(this.id, BASH_STREAM_CHANNEL, msg)
    return {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash') {
                const cmd = (input.tool_input as { command?: unknown })?.command
                tap({
                  toolUseId: input.tool_use_id,
                  phase: 'start',
                  command: typeof cmd === 'string' ? cmd : ''
                })
              }
              return { continue: true }
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Bash') {
                tap({
                  toolUseId: input.tool_use_id,
                  phase: 'output',
                  text: bashResponseText(input.tool_response)
                })
              }
              return { continue: true }
            }
          ]
        }
      ],
      PostToolUseFailure: [
        {
          matcher: 'Bash',
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name === 'PostToolUseFailure' && input.tool_name === 'Bash') {
                tap({ toolUseId: input.tool_use_id, phase: 'error', text: input.error })
              }
              return { continue: true }
            }
          ]
        }
      ]
    }
  }

  private start(opts?: { resumeAt?: string; fork?: boolean }): void {
    const token = ++this.activeToken
    this.q = query({ prompt: this.input, options: this.buildOptions(opts) })
    void this.pump(token, this.q)
  }

  /** Tear down the live query and start a fresh one (resume/fork/switch all use this). */
  private rebind(opts?: { resumeAt?: string; fork?: boolean }): void {
    try {
      this.q.close()
    } catch {
      /* already dead */
    }
    this.input = new InputQueue()
    this.start(opts)
  }

  /**
   * The SDK's async iterator throws (and the query() generator dies) when a turn
   * fails terminally — e.g. an unavailable model. Re-establish a live query so the
   * instance recovers instead of silently swallowing every later message. Bounded
   * so a persistently-failing startup can't loop forever.
   */
  private restart(): void {
    if (this.closed) return
    if (this.restarts >= 3) {
      this.emit({
        instanceId: this.id,
        kind: 'error',
        message: 'Agent stopped after repeated errors. Close and reopen this instance.'
      })
      this.setStatus('error')
      return
    }
    this.restarts++
    this.rebind()
    this.setStatus('idle')
  }

  // ---- Editable history / branches ----

  getTranscript(): TranscriptMessage[] {
    return this.sessionId ? readTranscript(this.sessionId) : []
  }

  branchSessionIds(): string[] {
    return this.branches.map((b) => b.sessionId)
  }

  /** Clear chat context: abandon the current branches and start a fresh SDK session. */
  clearChat(): void {
    this.clearResumeTimer() // a pending limit wake-up belongs to the old session
    this.sessionId = undefined
    this.branches = []
    this.currentMessageId = ''
    this.pendingFork = undefined
    this.setStatus('idle')
    this.onChange?.()
    // Defer the (potentially heavy) query teardown+rebuild off this IPC handler so the main
    // process can forward queued keyboard/mouse input first — a synchronous rebuild here freezes
    // input in Electron. The renderer has already reset the view to empty; the fresh session
    // initializes a tick later.
    setImmediate(() => {
      if (!this.closed) this.rebind() // no resume → fresh session; init creates a new 'main' branch
    })
  }

  /** Save: edit a message's text on disk (no regen), then rebind so the SDK reloads it. */
  saveEdit(uuid: string, newText: string): TranscriptMessage[] {
    if (!this.sessionId) return []
    editMessageText(this.sessionId, uuid, newText)
    this.rebind()
    return readTranscript(this.sessionId)
  }

  /** Fork (user messages): branch a new session at `uuid` and run `newText` on it. */
  fork(uuid: string, newText: string): BranchInfo[] {
    if (!this.sessionId) return this.listBranches()
    // Resume just BEFORE the edited message so the new text replaces it (rather
    // than appending after it), then regenerate on the new branch.
    const parent = parentUuidOf(this.sessionId, uuid)
    this.pendingFork = {
      parentSessionId: this.sessionId,
      forkPointUuid: uuid,
      forkAnchorUuid: parent
    }
    this.rebind({ resumeAt: parent ?? uuid, fork: true })
    this.setStatus('working')
    this.input.push(newText)
    return this.listBranches()
  }

  switchBranch(sessionId: string): { transcript: TranscriptMessage[]; forkPoints: ForkPoints } {
    if (this.branches.some((b) => b.sessionId === sessionId) && sessionId !== this.sessionId) {
      this.sessionId = sessionId
      this.rebind()
    }
    return { transcript: this.getTranscript(), forkPoints: this.getForkPoints() }
  }

  listBranches(): BranchInfo[] {
    return this.branches.map((b) => ({ ...b, current: b.sessionId === this.sessionId }))
  }

  /**
   * Per-message version switchers for the CURRENT branch. Forks sharing a divergence
   * anchor form one version group; the switcher attaches to that branch's child-of-anchor
   * message (the divergence message), which differs per branch but maps to one group.
   */
  getForkPoints(): ForkPoints {
    if (!this.sessionId) return {}
    const groups = new Map<string, { base: string; forks: string[] }>()
    for (const b of this.branches) {
      if (b.forkAnchorUuid === undefined || !b.parentSessionId) continue
      const key = b.forkAnchorUuid ?? '__root__'
      const g = groups.get(key) ?? { base: b.parentSessionId, forks: [] }
      g.forks.push(b.sessionId)
      groups.set(key, g)
    }
    const out: ForkPoints = {}
    for (const [key, g] of groups) {
      const anchor = key === '__root__' ? null : key
      const childUuid = childUuidOf(this.sessionId, anchor)
      if (!childUuid) continue
      const versions = [g.base, ...g.forks]
      const index = Math.max(0, versions.indexOf(this.sessionId))
      out[childUuid] = { versions, index }
    }
    return out
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      signal: AbortSignal
      toolUseID: string
      title?: string
      suggestions?: PermissionUpdate[]
    }
  ): Promise<PermissionResult> {
    const requestId = randomUUID()
    // AskUserQuestion is the agent asking the USER — surface it as an answerable
    // question card, not an Allow/Deny approval. The answer is delivered by allowing
    // the tool with an `answers` map merged into its input (verified — see SDK_NOTES).
    const isQuestion = toolName === 'AskUserQuestion'
    return new Promise<PermissionResult>((resolve) => {
      const settle = (r: PermissionResult) => {
        if (this.pending.delete(requestId)) resolve(r)
      }
      this.pending.set(requestId, {
        resolve: settle,
        input,
        suggestions: ctx.suggestions,
        isQuestion
      })

      ctx.signal.addEventListener('abort', () => {
        if (!this.pending.has(requestId)) return
        if (isQuestion) {
          // Allow with no answers => the tool reports "user did not answer" (graceful skip).
          this.emit({ instanceId: this.id, kind: 'question_resolved', requestId })
          settle({ behavior: 'allow', updatedInput: input })
        } else {
          this.emit({ instanceId: this.id, kind: 'permission_resolved', requestId })
          settle({ behavior: 'deny', message: 'Request aborted.' })
        }
      })

      if (isQuestion) {
        this.emit({
          instanceId: this.id,
          kind: 'question_request',
          requestId,
          toolUseId: ctx.toolUseID,
          questions: parseQuestions(input)
        })
      } else {
        this.emit({
          instanceId: this.id,
          kind: 'permission_request',
          requestId,
          toolUseId: ctx.toolUseID,
          toolName,
          title: ctx.title ?? toolName,
          input,
          canAllowAlways: Boolean(ctx.suggestions && ctx.suggestions.length > 0)
        })
      }
    })
  }

  /** Resolve an AskUserQuestion: allow the tool with the user's choices merged in. */
  answer(requestId: string, answers: Record<string, string>, response?: string): void {
    const p = this.pending.get(requestId)
    if (!p) return
    p.resolve({
      behavior: 'allow',
      updatedInput: { ...p.input, answers, ...(response ? { response } : {}) }
    })
  }

  decide(requestId: string, behavior: 'allow' | 'deny', allowAlways?: boolean): void {
    const p = this.pending.get(requestId)
    if (!p) return
    if (behavior === 'allow') {
      // This SDK build's runtime schema requires `updatedInput` on allow; echo the
      // original input back unchanged (= "allow as-is").
      p.resolve({
        behavior: 'allow',
        updatedInput: p.input,
        ...(allowAlways && p.suggestions?.length ? { updatedPermissions: p.suggestions } : {})
      })
    } else {
      p.resolve({ behavior: 'deny', message: 'Denied by user.' })
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode // remember it so a later rebind keeps it
    await this.q.setPermissionMode(mode)
    this.emit({ instanceId: this.id, kind: 'permission_mode', mode })
  }

  /** Toggle auto-resume. Turning it off cancels any pending wake-up. */
  setAutoResume(enabled: boolean): void {
    this.autoResume = enabled
    if (!enabled) this.clearResumeTimer()
  }

  private clearResumeTimer(): void {
    if (!this.resumeTimer) return
    clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    this.emit({ instanceId: this.id, kind: 'auto_resume', resetsAt: null })
  }

  /**
   * Schedule a single wake-up at the usage-limit reset time, then auto-send the resume prompt.
   * `resetsAt` is the SDK's rate-limit reset (seconds or ms epoch). We wait it out with one timer —
   * no polling and no queries to Claude while limited; the only request is the resume itself, after
   * the limit has cleared. If the limit is somehow still active then, that turn rejects again and
   * reschedules to the next reset, so it self-corrects without ever spamming.
   */
  private scheduleAutoResume(resetsAt: number): void {
    const resetMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt
    const delay = Math.min(
      AUTO_RESUME_MAX_MS,
      Math.max(0, resetMs - Date.now()) + AUTO_RESUME_BUFFER_MS
    )
    this.clearResumeTimer()
    this.emit({ instanceId: this.id, kind: 'auto_resume', resetsAt: resetMs })
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (this.closed || !this.autoResume) return
      this.emit({ instanceId: this.id, kind: 'auto_resume', resetsAt: null })
      this.send(AUTO_RESUME_PROMPT)
    }, delay)
  }

  async models(): Promise<ModelOption[]> {
    const list = await this.q.supportedModels()
    return list.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      ...(m.supportedEffortLevels ? { supportedEffortLevels: m.supportedEffortLevels } : {})
    }))
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model)
    this.model = model
    this.onChange?.()
  }

  /** Change reasoning effort (rebinds so it carries across restarts; supports all levels). */
  setEffort(effort: EffortLevel): void {
    this.effort = effort
    this.rebind()
    this.onChange?.()
  }

  /**
   * Subscription rate-limit windows. Experimental SDK API whose runtime shape drifts
   * from its types: the populated data is usually in `rate_limits.limits[]`, while the
   * typed `five_hour`/`seven_day` keys are often undefined (e.g. on an idle session).
   * Read both, timeout-guard the call so it can never hang the poller.
   */
  async usage(): Promise<UsageInfo> {
    const label = (k: string): string =>
      (
        ({
          session: '5h',
          five_hour: '5h',
          weekly_all: '7d',
          seven_day: '7d',
          weekly_opus: '7d Opus',
          seven_day_opus: '7d Opus',
          weekly_sonnet: '7d Sonnet',
          seven_day_sonnet: '7d Sonnet',
          weekly_oauth_apps: '7d Apps',
          seven_day_oauth_apps: '7d Apps'
        }) as Record<string, string>
      )[k] ?? k
    try {
      const r = await Promise.race([
        this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('usage timeout')), 8000))
      ])
      const rl = r?.rate_limits as Record<string, unknown> | null | undefined
      if (!r?.rate_limits_available || !rl) return { available: false, windows: [] }
      const windows: UsageWindow[] = []

      // Primary: the limits[] array (present even when the typed keys are not).
      const limits = Array.isArray(rl.limits) ? (rl.limits as Record<string, unknown>[]) : []
      for (const l of limits) {
        if (l && typeof l.percent === 'number') {
          const kind = String(l.kind ?? l.group ?? 'limit')
          windows.push({
            key: kind,
            label: label(kind),
            utilization: l.percent,
            resetsAt: typeof l.resets_at === 'string' ? l.resets_at : undefined
          })
        }
      }

      // Fallback: the typed window objects.
      if (windows.length === 0) {
        for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
          const w = rl[key] as
            { utilization?: number; resets_at?: string | null } | null | undefined
          if (w && typeof w.utilization === 'number') {
            windows.push({
              key,
              label: label(key),
              utilization: w.utilization,
              resetsAt: w.resets_at ?? undefined
            })
          }
        }
      }

      return {
        available: true,
        subscriptionType: (r as { subscription_type?: string }).subscription_type ?? null,
        windows
      }
    } catch {
      return { available: false, windows: [] }
    }
  }

  send(text: string): void {
    this.interrupted = false
    // Fresh token count for this query (the live "N tokens" readout).
    this.turnInputTokens = 0
    this.turnOutputTokens = 0
    this.curMsgOutTokens = 0
    this.emitTokens()
    // If the standing instruction changed since the live query started, rebind first so the new
    // systemPrompt takes effect this turn. Resume preserves history; only this turn re-reads the
    // (now-changed) prefix uncached. No change → no rebind → the prefix stays cached.
    const want = (this.instructionProvider?.(this.id, this.pluginState) ?? '').trim()
    if (want !== this.appliedInstruction) this.rebind()
    this.setStatus('working')
    // Prepend the pinned context-plugin state so the agent sees its model/memory/plan each turn.
    // The block is stripped from the displayed transcript by sessionStore (kept out of history).
    const ctx = this.contextProvider?.(this.id, this.pluginState) ?? ''
    this.input.push(ctx ? `${ctx}\n\n${text}` : text)
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
    try {
      await this.q.interrupt()
    } catch (err) {
      this.emit({ instanceId: this.id, kind: 'error', message: errMsg(err) })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.clearResumeTimer()
    this.input.end()
    try {
      this.q.close()
    } catch {
      /* already closed */
    }
    this.setStatus('closed')
  }

  toInstance(): AgentInstance {
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      sessionId: this.sessionId,
      model: this.model,
      effort: this.effort,
      status: this.status
    }
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.emit({ instanceId: this.id, kind: 'status', status })
  }

  private async pump(token: number, q: Query): Promise<void> {
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (token !== this.activeToken) return // superseded by a rebind
        this.handle(msg)
      }
    } catch (err) {
      if (token !== this.activeToken) return // this query was intentionally closed
      // Terminal turn error (e.g. unavailable model) — surface it, then recover.
      this.emit({ instanceId: this.id, kind: 'error', message: errMsg(err) })
      this.setStatus('error')
      this.restart()
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system': {
        if ('subtype' in msg && msg.subtype === 'init') {
          const sid = msg.session_id
          if (this.pendingFork) {
            this.branches.push({
              sessionId: sid,
              parentSessionId: this.pendingFork.parentSessionId,
              forkPointUuid: this.pendingFork.forkPointUuid,
              forkAnchorUuid: this.pendingFork.forkAnchorUuid,
              label: `fork ${this.branches.length}`,
              createdAt: Date.now()
            })
            this.pendingFork = undefined
          } else if (this.branches.length === 0) {
            this.branches.push({ sessionId: sid, label: 'main', createdAt: Date.now() })
          }
          this.sessionId = sid
          this.model = msg.model
          this.emit({
            instanceId: this.id,
            kind: 'system_init',
            sessionId: sid,
            model: msg.model,
            apiKeySource: msg.apiKeySource,
            tools: msg.tools
          })
          this.onChange?.() // sessionId / branch tree / model may have changed
        }
        break
      }
      case 'stream_event': {
        this.handleStreamEvent(msg.event as unknown as StreamEvent)
        break
      }
      case 'assistant': {
        // Surface a model-level error (e.g. model_not_found, billing_error).
        if (msg.error) {
          this.emit({
            instanceId: this.id,
            kind: 'error',
            message: `Model error: ${msg.error}`,
            detail: { error: msg.error }
          })
        }
        // Authoritative copy: emit tool_use blocks here (complete inputs).
        const id = msg.message.id ?? this.currentMessageId
        for (const block of (msg.message.content as unknown as ContentBlock[]) ?? []) {
          if (block.type === 'tool_use') {
            this.emit({
              instanceId: this.id,
              kind: 'tool_use',
              messageId: id,
              toolUseId: block.id ?? '',
              name: block.name ?? 'tool',
              input: block.input
            })
          }
        }
        break
      }
      case 'user': {
        // Tool results are delivered as user messages with tool_result blocks.
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content as unknown as ContentBlock[]) {
            if (block.type === 'tool_result') {
              this.emit({
                instanceId: this.id,
                kind: 'tool_result',
                toolUseId: block.tool_use_id ?? '',
                ok: block.is_error !== true,
                output: block.content
              })
            }
          }
        }
        break
      }
      case 'result': {
        // A user-pressed Stop arrives as an aborted result whose only `errors` are
        // internal `[ede_diagnostic]` notes — not a real failure. Render it as a
        // clean "stopped" turn, not a red error pane.
        const reason =
          'terminal_reason' in msg
            ? (msg as { terminal_reason?: string }).terminal_reason
            : undefined
        const aborted = this.interrupted || reason === 'aborted_streaming'
        this.interrupted = false
        const isError = !aborted && (msg.is_error || msg.subtype !== 'success')
        this.emit({
          instanceId: this.id,
          kind: 'result',
          messageId: this.currentMessageId,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          isError
        })
        if (isError) {
          // Surface only concrete, actionable errors; drop internal diagnostics
          // (`[ede_diagnostic] …`). The authoritative reason for a hard failure
          // otherwise arrives as a thrown error (handled in pump()).
          const errs = ('errors' in msg && Array.isArray(msg.errors) ? msg.errors : []).filter(
            (e): e is string => typeof e === 'string' && !e.startsWith('[ede_diagnostic]')
          )
          if (errs.length) {
            this.emit({ instanceId: this.id, kind: 'error', message: errs.join('\n'), detail: msg })
          }
        } else {
          this.restarts = 0 // a clean (or cleanly-stopped) turn means we're healthy
        }
        // Stay 'working' if the user queued another message while this turn ran — the SDK reads
        // it next, so the activity indicator should persist through the queued turn.
        this.setStatus(this.input.hasPending() ? 'working' : 'idle')
        this.onChange?.() // bump updatedAt; persist any new branch from this turn
        break
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        if (info?.status === 'rejected') {
          this.emit({
            instanceId: this.id,
            kind: 'error',
            message: 'Request blocked: usage limit reached for your plan.',
            detail: info
          })
          this.setStatus('idle')
          // If the user opted in, wake up at the reset time and resume — no polling meanwhile.
          if (this.autoResume && typeof info.resetsAt === 'number') {
            this.scheduleAutoResume(info.resetsAt)
          }
        }
        break
      }
      case 'auth_status': {
        if (msg.error) {
          this.emit({
            instanceId: this.id,
            kind: 'error',
            message: `Auth error: ${msg.error}`,
            detail: msg
          })
          this.setStatus('error')
        }
        break
      }
    }
  }

  private emitTokens(): void {
    this.emit({
      instanceId: this.id,
      kind: 'tokens',
      output: this.turnOutputTokens + this.curMsgOutTokens,
      input: this.turnInputTokens
    })
  }

  private handleStreamEvent(ev: StreamEvent): void {
    switch (ev.type) {
      case 'message_start':
        this.currentMessageId = ev.message?.id ?? this.currentMessageId
        // Roll the previous message's output into the turn total, then start the new message.
        this.turnOutputTokens += this.curMsgOutTokens
        this.curMsgOutTokens = 0
        if (typeof ev.message?.usage?.input_tokens === 'number') {
          this.turnInputTokens += ev.message.usage.input_tokens
        }
        this.emitTokens()
        break
      case 'message_delta':
        // Cumulative output tokens for the current message (includes thinking) — the live counter.
        if (typeof ev.usage?.output_tokens === 'number') {
          this.curMsgOutTokens = ev.usage.output_tokens
          this.emitTokens()
        }
        break
      case 'content_block_delta': {
        const index = ev.index ?? 0
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.emit({
            instanceId: this.id,
            kind: 'text',
            messageId: this.currentMessageId,
            index,
            delta: ev.delta.text
          })
        } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          this.emit({
            instanceId: this.id,
            kind: 'thinking',
            messageId: this.currentMessageId,
            index,
            delta: ev.delta.thinking
          })
        }
        break
      }
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Defensively read the AskUserQuestion tool input into our `Question[]` shape. */
function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  return raw.map((q) => {
    const o = (q ?? {}) as Record<string, unknown>
    const opts = Array.isArray(o.options) ? o.options : []
    return {
      question: String(o.question ?? ''),
      header: String(o.header ?? ''),
      multiSelect: Boolean(o.multiSelect),
      options: opts.map((op) => {
        const oo = (op ?? {}) as Record<string, unknown>
        return {
          label: String(oo.label ?? ''),
          description: String(oo.description ?? ''),
          ...(typeof oo.preview === 'string' ? { preview: oo.preview } : {})
        }
      })
    }
  })
}

/**
 * Owns N isolated agent sessions. P0 uses one; the registry is N-ready so P1
 * can add instances without reshaping this.
 */
export class AgentManager {
  private sessions = new Map<string, Session>()
  // Rate limits are account-wide; cache the last non-empty snapshot so every
  // conversation (even idle/just-restored ones) can show bars immediately.
  private lastUsage: UsageInfo | null = null

  constructor(
    private emit: (e: AgentEvent) => void,
    private contextProvider?: ContextProvider,
    private mcpProvider?: McpProvider,
    private instructionProvider?: InstructionProvider,
    private bashPublish?: BashPublish
  ) {}

  /** The plugin hooks passed into every new/restored Session constructor. */
  private hooks(): {
    context?: ContextProvider
    mcp?: McpProvider
    instruction?: InstructionProvider
    bash?: BashPublish
  } {
    return {
      context: this.contextProvider,
      mcp: this.mcpProvider,
      instruction: this.instructionProvider,
      bash: this.bashPublish
    }
  }

  private persist(s: Session): void {
    saveConversation(s.toManifest())
  }

  /** Record which conversations are currently "open" (live in RAM + tabbed). */
  private syncOpen(): void {
    setOpenConversationIds([...this.sessions.keys()])
  }

  private restoreOne(m: ConversationManifest): Session {
    const s = new Session(
      { cwd: m.cwd, title: m.title, model: m.model },
      this.emit,
      {
        id: m.id,
        sessionId: m.activeBranch,
        branches: m.branches,
        createdAt: m.createdAt,
        effort: m.effort,
        layout: m.layout,
        plugins: m.plugins
      },
      this.hooks()
    )
    s.onChange = () => this.persist(s)
    this.sessions.set(s.id, s)
    return s
  }

  /** On launch, bring back only the conversations that were open last session. */
  restore(): void {
    this.lastUsage = (getLastUsage() as UsageInfo | null) ?? null
    const open = new Set(getOpenConversationIds())
    for (const m of listConversations()) {
      if (open.has(m.id) && !this.sessions.has(m.id)) this.restoreOne(m)
    }
  }

  create(opts: CreateOpts): string {
    const s = new Session(opts, this.emit, undefined, this.hooks())
    s.onChange = () => this.persist(s)
    this.sessions.set(s.id, s)
    this.persist(s)
    this.syncOpen()
    setActiveConversationId(s.id)
    return s.id
  }

  /** Reopen a closed conversation (recreate its live session) and return its id. */
  open(conversationId: string): string | null {
    if (this.sessions.has(conversationId)) return conversationId
    const m = listConversations().find((c) => c.id === conversationId)
    if (!m) return null
    this.restoreOne(m)
    this.syncOpen()
    return m.id
  }

  /** Prior Claude SDK sessions in a folder (to recover pre-persistence conversations). */
  async sessionsFor(cwd: string): Promise<SessionSummary[]> {
    try {
      const sessions = await listSessions({ dir: cwd, limit: 50 })
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.customTitle ?? s.summary,
        firstPrompt: s.firstPrompt,
        lastModified: s.lastModified
      }))
    } catch {
      return []
    }
  }

  /** Adopt an existing SDK session as a new conversation (its 'main' branch). */
  importSession(cwd: string, sessionId: string, title?: string): string {
    const m: ConversationManifest = {
      id: randomUUID(),
      title: title ?? (basename(cwd) || cwd),
      cwd,
      branches: [{ sessionId, label: 'main', createdAt: Date.now() }],
      activeBranch: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const s = this.restoreOne(m)
    this.persist(s)
    this.syncOpen()
    setActiveConversationId(s.id)
    return s.id
  }

  /** All persisted conversations (open + closed) for the dropdown. */
  listAll(): { id: string; title: string; cwd: string; updatedAt: number; open: boolean }[] {
    return listConversations().map((m) => ({
      id: m.id,
      title: m.title,
      cwd: m.cwd,
      updatedAt: m.updatedAt,
      open: this.sessions.has(m.id)
    }))
  }

  clearChat(instanceId: string): void {
    this.require(instanceId).clearChat()
  }

  /** Permanently delete a conversation: its SDK transcripts + manifest + plugin data. */
  async deleteConversation(id: string): Promise<void> {
    let cwd: string | undefined
    let sessionIds: string[] = []
    const s = this.sessions.get(id)
    if (s) {
      cwd = s.cwd
      sessionIds = s.branchSessionIds()
      await s.close()
      this.sessions.delete(id)
    } else {
      const m = listConversations().find((c) => c.id === id)
      if (m) {
        cwd = m.cwd
        sessionIds = m.branches.map((b) => b.sessionId)
      }
    }
    for (const sid of sessionIds) {
      try {
        await deleteSession(sid, cwd ? { dir: cwd } : undefined)
      } catch {
        /* transcript already gone */
      }
    }
    deleteConversationData(id)
    this.syncOpen()
  }

  clearPlugins(instanceId: string): void {
    clearPluginData(instanceId)
  }

  setActive(instanceId: string): void {
    if (this.sessions.has(instanceId)) setActiveConversationId(instanceId)
  }

  activeId(): string | null {
    return getActiveConversationId()
  }

  send(instanceId: string, text: string): void {
    this.require(instanceId).send(text)
  }

  async interrupt(instanceId: string): Promise<void> {
    await this.require(instanceId).interrupt()
  }

  rename(instanceId: string, title: string): void {
    const s = this.require(instanceId)
    s.title = title
    this.persist(s)
  }

  decide(
    instanceId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    allowAlways?: boolean
  ): void {
    this.require(instanceId).decide(requestId, behavior, allowAlways)
  }

  answer(
    instanceId: string,
    requestId: string,
    answers: Record<string, string>,
    response?: string
  ): void {
    this.require(instanceId).answer(requestId, answers, response)
  }

  async setPermissionMode(instanceId: string, mode: PermissionMode): Promise<void> {
    await this.require(instanceId).setPermissionMode(mode)
  }

  setAutoResume(instanceId: string, enabled: boolean): void {
    this.require(instanceId).setAutoResume(enabled)
  }

  async models(instanceId: string): Promise<{ value: string; displayName: string }[]> {
    return this.require(instanceId).models()
  }

  async setModel(instanceId: string, model: string): Promise<void> {
    await this.require(instanceId).setModel(model)
  }

  setEffort(instanceId: string, effort: EffortLevel): void {
    this.require(instanceId).setEffort(effort)
  }

  setLayout(instanceId: string, layout: unknown): void {
    this.require(instanceId).setLayout(layout)
  }

  getLayout(instanceId: string): unknown {
    return this.sessions.get(instanceId)?.layout ?? null
  }

  setPluginEnabled(
    instanceId: string,
    pluginId: string,
    enabled: boolean,
    exportKeys: string[]
  ): void {
    this.require(instanceId).setPluginEnabled(pluginId, enabled, exportKeys)
  }

  pluginStateFor(instanceId: string): Record<string, ConversationPluginState> {
    return this.sessions.get(instanceId)?.pluginStateFor() ?? {}
  }

  /** The working directory of a live conversation (used to scope DataBus file channels). */
  cwdFor(instanceId: string): string | null {
    return this.sessions.get(instanceId)?.cwd ?? null
  }

  async usage(instanceId: string): Promise<UsageInfo> {
    const u = await this.require(instanceId).usage()
    if (u.windows.length > 0) {
      this.lastUsage = u
      setLastUsage(u)
      return u
    }
    // Idle/just-restored sessions report no windows until their first turn — serve
    // the last-known account-wide snapshot so the bars stay visible.
    return this.lastUsage ?? u
  }

  transcript(instanceId: string): TranscriptMessage[] {
    return this.require(instanceId).getTranscript()
  }

  editSave(instanceId: string, uuid: string, newText: string): TranscriptMessage[] {
    return this.require(instanceId).saveEdit(uuid, newText)
  }

  fork(instanceId: string, uuid: string, newText: string): BranchInfo[] {
    return this.require(instanceId).fork(uuid, newText)
  }

  forkPoints(instanceId: string): ForkPoints {
    return this.require(instanceId).getForkPoints()
  }

  switchBranch(
    instanceId: string,
    sessionId: string
  ): { transcript: TranscriptMessage[]; forkPoints: ForkPoints } {
    return this.require(instanceId).switchBranch(sessionId)
  }

  /** Close a conversation: serialize, tear down the live session, drop its tab. The
   *  manifest stays on disk so it reappears in the dropdown and can be reopened. */
  async close(instanceId: string): Promise<void> {
    const s = this.sessions.get(instanceId)
    if (!s) return
    this.persist(s)
    await s.close()
    this.sessions.delete(instanceId)
    this.syncOpen() // explicit close removes it from the open set
  }

  list(): AgentInstance[] {
    return [...this.sessions.values()].map((s) => s.toInstance())
  }

  /** App quit: serialize + tear down all live sessions, but KEEP the open set so the
   *  next launch restores exactly these conversations. */
  async closeAll(): Promise<void> {
    for (const s of this.sessions.values()) this.persist(s)
    await Promise.all([...this.sessions.values()].map((s) => s.close()))
    this.sessions.clear()
  }

  private require(instanceId: string): Session {
    const s = this.sessions.get(instanceId)
    if (!s) throw new Error(`No agent instance: ${instanceId}`)
    return s
  }
}
