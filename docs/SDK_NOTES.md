# SDK_NOTES.md — verified Agent SDK surface

Package: `@anthropic-ai/claude-agent-sdk` (TypeScript). Verified against
https://code.claude.com/docs/en/agent-sdk/typescript (redirected from
docs.claude.com / platform.claude.com) on 2026-06-27.

> CAUTION: the doc text was fetched + summarized; exact identifier casing (esp. hook
> event names) must be re-confirmed against the installed package's `.d.ts`
> (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) right after `npm install`,
> before relying on it. Anything below marked (verify) is provisional until then.

## Auth — the billing-safety contract (decided)

- The SDK authenticates the **same way as the Claude Code CLI**: it inherits the local
  logged-in Claude Code session. No claude.ai login plumbing in Atelier (per CLAUDE.md).
- **`ANTHROPIC_API_KEY` takes priority over the subscription.** If it is set, the SDK
  bills pay-as-you-go to that API account. So Atelier's main process **must NOT set it**
  and **must warn/refuse if one is present** in the launch environment, then proceed on
  the subscription session.
- Billing pool (as of 2026-06-27): the June-15 split that would move Agent-SDK usage to a
  separate credit pool was **paused** — SDK usage currently draws from the normal
  subscription pool, like the interactive CLI. This is a moving target; revisit.

## query() — the core (V1 API; this is what we build on)

```ts
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query // Query extends AsyncGenerator<SDKMessage, void>
```

`Query` methods we use:

- `interrupt(): Promise<void>` — P0 interrupt control.
- `rewindFiles(userMessageId, { dryRun? }): Promise<RewindFilesResult>` — P1 "also rewind
  files" (file checkpointing lives behind this; default OFF).
- `setModel(model?)`, `setPermissionMode(mode)`, `close()`.

Stream by iterating the returned object: `for await (const msg of q) { ... }`.

## SDKMessage union — what we normalize into AgentEvent

- `assistant`: `{ type:'assistant'; session_id; message: BetaMessage; parent_tool_use_id }`
  — `message.content` is the block array (text / thinking / tool_use); `message.usage`.
- `result`: `{ type:'result'; subtype:'success'|'error'|'interrupted'; session_id;
duration_ms; total_cost_usd; is_error; ... }` — terminal per turn; carries cost/usage.
- `partial_assistant` (with `includePartialMessages: true`):
  `{ type:'partial_assistant'; session_id; partial_content: ContentBlockDelta[] }` —
  arrives BEFORE the full `assistant` message; this is our **token-by-token streaming**.
- `session_id` is present on messages; grab it from the first message to populate
  `AgentInstance.sessionId`. (`query.initializationResult()` also returns init data.)

Mapping to SPEC §3.1 `AgentEvent`: partial_assistant text deltas → `kind:'text'` /
`kind:'thinking'`; assistant tool_use blocks → `kind:'tool_use'`; tool results →
`kind:'tool_result'`; result → `kind:'result'`.

## Editable history (P1) — fork + resume-at

```ts
query({
  prompt,
  options: {
    resume: sessionId,
    resumeSessionAt: messageUuid, // backtrack to a specific message
    forkSession: true // branch to a NEW session id (don't mutate original)
  }
})
```

This is exactly SPEC §3.3: fork at edited message M, stream the new continuation.
Confirmed available on the V1 `query()` API (CLAUDE.md required forking; satisfied).

Session helpers also exist: `listSessions`, `getSessionMessages`, `getSessionInfo`,
`renameSession`, `tagSession` — relevant to the P1 open question (transcript persistence
vs. session resume as source of truth).

## In-process MCP tools (P4 plugin tools)

```ts
const t = tool(name, description, { field: z.string() }, async (input) => ({
  content: [{ type:'text', text: '...' }],
}), { annotations: { readOnlyHint, destructiveHint, ... } });

const server = createSdkMcpServer({ name, version, tools: [t] });

query({ options: { mcpServers: { my: { type:'sdk', name, instance: server } } } });
```

Plugin-contributed tools (PLUGIN_API §5) register here; unload unregisters.

## Hooks (P4 ambient Bash tap) — CONFIRMED against installed sdk.d.ts (v0.3.195), 2026-06-30

