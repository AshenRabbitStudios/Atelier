# SPEC — Atelier

What to build. Architecture and the contracts that let components interlock. Pair with
PLUGIN_API.md (extensibility) and ROADMAP.md (build order). CLAUDE.md governs method.

## 1. What it is, and why this substrate

A desktop app for working with Claude on a real project, where the agent's activity is
**legible**: a dockable chat interface to the Claude Agent SDK, plus a hot-reloadable
plugin system whose panes (living docs, tailed streams, diagrams, 3D scenes, interactive
sims) make opaque work — e.g. an AI training run — visible and, where possible, verifiable.

Substrate: **Electron + TypeScript**, single language end to end; agent via
`@anthropic-ai/claude-agent-sdk` in the main process; React renderer; Dockview docking;
plugins as isolated web panes. Considered and rejected: Python-host + web frontend (extra
IPC boundary, two languages) and native Qt (the plugin/3D/sim world is web-native; you'd
embed webviews everywhere anyway). Electron gives one language, native windows, the mature
web docking ecosystem, and web-native plugins.

## 2. Process model

- **Main process** (Node/TS) owns everything privileged:
  - `AgentManager` — creates/owns N independent agent sessions (SDK), one per instance.
  - `PluginHost` (backend half) — watches `/plugins`, maintains the registry, spawns any
    plugin backend workers, routes host-API calls that need privilege.
  - IPC server + a preload `contextBridge` exposing a typed, minimal API to the renderer.
- **Renderer process** (React) owns the UI: the Dockview workspace, chat panels, the
  plugin sidebar, and plugin panes. Imports no SDK and no Node built-ins.
- **Plugin sandboxes** — each plugin runs in its own `<webview>`/iframe and talks only to
  the host via postMessage RPC (PLUGIN_API.md). Isolation = crash containment + clean
  hot-reload.

Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for plugin
webviews. The renderer cannot touch fs/process/SDK directly — only through the bridge.

## 3. The chat interface (core)

### 3.1 Rendering contract — never garbled

Drive Claude through the SDK's **structured message stream**, not the CLI's rendered TUI.
The main process normalizes each `SDKMessage` into a typed UI event and sends it to the
renderer:

```ts
type AgentEvent =
  | { instanceId: string; kind: 'system_init'; sessionId: string; tools: string[] }
  | { instanceId: string; kind: 'text'; messageId: string; delta: string } // streamed
  | { instanceId: string; kind: 'thinking'; messageId: string; delta: string } // streamed
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
```

Renderer transcript model: an ordered list of messages, each with typed blocks
(`text` | `thinking` | `tool_use` | `tool_result`). Rendering rules:

- **text** → markdown via a safe renderer; fenced code → Shiki/CodeMirror with language
  detection. Code is never run through the markdown inline parser.
- **thinking** → its own collapsible block, collapsed by default, visually distinct.
- **tool_use** → a compact, expandable row: tool name + pretty-printed input; on expand,
  the matching `tool_result`. File edits render as diffs.
- Anything that is genuinely terminal output (a tailed bash stream) does **not** belong in
  the chat transcript — it is a stream surface rendered by xterm.js (see §6, PLUGIN_API).

### 3.2 Streaming

Token/block deltas stream into the active message. The panel shows a live "working"
state with the current tool, and an interrupt control (`Query.interrupt()`).

### 3.3 Editable history → context reframe

Each user message is editable. Editing message _M_:

1. `AgentManager.fork(instanceId, atMessageId=M, newText)` forks the session at M (V1
   `forkSession` + resume) seeded with history up to M, replacing M's content.
2. If file checkpointing is enabled, optionally rewind the working tree to M's checkpoint
   so the agent re-runs from the same filesystem state. **This reverts real changes** —
   gate it behind an explicit "also rewind files" affordance; default is conversation-only
   fork.
3. Renderer truncates the transcript after M and streams the new continuation.

### 3.4 Docking + scaling

