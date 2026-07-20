# PLUGIN_API.md — Atelier plugin contract

The extensibility surface. Design goal: **capability-bounded, content-unbounded.** A
plugin's pane can render anything (Canvas, WebGL/three.js, forms, docs, charts, an
xterm.js stream). It reaches the rest of the app _only_ through the host API below. That
boundary is what keeps plugins hot-reloadable, crash-isolated, and safe to let the agent
author.

**Why the sandbox exists (intent, not threat model).** Plugins are authored by the user or
by the Atelier agent itself; the sandbox is NOT a defense against malicious third-party
plugins, and no such threat model applies. It exists for three reasons:

1. **Runtime authorability.** A plugin must be creatable, loadable, reloadable, and _wrong_
   entirely at runtime — the agent can write one mid-conversation, and a broken or crashing
   plugin must never take down or require restarting Atelier. Isolation is what makes
   hot-loading agent-authored code safe to attempt freely.
2. **A standalone, teachable contract.** A plugin is a self-contained little app with one
   known coupling signature (`window.atelier` + manifest). A conversation that has never
   seen the Atelier codebase can author one correctly from this contract alone.
3. **No cross-contamination.** Plugins share nothing with each other or with the app — no
   shared globals, styles, state, or reach-arounds. Each is its own isolated app, so the
   workbench composes cleanly instead of accreting into a muddy shared interface.

The one place a genuine security posture applies is **content from the outside world**:
remote pages in the `browser:embed` surface (and anything fetched via `url:` channels) run
or carry arbitrary third-party content and are treated as hostile.

## 1. A plugin is a folder

```
/plugins/<id>/
  manifest.json
  index.html        # entry for a UI pane (loaded into a sandboxed webview/iframe)
  plugin.js         # optional: a backend module, run as a child process/worker (never in-process)
  ...assets
```

The pane runs sandboxed at its own origin (`atelier-plugin://<id>`), so a panel may be a normal
multi-file app: ES modules (`<script type="module">`), `fetch()` of its own folder assets, workers,
and IndexedDB all work and are self-scoped (no reach into the app or other plugins). Durable state
still goes only through the host `storage`/`context` API (§8) — IndexedDB/localStorage are a
per-origin cache, not restorable conversation state.

### manifest.json

```jsonc
{
  "id": "metrics-stream", // unique, == folder name, [a-z0-9-]
  "name": "Metrics Stream", // display name in the sidebar
  "version": "0.1.0",
  "icon": "M2.5 13.5V2.5M2.5 13.5h11M5 11l2.5-3 2 2 3.5-4.5", // unique 16px line-icon `d` (see below)
  "kind": "panel", // "panel" | "tool" | "both"
  "entry": "index.html", // required if kind includes "panel"
  "backend": "plugin.js", // optional; required if it registers privileged tools
  "permissions": ["data:subscribe", "storage"], // see §4; least-privilege, declared up front
  "defaultDock": "right", // "left"|"right"|"bottom"|"center"|"float"
  "tools": [
    // optional; agent tools this plugin contributes
    {
      "name": "show_metrics",
      "description": "Render the latest metrics for a run on the Metrics Stream pane.",
      "inputSchema": { "run": "string" } // serialized; host compiles to Zod
    }
  ]
}
```

Manifests are Zod-validated on discovery. An invalid manifest surfaces an error in the
sidebar and is not loaded; it never throws into the host.

