# PLUGIN_ARCHITECTURE.md — design for the plugin capacity

Proposed architecture for Atelier's plugin system, extending the PLUGIN_API.md contract to
satisfy the product vision: Claude authors a plugin from inside Atelier → it auto-populates a
left rail → one click enables it mid-session → it works, is serializable, is controllable by
the agent, and can pin its live state into the agent's context. Status: **design** (not built).

## Assessment of the existing contract (PLUGIN_API.md)

Solid and mostly sufficient. Already provides: folder-as-plugin (enables Claude-authored,
hot-loaded plugins and the self-hosting loop, §6), capability-bounded/content-unbounded host
RPC (§3), per-(conversation,plugin) `storage` (§3/§8), agent-tool contribution (§5), data
channels for push/poll tails (§3 `data`), and a strict restore contract (§8). Keep all of it.

**Three gaps** the vision needs that the contract does not yet model:

1. **Per-conversation enablement.** The registry is app-wide, but *which plugins are enabled
   (and thus mounted/displayed)* must be conversation-specific. The contract has per-conversation
   storage + layout but no explicit enable/disable set.
2. **Context pinning.** Nothing today injects a plugin's live state into the agent's context.
   This is the architecturally novel requirement ("data optionally pinnable so Claude is always
   up to date on changes I make inside a plugin").
3. **Universal agent→plugin control.** `tools` + `data` let the agent gain capabilities and
   observe; there is no first-class, generic lever for the agent to *drive any* plugin without
   each plugin pre-declaring bespoke tools.

## Component map

```
main process (privileged)
  PluginRegistry      watch /plugins, Zod-validate manifests, app-wide discovered list
  PluginHost          mount/unmount/reload sandboxes; inject host RPC; respawn backends
  DataBus             named channels: pub/sub + optional per-conversation history (P4)
  ContextManager      holds latest snapshot per pinned export; feeds AgentManager at send time
  AgentManager        (exists) + a context-injection hook + a built-in plugin_control tool
        │ typed IPC (Zod at the edge)
renderer (sandboxed)
  PluginRail          thin perma-docked left rail; collapsed=icons, expanded=plugin list
  plugin sandboxes    one webview/iframe per enabled plugin, mounted as Dockview panes
```

The **rail is app chrome, not a Dockview pane** — that is what makes it perma-docked left and
always present. The plugin *panes* it spawns are normal dockable/floatable Dockview panels.

## 1. Registry vs. enablement (gap 1)

- **Registry = app-wide.** `PluginRegistry` watches `/plugins/`, validates each `manifest.json`,
  and maintains the global discovered list. A folder Claude writes appears here automatically
  (the self-hosting loop). Emits `plugins:changed` to the rail.
- **Enablement = per-conversation.** The conversation manifest gains:
  ```ts
  plugins: Record<pluginId, { enabled: boolean; pinnedExports: string[] }>
  ```
  Dock position stays in the existing per-conversation Dockview layout (PLUGIN_API §8). Enabling
  mounts the sandbox into the active conversation's workspace; disabling unmounts it. Switching
  conversations re-derives the mounted set. Fully serializable JSON.
- **Rail UI:** every discovered plugin is listed (global); per row — an enable toggle
  (conversation-scoped), load/error status, and a "📌 pin" toggle per declared context export.

## 2. Context pinning (gap 2 — the core new primitive)

Goal: a slice of a plugin's state can be *pinned* to a conversation, and the agent sees the
**latest** value on every turn, so user edits inside a plugin stay reflected without re-pasting.

- **Plugins declare exports.** Declarative in the manifest plus a runtime push:
  ```jsonc
  "contextExports": [
    { "key": "todo", "label": "To-do list", "format": "markdown", "maxTokens": 1500 }
  ]
  ```
  ```ts
  // host API addition (permission: "context")
  context: {
    update(key: string, value: string): Promise<void>;   // plugin pushes a fresh snapshot
  }
  ```
  A living-doc plugin calls `context.update('todo', md)` whenever the user edits — that is the
  "always up to date" mechanism.
- **Host holds the snapshot.** `ContextManager` keeps the latest value per `(conversation,
  pluginId, key)`. Pinning is just adding `key` to the conversation's `pinnedExports`.
- **Injection at send time.** On each agent turn, `AgentManager` reads the live snapshots for the
  active conversation's pins and injects them as a **host-managed, clearly-framed context block**
  (e.g. `<atelier-pinned-context>` … `</atelier-pinned-context>`), refreshed every turn — *not*
  stored as user transcript content, so it never pollutes editable history. (Exact SDK injection
  mechanism — appended context frame vs. session system-prompt update — to be confirmed against
  the live SDK reference and recorded in docs/SDK_NOTES.md before building, per CLAUDE.md.)
- **Bounded.** Each export declares `maxTokens`; the host truncates + marks truncation, and the
  rail shows the pinned token cost so context never silently bloats.

This makes "living docs and tails" first-class: a poll/push tail writes to a DataBus channel for
display, and (if pinned) mirrors a digest into context via `context.update`.

## 3. Universal agent control (gap 3)

Keep capability-bounded/content-unbounded: fix the *boundary*, leave plugin internals open.

- **Built-in host tool** (always available to the agent, not per-plugin):
  `plugin_control(pluginId, command, payload)`. The host validates the target is enabled, then
  delivers `{command, payload}` to that plugin over a reserved `control:<pluginId>` channel the
  plugin subscribes to. The plugin interprets commands however it wants — the host does not
  constrain the vocabulary. This gives Claude a generic lever over *every* plugin with zero
  per-plugin tool boilerplate, while plugins that want richer typed tools still declare them
  via `manifest.tools` (§5).
- **Discovery for the agent:** the host can surface the enabled plugins + their declared
  `contextExports`/`tools` so Claude knows what it can drive. (A read-only `list_plugins` tool.)

## Build order — backend must come first

**Yes, backend wiring precedes the rail.** The left rail is inert without the registry, sandbox
mounting, and host RPC. Recommended sequence:

1. **P3 (plugin host + rail):** PluginRegistry + watcher + Zod manifest validation; per-conversation
   enablement model in the manifest; sandbox mount + host API subset (`layout`, `storage`,
   lifecycle); the perma-docked left rail. Ship `hello-panel`. — *This is the prerequisite.*
2. **P4 (channels + control + pinning):** DataBus + `data` API; the `plugin_control` tool +
   `control:` channel; `ContextManager` + `context.update` + send-time injection + pin toggles;
   ambient Bash tap. Ship `bash-stream` and a `living-doc` example (edit-in-pane → pinned context).

Design the manifest fields (`plugins{enabled,pinnedExports}`, `contextExports`) **now** so
persistence/restore is correct from day one (PLUGIN_API §8), even though injection lands in P4.

## Serialization summary (everything is JSON)

- Registry: derived from `/plugins/*/manifest.json` (app-wide, not persisted separately).
- Per conversation: `plugins{enabled, pinnedExports}` + Dockview layout (dock positions) in the
  conversation manifest; plugin content in `conversations/<id>/plugins/<pluginId>/storage.json`.
- Pinned context: snapshots are runtime (re-pushed by the plugin on `load`); the *set of pins*
  is persisted in the manifest. A plugin rebuilds its export in `load` from `storage`.

## Dos & Don'ts (invariants — violating these breaks the intent)

These are the load-bearing rules. A change that breaks one requires a recorded decision, not a
quiet diff. Reviewers enforce them.

**DO**
- **Treat every mount as a potential restore.** A plugin's `load` MUST fully rebuild its pane
  from `storage` alone. (This is what makes close/quit/reopen-days-later work.)
- **Keep the rail as app chrome** (perma-docked left, always present); spawn plugin *content* as
  normal Dockview panes that dock/float/tab like anything else.
- **Define the manifest fields now** — `plugins{enabled,pinnedExports}` on the conversation,
  `contextExports` on the plugin — so persistence is correct from day one, even though pinning
  injection lands in P4.
- **Validate every boundary payload with Zod at the receiving side** (manifest, host RPC, control).
- **Make `context.update` the freshness mechanism:** the plugin pushes a new snapshot whenever the
  user changes something inside it. Re-read snapshots at send time, every turn.
- **Confirm the SDK context-injection mechanism against the live reference and record it in
  docs/SDK_NOTES.md BEFORE building pinning** (per CLAUDE.md — the SDK surface drifts).
- **Keep the host API identical** across whatever sandbox tech is chosen (webview vs iframe).
- **Surface legibility in the rail:** each plugin's declared permissions, load/error status, and
  the token cost of its pinned exports.

**DON'T**
- **Don't give plugins direct fs / SDK / process / raw IPC access.** Everything goes through the
  host RPC. This single line is what keeps a malformed or agent-authored plugin contained.
- **Don't hot-reload backend modules in-process.** Backends are child processes/workers, killed
  and respawned on reload (stale-reference hazard). UI plugins reload by reloading their sandbox.
- **Don't persist a plugin's DOM or in-memory runtime.** Only `storage` is restorable; anything
  not written there is gone on reload. The host never snapshots plugin runtime.
- **Don't put pinned context into the editable transcript.** It is a host-framed, ephemeral block
  refreshed each turn — putting it in user/assistant content breaks editable history AND freshness.
- **Don't let pinned context be unbounded.** Always enforce per-export `maxTokens`, mark truncation,
  and show the cost. Silent context bloat is a regression.
- **Don't conflate registry scope with enablement scope.** The registry is **app-wide**; *enabled*
  (and thus mounted/displayed) is **per-conversation**. Making either global-or-local the wrong way
  breaks the whole model.
- **Don't hardcode plugins or layout.** A plugin is a folder; enablement/layout/pins are JSON. This
  is precisely what enables the self-hosting loop and hot-reload — don't trade it for convenience.
- **Don't constrain the control channel's vocabulary.** `plugin_control` fixes the *boundary*, not
  the *content*; the plugin interprets commands freely. Locking the vocabulary kills "control
  universally without limiting what's written inside."
- **Don't let a bad plugin throw into the host.** Validate at the edge, isolate the failure, and
  surface it in the rail — never let it crash the app or another plugin.
- **Don't leak storage across conversations.** `(conversation, plugin)` is the scope; conversation
  A's data is invisible to B even for the same plugin id.
- **Don't block discovery on load.** Discovery is passive (watcher + validate); loading is an
  explicit user action (or dev auto-load). A broken plugin still lists; it just doesn't mount.
