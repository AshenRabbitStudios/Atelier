# PLUGIN_API.md — Atelier plugin contract

The extensibility surface. Design goal: **capability-bounded, content-unbounded.** A
plugin's pane can render anything (Canvas, WebGL/three.js, forms, docs, charts, an
xterm.js stream). It reaches the rest of the app *only* through the host API below. That
boundary is what keeps plugins hot-reloadable, crash-isolated, and safe to let the agent
author.

## 1. A plugin is a folder

```
/plugins/<id>/
  manifest.json
  index.html        # entry for a UI pane (loaded into a sandboxed webview/iframe)
  plugin.js         # optional: a backend module, run as a child process/worker (never in-process)
  ...assets
```

### manifest.json

```jsonc
{
  "id": "metrics-stream",            // unique, == folder name, [a-z0-9-]
  "name": "Metrics Stream",          // display name in the sidebar
  "version": "0.1.0",
  "kind": "panel",                   // "panel" | "tool" | "both"
  "entry": "index.html",             // required if kind includes "panel"
  "backend": "plugin.js",            // optional; required if it registers privileged tools
  "permissions": ["data:subscribe", "storage"],   // see §4; least-privilege, declared up front
  "defaultDock": "right",            // "left"|"right"|"bottom"|"center"|"float"
  "tools": [                          // optional; agent tools this plugin contributes
    {
      "name": "show_metrics",
      "description": "Render the latest metrics for a run on the Metrics Stream pane.",
      "inputSchema": { "run": "string" }   // serialized; host compiles to Zod
    }
  ]
}
```

Manifests are Zod-validated on discovery. An invalid manifest surfaces an error in the
sidebar and is not loaded; it never throws into the host.

## 2. Lifecycle

Discovery → list in sidebar → **load** (user click, or auto-load in dev) → running →
**reload** (file change or reload control) → **unload**. Load mounts the pane in a fresh
sandbox and registers contributed tools. Reload tears the sandbox down and re-mounts, and
re-registers tools. Unload removes the pane and unregisters tools. **No app restart at any
point.** A plugin that throws on load is isolated and reported, not fatal.

UI plugins hot-reload by reloading their sandbox. Backend modules hot-reload by killing and
respawning their child process — never by in-process module reload (stale-reference hazard).

## 3. Host API (plugin-facing, over postMessage RPC)

The host injects a typed `atelier` global into each plugin sandbox. Every call is async,
validated, and permission-checked. Calls the plugin's `permissions` don't cover are
rejected.

```ts
interface AtelierHost {
  // identity
  readonly pluginId: string;

  // layout — request docking changes for THIS plugin's pane
  layout: {
    dock(position: 'left'|'right'|'bottom'|'center'|'float'): Promise<void>;
    float(): Promise<void>;
    setTitle(title: string): Promise<void>;
    onResize(cb: (size: { w: number; h: number }) => void): () => void;
  };

  // data channels — the legibility plumbing (SPEC §6)
  data: {
    subscribe(channel: string, cb: (payload: unknown) => void): () => void;
    publish(channel: string, payload: unknown): Promise<void>;   // needs "data:publish"
    history(channel: string, limit?: number): Promise<unknown[]>;
  };

  // agent — observe and drive agent instances (needs "agent:read" / "agent:send")
  agent: {
    list(): Promise<{ id: string; title: string; cwd: string; status: string }[]>;
    onEvent(instanceId: string, cb: (e: unknown) => void): () => void;  // AgentEvent stream
    send(instanceId: string, text: string): Promise<void>;
  };

  // tools — register an agent-callable tool implemented by this plugin
  // (declared in manifest.tools; handler lives in the backend module)
  tools: {
    onInvoke(name: string, handler: (input: unknown) => Promise<{ output: unknown }>): void;
  };

  // storage — per-plugin key/value, persisted and scoped to the active CONVERSATION
  // (needs "storage"). This is the ONLY channel through which plugin state survives a
  // reload or conversation-switch — see §8. Writes are durable; the host re-hydrates
  // them when the conversation is restored.
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    keys(): Promise<string[]>;
  };

  // lifecycle hooks the plugin can implement
  on(event: 'load' | 'unload' | 'reload', cb: () => void): void;
}
```