The chat panel is an ordinary Dockview panel: dock bottom/side, tab, float, or fullscreen,
and a font-scale control (affects the transcript's rem base). Nothing special required.

## 4. Multiple agent instances (different folders)

`AgentManager` keeps a registry:

```ts
interface AgentInstance {
  id: string
  cwd: string // the project folder this instance operates in
  sessionId?: string // from system_init
  status: 'idle' | 'working' | 'error' | 'closed'
  title: string // user-facing, defaults to basename(cwd)
}
interface AgentManager {
  create(opts: { cwd: string; model?: string }): Promise<string> // returns instanceId
  send(instanceId: string, text: string): Promise<void>
  interrupt(instanceId: string): Promise<void>
  fork(
    instanceId: string,
    atMessageId: string,
    newText: string,
    opts?: { rewindFiles?: boolean }
  ): Promise<void>
  close(instanceId: string): Promise<void>
  list(): AgentInstance[]
  // emits an AgentEvent stream per instance over IPC
}
```

Each instance sets `cwd` and `settingSources: ['project']` so it loads that folder's
`CLAUDE.md`. Instances run concurrently. "Switching" is purely a renderer concern: which
chat panel has focus. Typical use: one instance in the primary-project folder, one in the
Atelier repo folder for building plugins.

## 4.5 Conversations & persistence (architectural bedrock)

The **conversation is the unit of persistence** — a self-contained, restorable document.
Atelier keeps a list of conversations; each one captures _everything_ needed to resume it
exactly. You can have several conversations open, close the app for the day, reopen, and
every conversation resumes with full context — chat **and** plugins. This is bedrock:
every feature that holds state (chat, layout, plugins, data channels) must be persistable
per conversation, and every plugin must be built to be persisted from day one (PLUGIN_API §8).

### 4.5.1 Runtime shape

- A **conversation bar** spans the very top of the app: select / create / close conversations.
- Below it is **the workspace** — the Dockview area for the **active** conversation. Exactly
  one conversation is rendered at a time; selecting another in the top bar swaps the whole
  workspace (layout, panes, plugins, data) to that conversation. No nested layouts.
- The chat panel is an ordinary movable/dockable Dockview panel titled **"Claude"**. It keeps
  its own header (model selector, bypass-approvals, usage bars, branch switchers). It does
  **not** contain a conversation selector — conversation selection lives only in the top bar.
- "Open" conversations are the entries in the top bar; all of them persist regardless of which
  is active. Closing the app and reopening restores the set and the last-active one.

### 4.5.2 What a conversation persists

1. **Identity:** id, user-given title (nameable), createdAt, updatedAt.
2. **Project root:** `cwd` (the folder the agent operates in) and `model`.
3. **Full context:** the branch tree — every SDK session (`sessionId`) with its lineage
   (`parentSessionId`, `forkAnchorUuid`, `forkPointUuid`, `label`, `createdAt`) and the active
   branch. This captures all forks. Message _content_ is not copied — it lives in the Claude
   Agent SDK's per-session JSONL (the single source of truth that already powers edit/fork);
   the conversation references those sessions. (Export-to-self-contained-bundle is a future,
   opt-in operation, not the storage model.)
4. **Layout:** the exact Dockview serialization for this conversation (the Claude pane plus
   every plugin pane, docked precisely as the user left them).
5. **Plugins:** for each loaded plugin — its id (+ version), dock placement (part of the
   layout), and a reference to its persisted data.
6. **Plugin data & state:** per-(conversation, plugin) persisted storage (the host `storage`
   KV, PLUGIN_API §3/§8), plus any DataBus channel history the conversation owns.

### 4.5.3 On-disk layout

```
<userData>/atelier/
  conversations.json                       # index: [{ id, title, cwd, updatedAt }], lastActiveId
  conversations/<conversationId>/
    conversation.json                      # manifest: identity, cwd, model, branches, activeBranch, layout, plugins[]
    plugins/<pluginId>/storage.json        # per-plugin persisted data, conversation-scoped
    # message transcripts are NOT copied here — referenced by sessionId in the SDK's own store
```

### 4.5.4 Lifecycle

- **Create:** new conversation folder + manifest; user picks the project folder; default
  layout is just the Claude pane.
- **Autosave (debounced):** the manifest is rewritten on every state change — a completed
  turn bumps `updatedAt`; a fork adds a branch; loading/moving a plugin updates `plugins[]`
  and `layout`; a plugin writing `storage` updates its `storage.json`.
- **Restore (launch / switch):** read the manifest → recreate the agent session resuming the
  active branch → load the transcript from the SDK JSONL → restore the dock layout → re-mount
  each loaded plugin at its saved dock position with its conversation-scoped storage hydrated.
  Opening a conversation **instantly** repopulates the workspace from this manifest.
- **Switch:** the active conversation is swapped wholesale; the previous one's state is already
  persisted, so nothing is lost.

The renderer must never be the source of truth for conversation state — it reflects the
persisted manifest. A renderer reload or a main-process restart restores from disk, so a
self-edit that reloads the app never loses a conversation.

## 5. Docking workspace

- A `LayoutService` wraps Dockview: add/remove/move panels, float groups, serialize and
  restore layout JSON. Layout is serialized **per conversation** (§4.5), not globally — each
  conversation owns its exact arrangement, restored when it becomes active.
- Panel kinds: `claude` (the chat pane), `plugin` (one per loaded plugin pane), plus built-ins
  as needed (plugin sidebar). The conversation bar is a fixed chrome strip above the workspace,
  not a Dockview panel.
- The plugin sidebar (§7) is a collapsible panel with a "Load plugin" action.
- **Deferred to its phase:** tearing a panel into a separate OS window and re-docking it.
  Until then, in-app floating groups provide the Photoshop-style float/dock/tab feel.

## 6. Data channels (legibility plumbing)

A lightweight pub/sub in the main process, bridged to renderer and plugins via the host API:

```ts
interface DataBus {
  publish(channel: string, payload: unknown): void // append or replace
  subscribe(channel: string, cb: (payload: unknown) => void): () => void
  history(channel: string, limit?: number): unknown[]
}
```

Channels are how a plugin pane shows live data without owning the source: e.g. a
`bash:<toolUseId>:stdout` channel fed by a PreToolUse/PostToolUse hook tailing a command's
output, or a `metrics:<run>` channel a trainer writes JSONL to. This is the **ambient /
passive** legibility path: surfaces fed from reality, not from the agent's narration. Wire
at least one ambient Bash→stream channel (ROADMAP P4) so the user can watch what the agent
actually ran, not just what it said it ran.

## 7. Plugins (overview; full contract in PLUGIN_API.md)

- A plugin is a folder under `/plugins/<id>/` with a `manifest.json` and an entry module.
- `PluginHost` watches `/plugins`, lists discovered plugins in the sidebar, and loads on
  demand (or auto-loads in dev). Loading mounts the entry in a sandboxed pane and registers
  any agent tools the plugin contributes. **No app restart**, ever.
- A plugin can contribute a **UI pane**, one or more **agent tools** (surfaced to instances
  as in-process MCP tools), or **both**.
- Hot reload: file change or the pane's reload control tears down the sandbox and re-mounts;
  contributed tools are unregistered and re-registered.
- **Self-hosting loop:** an agent instance pointed at the Atelier repo can write a new
  plugin folder; the watcher surfaces it; the user loads it without restarting. This is the
  path from "iterate via the CLI" to "iterate from within Atelier."

## 8. Non-goals (v0)

Multi-user / auth / remote hosting; shipping to third-party end users (no claude.ai login);
mobile; the self-modifying-context-schema research; replacing the terminal entirely (the
chat panel is the interface, but plugins/surfaces are the visual layer around it).

## 9. Open questions to resolve in-build (record answers in docs/DECISIONS.md)

- xterm.js stream panes: implement as a built-in panel kind, or as the first example plugin?
  (Leaning example plugin, to exercise the plugin path early.)
- Metric taps: generic JSONL-on-a-channel convention vs per-trainer parsing. Prefer the
  convention; document it.
- ~~Transcript persistence: persist per-instance transcripts vs rely on session resume?~~
  **Resolved (§4.5):** a per-conversation manifest persists the branch tree and references the
  SDK's per-session JSONL for message content (no copy); restored on launch/switch.
- DataBus channel durability: which channels are persisted per conversation vs ephemeral
  (e.g. a tailed bash stream is ephemeral; a metrics log may be durable). Decide in P4.