`options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`. Event names are **PascalCase**
(`HOOK_EVENTS` includes `'PreToolUse'`, `'PostToolUse'`, `'PostToolUseFailure'`, …).

```ts
HookCallbackMatcher = { matcher?: string; hooks: HookCallback[]; timeout?: number }
HookCallback = (input: HookInput, toolUseID: string | undefined,
                opts: { signal: AbortSignal }) => Promise<HookJSONOutput>
```

- `matcher` is matched against the **tool name** for Pre/PostToolUse (e.g. `'Bash'`); still
  defensively check `input.tool_name` in the handler.
- `PreToolUseHookInput = BaseHookInput & { hook_event_name:'PreToolUse'; tool_name; tool_input:
unknown; tool_use_id: string }`. (`tool_input` for Bash carries `.command`.)
- `PostToolUseHookInput = BaseHookInput & { hook_event_name:'PostToolUse'; tool_name; tool_input;
tool_response: unknown; tool_use_id; duration_ms? }`. `PostToolUseFailureHookInput` is the same
  with `error: string` instead of `tool_response`.
- `BaseHookInput`: `{ session_id; transcript_path; cwd; permission_mode?; agent_id?; agent_type?; … }`.
- Return for a non-blocking observer: a `SyncHookJSONOutput` — `{ continue: true }` (all fields
  optional; `{}` also works). Pre/PostToolUse can block via `{ decision:'block' }` / a
  `*HookSpecificOutput` with `permissionDecision` — we do NOT; the tap is read-only.

