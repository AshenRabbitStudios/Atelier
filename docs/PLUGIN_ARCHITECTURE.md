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