Every plugin should ship a unique `icon`: a single-path 16px line-icon `d` string
(`viewBox 0 0 16 16`, fill none, stroke `currentColor` — DESIGN_SYSTEM.md §6) that visually
distinguishes it in the collapsed sidebar rail. Color is inherited (idle `--faint`, active
`--accent`), so author the path only. Omitting it falls back to a generic plug glyph shared
by every icon-less plugin — avoid that; pick a shape distinct from the other plugins' icons.

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
  readonly pluginId: string

  // layout — request docking changes for THIS plugin's pane
  layout: {
    dock(position: 'left' | 'right' | 'bottom' | 'center' | 'float'): Promise<void>
    float(): Promise<void>
    setTitle(title: string): Promise<void>
    onResize(cb: (size: { w: number; h: number }) => void): () => void
  }

  // data channels — the legibility plumbing (SPEC §6). Built-in sources by channel prefix:
  //   file:<rel>   — a text file, cwd-scoped, live-tailed (needs "data:subscribe")
  //   url:<href>   — an http(s) URL fetched once in main (15s / 2MB / textual-only caps);
  //                  re-subscribing refetches. Needs "net:fetch" ON TOP of "data:subscribe".
  data: {
    subscribe(channel: string, cb: (payload: unknown) => void): () => void
    publish(channel: string, payload: unknown): Promise<void> // needs "data:publish"
    history(channel: string, limit?: number): Promise<unknown[]>
    // Read a cwd-scoped image referenced by rendered content as a bounded data: URL — the binary
    // sibling of a file: subscribe (a sandboxed pane can't fetch a cwd file as an <img> subresource).
    // Image types only, size-capped; needs the same "data:subscribe" capability.
    readAsset(path: string): Promise<{ dataUrl: string } | { error: string }>
    // Write a UTF-8 text file at a cwd-relative path (parents created, atomic, ≤5MB). The write
    // sibling of the file: source — turns a viewer pane into a tool. Needs "data:write". Refuses a
    // path that escapes the conversation cwd.
    writeFile(path: string, content: string): Promise<{ ok: true } | { error: string }>
  }

  // net — host-side HTTP (the sandboxed pane has no network of its own). Needs "net:fetch".
  // A real request verb (method/headers/body/binary) beyond the one-shot GET-only `url:` channel.
  // http(s) only, capped (2MB request / 4MB response / 60s max), cookie-isolated (never carries the
  // app/user session cookies). No streaming in v1 — a poller re-fetches.
  net: {
    fetch(
      url: string,
      opts?: {
        method?: string // GET|POST|PUT|PATCH|DELETE|HEAD (default GET)
        headers?: Record<string, string> // `cookie` is dropped
        body?: string // base64 it yourself for binary + set your own content-type
        timeoutMs?: number // default 15000, max 60000
        binary?: boolean // true → bodyBase64, else bodyText
      }
    ): Promise<
      | {
          status: number
          statusText: string
          headers: Record<string, string>
          bodyText?: string
          bodyBase64?: string
        }
      | { error: string }
    >
  }

  // browser — a live, HOST-OWNED Chromium surface composited over this pane (needs
  // "browser:embed"). The page runs real JS in its own zero-privilege guest process (no preload,
  // no node, sandboxed, popups denied, http(s)-only) and has NO path to this bridge; the plugin
  // only sends commands and receives extracted state. Nav events arrive via on('browser', cb):
  // { type: 'nav'|'loading'|'loaded'|'failed'|'title', url?, title?, error?, canGoBack, canGoForward }.
  browser: {
    open(url: string): Promise<void> // http(s) only; creates the surface on first call
    close(): Promise<void> // hide the surface (its session survives for a later open)
    back(): Promise<void>
    forward(): Promise<void>
    reload(): Promise<void>
    stop(): Promise<void>
    setBounds(rect: { x: number; y: number; w: number; h: number }): Promise<void> // pane coords
    read(opts?: { includeHtml?: boolean }): Promise<{
      url: string
      title: string
      text: string // visible text, capped
      links: string[] // interactive elements, capped
      html?: string // capped outerHTML when includeHtml
      canGoBack: boolean
      canGoForward: boolean
    }>
    // Drive the page. The page is UNTRUSTED — the RESULT is always data, never code.
    // exec runs JS in the page (statements or an expression) and returns { ok: <json> } | { error };
    // the result is JSON round-tripped and capped at 64KB. click/fill are convenience wrappers.
    exec(js: string): Promise<{ ok: unknown } | { error: string }>
    click(selector: string): Promise<{ ok: true } | { error: string }>
    fill(selector: string, value: string): Promise<{ ok: true } | { error: string }>
  }

  // agent — observe and drive THIS pane's conversation (needs "agent:read" / "agent:send").
  // Scoped to the conversation the pane is mounted in — no cross-conversation reach (matches how
  // storage/context/data are scoped). onEvent forwards only this conversation's events.
  agent: {
    info(): Promise<{ id: string; title: string; cwd: string; status: string } | null>
    onEvent(cb: (e: unknown) => void): () => void // AgentEvent stream; returns unsubscribe
    // Bounded backfill of this conversation's normalized AgentEvent trace (oldest→newest, default
    // 200, max 1000) — for a pane that mounts mid-conversation. Needs "agent:read". Main keeps a
    // bounded in-memory ring (last 1000) per conversation.
    history(limit?: number): Promise<unknown[] | { error: string }>
    send(text: string): Promise<void> // needs "agent:send"
    // Stage text into this conversation's chat composer at the cursor WITHOUT sending (distinct from
    // send). Length-capped (~4KB). Needs "agent:compose". { error: 'composer not open' } if the
    // ChatPanel for this conversation is not mounted.
    compose(text: string): Promise<{ ok: true } | { error: string }>
  }

  // fs — read-only, cwd-scoped directory enumeration (needs "fs:list"). NON-RECURSIVE (one level
  // per call); `ignored` is computed host-side from .gitignore + built-ins (.git/, node_modules/).
  // Entries capped at 5000 (truncated:true). A path escaping the cwd returns { error }.
  fs: {
    list(dir?: string): Promise<
      | {
          entries: {
            name: string
            kind: 'file' | 'dir'
            size?: number
            mtime?: number
            ignored: boolean
          }[]
          truncated?: boolean
        }
      | { error: string }
    >
  }

  // shell — open a cwd-relative file in the OS default handler (needs "shell:open"). Re-gated to the
  // conversation cwd (never the app's unscoped openPath); refuses an escaping path with { error }.
  shell: {
    openPath(path: string): Promise<{ ok: true } | { error: string }>
  }

  // os — OS-level attention (needs "os:notify"). Electron notification (silent unless sound); `tag`
  // coalesces same-tag notifications from this plugin; host-side rate cap (≤1/plugin/3s, excess
  // dropped with { error }). A click focuses/raises the Atelier window and fires onNotificationClick.
  os: {
    notify(n: {
      title: string
      body: string
      sound?: boolean
      tag?: string
    }): Promise<{ id: string } | { error: string }>
    onNotificationClick(cb: (e: { id: string }) => void): () => void // this plugin's notifs only
    flashFrame(on: boolean): Promise<void>
    setBadgeCount(n: number): Promise<void> // best-effort (no-op where unsupported)
    isWindowFocused(): Promise<boolean>
    onWindowFocusChange(cb: (focused: boolean) => void): () => void
  }

  // backend — call an operation on THIS plugin's OWN service backend (the plugin must declare
  // service:true + backend). No extra permission (a pane only reaches its own backend). The host
  // posts { id, rpc: { conversationId, op, params } }; the backend replies { id, result } | { id,
  // error }. 30s default / 600s max timeout, like a tool. Replaces abusing the DataBus for pane→
  // backend calls.
  backend: {
    call(op: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  }

  // tools — register an agent-callable tool implemented by this plugin
  // (declared in manifest.tools; handler lives in the backend module)
  tools: {
    onInvoke(name: string, handler: (input: unknown) => Promise<{ output: unknown }>): void
  }

  // storage — per-plugin key/value, persisted and scoped to the active CONVERSATION
  // (needs "storage"). This is the ONLY channel through which plugin state survives a
  // reload or conversation-switch — see §8. Writes are durable; the host re-hydrates
  // them when the conversation is restored.
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    keys(): Promise<string[]>
  }

  // lifecycle hooks the plugin can implement
  on(event: 'load' | 'unload' | 'reload', cb: () => void): void
}
```

**Not exposed:** direct filesystem, direct process spawn, direct SDK access, raw IPC. A
plugin that needs privileged work declares a `backend` module and a permission; the host
mediates. This is the line that keeps a malformed, buggy, or runaway plugin contained —
fault containment and a clean coupling signature, not a defense against an adversary.

## 4. Permissions

Declared in the manifest, enforced by the host. Minimum useful set:

- `data:subscribe`, `data:publish` — read / write data channels (conversation-scoped
  sources: files, bash taps, plugin-published topics).
- `data:write` — write UTF-8 text files inside the conversation cwd (`atelier.data.writeFile`).
  Split from `data:subscribe` because mutating the workspace is a different capability class than
  observing it. Atomic, size-capped, cwd-bounded host-side.
- `net:fetch` — host-side HTTP: both subscribing to `url:` channels AND the general
  `atelier.net.fetch(url, opts)` request verb (method/headers/body/binary, capped, cookie-isolated).
  Split from `data:subscribe` because network reach is a different capability class than reading the
  conversation's own files.
- `browser:embed` — a live host-owned Chromium surface over the pane (`atelier.browser.*`).
  Split from `net:fetch` because executing a remote page's JS is a different capability class
  than fetching its text. The surface is host-composited and hardened; the plugin sandbox never
  holds the webview itself.
- `agent:read`, `agent:send` — observe / drive agent instances. `agent:read` also covers
  `agent.history(limit?)` (bounded trace backfill).
- `agent:compose` — stage text into this conversation's chat composer without sending
  (`atelier.agent.compose`). Narrower than `agent:send` (which submits a turn).
- `fs:list` — non-recursive, cwd-scoped directory listing (`atelier.fs.list`). Names only (with an
  `ignored` flag) — narrower than `data:subscribe`, which tails file contents.
- `shell:open` — open a cwd-scoped file in the OS default handler (`atelier.shell.openPath`). Hands a
  path to the OS shell, a distinct coupling class from reading.
- `os:notify` — OS-level attention: notifications, taskbar flash/badge, window-focus queries
  (`atelier.os.*`).
- `storage` — per-plugin persisted KV (pane via `atelier.storage.*`; a service backend via the
  `{ id, storage: … }` parentPort protocol — see §5).
- `tools` — register agent tools (requires a `backend` module).

Permissions are **capability declarations**, not security enforcement: they document a
plugin's coupling surface up front (shown in the sidebar before load) and keep an
agent-authored plugin from _accidentally_ reaching further than intended. The host grants
only what's declared.

## 5. Agent tools contributed by plugins

When a plugin with `kind` `tool`/`both` loads, the host registers each `manifest.tools`
entry as an in-process MCP tool on the SDK side (`tool(name, desc, zodSchema, handler)`),
available to all agent instances (or scoped — see open question). Invocation flows:
agent calls the tool → SDK → host → plugin backend child process → result back to
the agent. This is how a plugin gives the agent _new capabilities_, not just a new view.
Unloading the plugin unregisters the tools.

**Tool input schemas.** Each `tools[]` entry has `{ name, description, inputSchema, timeoutMs? }`.
`inputSchema` is a `{ field: descriptor }` map; a descriptor is either the shorthand string
(`"string"|"number"|"boolean"`, trailing `?` = optional) or a JSON-Schema-subset object
(`{ type, items, properties, required, enum, description, optional }`, nesting capped at depth 4).
`timeoutMs` overrides the default 30s per-call cap (max 600000).

**Backends: on-demand vs. service.** By default a backend is an on-demand tool responder — spawned
lazily on the first tool call, idle otherwise, killed on disable/reload. Set `"service": true`
(requires `backend`) to make it a long-running service: spawned when the plugin is first enabled in a
conversation, kept alive until it's disabled in the last one. The child talks to the host over
`process.parentPort`: host → `{ id, tool, input, conversationId? }`, child → `{ id, result | error }`;
plus lifecycle `{ hello: { pluginId, service, cwd? } }` on spawn and `{ enable | disable: {
conversationId, cwd? } }` as a service is toggled (the `cwd` and per-invoke `conversationId` let a
backend scope its work). A service may push unsolicited `{ publish: { conversationId, channel, data }
}` onto a DataBus channel of a conversation it's enabled in (needs `data:publish`).

**Panel→backend RPC.** A pane calls its own service backend via `atelier.backend.call(op, params?,
timeoutMs?)`: the host posts `{ id, rpc: { conversationId, op, params } }` and the backend replies
`{ id, result } | { id, error }` (same 30s default / 600s max timeout as a tool). No extra permission
— a pane only ever reaches its own backend. This replaces abusing the DataBus for request/response.

**Backend storage.** A backend needs config the pane wrote even when the pane is closed. It reads/
writes the SAME per-(conversation, plugin) storage by posting `{ id, storage: { op: 'get' | 'set' |
'keys', conversationId, key?, value? } }` and awaiting the matching `{ id, result } | { id, error }`.
Gated by the plugin's `storage` permission. (See `/plugins/examples/tool-plugin/backend.cjs` for the
tiny correlate-by-id helper.)

Containment: a backend that crashes within 5s of spawn 3× in a row is wedged (calls rejected) until
the plugin is reloaded; each child's V8 heap is capped (`--max-old-space-size=512`).

## 6. The self-hosting loop (why the folder format matters)

Because a plugin is just files under `/plugins/`, an agent instance pointed at the Atelier
repo can author one with its normal Write tool: create the folder, `manifest.json`, and
entry. The `/plugins` watcher surfaces it in the sidebar; the user loads it; no restart.
This is the bridge from "I iterate via Claude Code CLI" to "I iterate from inside Atelier."

**Workspace plugins (Phase 7).** An agent working in any project can also author a plugin under
`<cwd>/.atelier/plugins/<id>` — no access to the Atelier repo needed. A per-cwd registry discovers
it, it **auto-enables for the authoring conversation**, is shared by any conversation opened on that
cwd, and travels with the repo (git). Identical contract to a global plugin; same host API, same
per-(conversation, plugin) storage. On an id collision the **global plugin wins** and the workspace
copy is shown as invalid ("shadowed"). Asset URLs for a workspace plugin use an encoded host
(`atelier-plugin://w--<cwd-hash>--<id>/`), but the plugin still sees its bare `id` everywhere.

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

- **State lives in `storage`.** A plugin's _only_ guaranteed-restorable state is what it writes
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
  records it in the conversation's layout and restores it. The plugin only persists _content/state_.

Design implication: write plugins so that `load` can fully reconstruct the pane from `storage`
alone. Treat every mount as a potential restore.

## 9. Open questions (record answers in docs/DECISIONS.md)

> **See docs/PLUGIN_ARCHITECTURE.md** for the resolved design: per-conversation enablement
> (app-wide registry), context pinning (`contextExports` + `context.update` + host injection),
> and universal agent control (`plugin_control` over a `control:<pluginId>` channel), plus the
> dos & don'ts that protect these invariants.

- Tool scoping: are plugin-contributed tools global to all instances, or per-instance
  opt-in? Default global; revisit if it gets noisy.
- Sandbox tech: Electron `<webview>` vs sandboxed iframe + preload. Pick one early and keep
  the host API identical across it.
- Versioning: a `apiVersion` field in the manifest so the host can reject incompatible
  plugins as the host API evolves. Add when the API first changes.