**CRITICAL — no streaming-stdout hook.** Pre/PostToolUse are discrete: PreToolUse fires _before_
the Bash command runs (we get the command + tool_use_id); PostToolUse fires _after it completes_
(we get `tool_response` = the **final, full** output). There is no event carrying partial stdout
mid-command, and a hook cannot supply a tool result (only allow/deny/modify input — execution stays
inside the SDK). So the Bash tap is **command-granular**, not sub-second live: announce the command
on PreToolUse, publish its full ANSI-intact output on PostToolUse. Channel is **conversation-scoped
`bash:stdout`** (not per-`toolUseId`) so the xterm pane can subscribe once before any command runs;
each message is tagged with `toolUseId` so a future per-command view can demultiplex. (Deviation
from ROADMAP's literal `bash:<toolUseId>:stdout` — logged in DECISIONS.md.)

## Loading project CLAUDE.md (per-instance) — refinement of CLAUDE.md

CLAUDE.md said "settingSources must include 'project'". The current docs add a second
requirement: the **`claude_code` system-prompt preset** must also be set. So each
spawned instance uses:

```ts
options: {
  settingSources: ['project'],
  systemPrompt: { type:'preset', preset:'claude_code' },
  // tools: { type:'preset', preset:'claude_code' }  // for the full Claude Code toolset
}
```

Deviation logged in DECISIONS.md. To NOT inherit ambient user/local settings, pass only
`['project']` (omit 'user'/'local').

## Confirmed against installed `sdk.d.ts` (v0.3.195) + a live probe

- `SDKPartialAssistantMessage = { type:'stream_event'; event: BetaRawMessageStreamEvent }`.
  Parse `event.type === 'content_block_delta'` with `delta.type` `text_delta` / `thinking_delta`.
  Use `message_start.message.id` as the stable per-message id; block `index` separates blocks.
- `SDKAssistantMessage = { type:'assistant'; message: BetaMessage; uuid; session_id }` —
  authoritative `tool_use` blocks (complete inputs) are read here.
- Tool results arrive as `type:'user'` messages whose `message.content` has `tool_result` blocks.
- `SDKSystemMessage` (subtype `init`) carries `apiKeySource: 'user'|'project'|'org'|'temporary'|'oauth'`
  — and a live probe returned **`'none'`** when authenticated via the ambient Claude Code session
  with no API key. So treat `oauth` AND `none` as the safe/subscription case; any other value
  means an API key is in play (warn). Probe result: apiKeySource `none`, text streamed in deltas,
  clean `result`. Auth + token streaming verified end to end.
- `Query` has `interrupt()` and `rewindFiles(userMessageId, { dryRun? })` (P1 file rewind).

## AskUserQuestion — answered via `canUseTool` (probe-verified 2026-06-28)

The built-in `AskUserQuestion` tool (the agent asking the _user_ a multiple-choice
question) is part of the `claude_code` preset toolset, so the model calls it on its own.
**How a custom SDK host answers it:** it arrives at `canUseTool` like any tool; allow it
with the user's choices injected as an `answers` map on `updatedInput`:

```ts
// input.questions: { question, header, options:[{label,description,preview?}], multiSelect }[]
canUseTool: (toolName, input) => {
  if (toolName === 'AskUserQuestion')
    return { behavior: 'allow', updatedInput: { ...input, answers: { [questionText]: label } } }
  // answers: question-text -> chosen label; multiSelect -> comma-joined labels.
  // Optional freeform: add `response: '<text>'`. Allow with NO `answers` => the tool
  // result is literally "The user did not answer the questions."
}
```

Probe result: injecting `{ "<question>": "TypeScript" }` made the tool return
"Your questions have been answered: …=TypeScript" and the model used it. So Atelier
routes `AskUserQuestion` to a **question card** (not the Allow/Deny approval card) and
resolves the pending `canUseTool` promise with the allow+answers shape.

Dead ends ruled out by the probe: `onUserDialog` + `supportedDialogKinds:
['permission_ask_user_question']` did **not** fire when `canUseTool` was supplied —
`canUseTool` (only `allow`/`deny`, no `defer`) handles it first. The `permission_*`
`request_user_dialog` kinds (`permission_ask_user_question`, `permission_bash`, …, found
in the bundled `claude.exe`) are the interactive-CLI permission path, bypassed when a host
provides `canUseTool`. `toolConfig.askUserQuestion.previewFormat: 'html'` exists for
rendering option `preview` fields as HTML if we later want rich previews.

## Still to confirm before the phase that needs them

- [x] Hook event identifier casing in `Options.hooks` (P4 Bash tap) — **PascalCase, confirmed above.**
- [ ] What enables file checkpointing so `rewindFiles` has snapshots to revert to (P1).
- [ ] `mcpServers` config discriminant for in-process tools (`type:'sdk'`) (P4 S3) — SDK_NOTES shows
      `{ type:'sdk', name, instance: server }`; re-confirm when wiring plugin backend tools.

## Permission modes vs `canUseTool` — probe-verified 2026-07-04 (v0.3.195, live, Haiku)

Three live probes (Write tool into fresh temp cwds; `canUseTool` recorded + denied every call):

- **`permissionMode: 'bypassPermissions'` at query build** (with `allowDangerouslySkipPermissions:
true`): `canUseTool` is **never consulted**; the tool executes. (AskUserQuestion still routes to
  `canUseTool` — it's a question, not a permission.)
- **Runtime `q.setPermissionMode('bypassPermissions')`** (default-mode query, mode flipped between
  turns): same — subsequent turns skip `canUseTool` entirely and tools execute. After the control
  call the CLI emits a `system status` message and a **second `system init`**.
- **`permissionMode: 'default'`** (control): `canUseTool` IS consulted (e.g. for Write); a deny
  blocks the tool.

So honoring bypass is purely host-side state management: keep `permissionMode` on every
(re)bind's options and persist it. Two probe traps worth remembering:

- **Streaming input emits NOTHING (not even `system` init) until the first user message is
  pushed** — "wait for init, then send" deadlocks.
- **Don't `await q.setPermissionMode()` from inside the message-iteration loop** — the control
  response arrives via the same stream you've stopped pulling; deadlock. Resolve it out-of-band
  (Atelier calls it from an IPC handler, off the pump).

## Input is user-messages-only — system prompt is the only system-role lever (confirmed v0.3.195)

`SDKUserMessage.message` is a `MessageParam` (role `user`); there is no system-role input message.
So a raw mid-conversation `role:"system"` entry in `messages[]` is NOT expressible via `query()`.
The only system-prompt levers are `options.systemPrompt`
(`string | string[] | { type:'preset', preset:'claude_code', append? }`) and the
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker (string[] form only) splitting cached-static from
per-send-dynamic. `systemPrompt` is fixed at query construction (we run one long-lived streaming
query), so changing it mid-conversation requires a `rebind()` (resume keeps history). The
`instructions` plugin uses `append` and rebinds on change in `send()`.