**Not exposed:** direct filesystem, direct process spawn, direct SDK access, raw IPC. A
plugin that needs privileged work declares a `backend` module and a permission; the host
mediates. This is the line that keeps a malformed or hostile plugin contained.

## 4. Permissions

Declared in the manifest, enforced by the host. Minimum useful set:

- `data:subscribe`, `data:publish` — read / write data channels.
- `agent:read`, `agent:send` — observe / drive agent instances.
- `storage` — per-plugin persisted KV.
- `tools` — register agent tools (requires a `backend` module).

Least privilege: the host grants only what's declared, and shows the plugin's permissions
in the sidebar before load.

## 5. Agent tools contributed by plugins

When a plugin with `kind` `tool`/`both` loads, the host registers each `manifest.tools`
entry as an in-process MCP tool on the SDK side (`tool(name, desc, zodSchema, handler)`),
available to all agent instances (or scoped — see open question). Invocation flows:
agent calls the tool → SDK → host → plugin backend's `onInvoke` handler → result back to
the agent. This is how a plugin gives the agent *new capabilities*, not just a new view.
Unloading the plugin unregisters the tools.

## 6. The self-hosting loop (why the folder format matters)

Because a plugin is just files under `/plugins/`, an agent instance pointed at the Atelier
repo can author one with its normal Write tool: create the folder, `manifest.json`, and
entry. The `/plugins` watcher surfaces it in the sidebar; the user loads it; no restart.
This is the bridge from "I iterate via Claude Code CLI" to "I iterate from inside Atelier."

Provide two worked examples under `/plugins/examples/` so the agent has a pattern to copy:
1. **`hello-panel`** — a minimal `kind: "panel"` plugin (renders a styled pane, calls
   `layout.dock`, persists a value via `storage`).
2. **`bash-stream`** — a `kind: "panel"` plugin that `data.subscribe`s to a
   `bash:*:stdout` channel and renders it with xterm.js. Pair with the P4 ambient Bash tap.

## 8. Persistence & restore (required contract)

Conversations are the unit of persistence (SPEC §4.5), and **every plugin must be built to be
persisted and restored from day one.** A conversation can be closed, the app quit, and reopened
days later; each loaded plugin must come back at its exact dock position with its data intact.

The contract:

- **State lives in `storage`.** A plugin's *only* guaranteed-restorable state is what it writes
  via the host `storage` API. That store is scoped to **(conversation, plugin)** and persisted to
  `<userData>/atelier/conversations/<id>/plugins/<pluginId>/storage.json`. A plugin that wants to
  survive reload/switch must write its restorable state there (and may do so on its `unload`
  hook and/or incrementally).
- **The host guarantees restore.** On conversation load the host: re-mounts the plugin's pane at
  its saved dock position, re-hydrates its `storage`, and fires the plugin's `load` hook. The
  plugin reads `storage` in `load` and rebuilds its view. The host does **not** snapshot a
  plugin's DOM or in-memory runtime — anything not written to `storage` is not restored.
- **No conversation-leakage.** `storage` for conversation A is invisible to conversation B, even
  for the same plugin id. Switching conversations swaps the backing store.
- **DataBus history** a plugin relies on may be persisted per conversation (SPEC §6) or be
  ephemeral (e.g. a tailed bash stream). A plugin must tolerate an empty channel on restore and
  rebuild from its own `storage` where it needs durable state.
- **Layout is the host's job.** The plugin does not persist its own dock position; the host
  records it in the conversation's layout and restores it. The plugin only persists *content/state*.

Design implication: write plugins so that `load` can fully reconstruct the pane from `storage`
alone. Treat every mount as a potential restore.

## 9. Open questions (record answers in docs/DECISIONS.md)

- Tool scoping: are plugin-contributed tools global to all instances, or per-instance
  opt-in? Default global; revisit if it gets noisy.
- Sandbox tech: Electron `<webview>` vs sandboxed iframe + preload. Pick one early and keep
  the host API identical across it.
- Versioning: a `apiVersion` field in the manifest so the host can reject incompatible
  plugins as the host API evolves. Add when the API first changes.
