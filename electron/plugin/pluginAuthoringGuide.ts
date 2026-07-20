import { PLUGIN_PERMISSIONS, DOCK_POSITIONS } from '../shared/plugins.js'

// The text returned by the built-in `plugin_authoring_guide` tool. A single, self-contained brief
// the agent reads before authoring a plugin: the manifest contract, the sandbox host API
// (window.atelier), the hard rules/invariants, and a minimal working example. Enum values are
// sourced from the real schema constants (PLUGIN_PERMISSIONS / DOCK_POSITIONS) so the guide cannot
// silently drift from what the registry actually validates.

export function pluginAuthoringGuide(): string {
  const perms = PLUGIN_PERMISSIONS.map((p) => `"${p}"`).join(', ')
  const docks = DOCK_POSITIONS.map((d) => `"${d}"`).join(', ')
  return `# Authoring an Atelier plugin

A plugin is ONE folder containing a \`manifest.json\` and (for a panel) an HTML entry file. The
folder name MUST equal the manifest \`id\`. Everything a plugin can do it does through the sandbox
host API \`window.atelier\` — never fs, IPC, or the SDK directly.

## manifest.json

Required:
- \`id\` — lowercase letters, digits, hyphens only; MUST match the folder name.
- \`name\` — human-readable display name.
- \`version\` — any non-empty string (e.g. "0.1.0").

Optional:
- \`description\` — what the plugin is for (may be multi-line). Shown in the catalog and describe_plugin.
- \`icon\` — a single-path 16px line-icon SVG \`d\` string (no fill; stroke only).
- \`kind\` — one of "panel", "tool", "both" (default "panel").
- \`entry\` — the HTML file (e.g. "index.html"); REQUIRED when kind is "panel" or "both".
- \`backend\` — a JS entry for a child-process worker (only for tool logic; NEVER hot-reloaded in-process).
- \`service\` — true = the backend is a long-running SERVICE: spawned when the plugin is first enabled
  in a conversation (not lazily on a tool call), kept alive until disabled in the last one, and may
  push onto DataBus channels (needs "data:publish"). Requires \`backend\`. Default false = on-demand.
- \`permissions\` — array from: ${perms}. Grant only what you use.
- \`defaultDock\` — one of ${docks} (default "right").
- \`tools\` — agent tools the plugin contributes; backed by \`backend\`. Each: { name, description,
  inputSchema, timeoutMs? }. \`timeoutMs\` overrides the 30s per-call cap (max 600000) for a slow tool.
  \`inputSchema\` is a { field: descriptor } map; a descriptor is EITHER the shorthand string
  ("string"|"number"|"boolean", trailing "?" = optional) OR a JSON-Schema-subset object
  ({ type: "string"|"number"|"integer"|"boolean"|"array"|"object", items, properties, required[],
  enum[] (strings), description, optional }). Top-level object fields are required unless optional:true.
- \`contextExports\` — persistent documents (see below).
- \`systemInstruction\` — { key, maxTokens }: a standing instruction appended to the system prompt,
  sourced from the same \`ctx:<key>\` storage as an export but NOT re-injected per turn (stays cached).

### contextExports — the heart of an agent-facing plugin

Each entry: \`{ key, label, format, maxTokens, inject, readonly, description }\`.
- \`key\` — stable id (used in storage and the generated tool name).
- \`label\` — section heading shown to the agent.
- \`format\` — "markdown" | "text" | "json" (default "text").
- \`maxTokens\` — budget; the injected value is capped at ~maxTokens×4 chars.
- \`inject\` (default true) — when true the current value is fed back into the agent's context every
  turn. false = "push-only": the write-tool still exists but the value is not re-injected (for large
  data the agent sends to a pane but doesn't want echoed back).
- \`readonly\` (default false) — when true the value is injected but NO write-tool is generated: only
  the pane (i.e. the user) can change it. Use for a user-authored directive. Injected only when non-empty.
- \`description\` — extra guidance appended to the write-tool's description (e.g. the exact JSON shape).

For each PINNED export of an ENABLED plugin the host automatically:
1. Injects its value into the agent's \`<atelier-context>\` each turn (unless inject:false or readonly-empty).
2. Registers two MCP tools (unless readonly): \`set_<id>__<key>\` (replace the whole value) and
   \`edit_<id>__<key>\` (targeted find-and-replace). The pane and the agent read/write the SAME value.

Values persist per-conversation under storage key \`ctx:<key>\` (survive Clear chat, restart, pane close).

### Author guide + defaults

- A per-export usage guide lives in plugin storage under \`guide:<key>\` (NOT a context export). The
  host injects it as a read-only "how to use this section" preamble; the agent's set_ tool cannot
  touch it. The pane writes it via \`window.atelier.storage.set('guide:<key>', text)\`.
- Ship a \`defaults.json\` (\`{ "storageKey": value }\`) in the folder to seed any never-written key —
  starter content, usage guides, a system instruction. An explicit empty string is respected (not re-seeded).

## window.atelier (the sandbox host API)

Injected into every panel. All calls are async (return Promises) unless noted.
- \`storage.get(key) / set(key, value) / keys()\` — this plugin's private key/value store. Always available.
- \`context.get(key) / set(key, value)\` — read/write a contextExport value. Needs permission "context".
- \`data.subscribe(channel, cb) / unsubscribe(channel) / publish(channel, value)\` — the DataBus. cb
  fires with the current value on subscribe and on every change. Channels include "file:<cwd-path>"
  (live-tailed file) and "url:<href>" (host fetch; needs "net:fetch"). Needs "data:subscribe"/"data:publish".
- \`data.history(channel, limit?)\` — recent values on a channel (oldest→newest, bounded), for a pane
  that mounts after data has flowed. Needs "data:subscribe" (+ "net:fetch" for url: channels).
- \`data.readAsset(path)\` — read a cwd-scoped binary (image/pdf/audio/video/text, ≤10MB) as
  { dataUrl } | { error }. Needs "data:subscribe".
- \`net.fetch(url, opts?)\` — host-side HTTP (the pane has no network). opts:
  { method?, headers?, body?, timeoutMs?, binary? }; resolves to
  { status, statusText, headers, bodyText? | bodyBase64? } | { error }. http(s) only, capped
  (2MB req / 4MB resp / 60s), cookie-isolated. Needs "net:fetch".
- \`data.writeFile(path, content)\` — write a UTF-8 text file at a cwd-relative path (parents created,
  atomic, ≤5MB) as { ok:true } | { error }. Needs "data:write". Refuses paths outside the cwd.
- \`agent.info()\` — { id, title, cwd, status } for THIS conversation. Needs "agent:read".
- \`agent.onEvent(cb)\` — subscribe to this conversation's live event stream (status, streamed text,
  tool_use/tool_result, result, error); returns an unsubscribe fn. Needs "agent:read".
- \`agent.send(text)\` — send a user message into this conversation, as if typed. Needs "agent:send".
- \`layout.dock(position) / float() / setTitle(title)\` — control this pane's docking/title.
- \`layout.onResize(cb)\` — cb fires with this pane's { w, h } on resize; returns an unsubscribe fn.
- \`browser.open(url)/close()/back()/forward()/reload()/stop()/setBounds(rect)/read(opts?)\` — drive a
  host-owned Chromium surface over this pane; \`read\` returns { url, title, text, links, html? }. Plus
  \`browser.exec(js)\` → { ok:<json> } | { error } (page is UNTRUSTED — the result is DATA, never code;
  capped 64KB), and \`browser.click(selector)\` / \`browser.fill(selector, value)\`. All need "browser:embed".
- \`on(event, cb)\` — lifecycle + push events: "load" (fire your setup here), "unload", "reload",
  "context" (payload { key }: one of your exports changed EXTERNALLY — re-read it; note a pane's OWN
  context.set does NOT echo back as a 'context' event, so update your own DOM directly after writing).
- \`pluginId\` — this plugin's id.
Theme tokens (var(--surface), var(--text), var(--accent), …) are pushed in as CSS variables; use them.

The entry HTML must load the runtime first: \`<script src="atelier-plugin://__runtime__/atelier.js"></script>\`.

## Hard rules (violations are bugs)

1. Reach the app ONLY through window.atelier. No direct fs / IPC / SDK / network.
2. The pane is sandboxed but runs at its OWN origin (atelier-plugin://<id>), so you MAY use ES
   modules (\`<script type="module">\`), \`fetch()\` your own folder assets, workers, and IndexedDB —
   all self-scoped, no reach into the app or other plugins. BUT durable state still goes ONLY through
   storage/context: IndexedDB/localStorage are a per-origin CACHE (not conversation-scoped, wiped when
   partition data is cleared) — nothing there is guaranteed to survive. A crashing pane must not take
   the app down.
3. Request the minimum permissions. A capability you didn't declare is denied at the boundary.
4. One folder = one plugin; \`id\` == folder name; a panel plugin MUST declare \`entry\`.
5. Debounce writes (context/storage) — a keystroke should not spam the host. ~300–400ms is typical.
6. Backend/tool logic runs as a child process (\`backend\`), never hot-reloaded in-process. UI hot-reloads.
   Backend protocol (\`process.parentPort\`): the host posts { id, tool, input } → reply { id, result }
   or { id, error }. Lifecycle messages you may ignore or use: { hello: { pluginId, service } } on
   spawn, { enable | disable: { conversationId } } as a SERVICE is toggled. A service may push
   unsolicited { publish: { conversationId, channel, data } } to a conversation it's enabled in
   (needs "data:publish"); a pane subscribed to that channel receives it. A backend that crashes 3×
   on spawn is wedged until the plugin is reloaded; its V8 heap is capped (~512MB).

## Where a plugin lives (global vs workspace)

- **Global:** \`/<atelier>/plugins/<id>\` — shipped with the app, available to every conversation.
- **Workspace:** \`<cwd>/.atelier/plugins/<id>\` — authored inside a project. You can create one here
  with your normal file tools; it is discovered without a restart, AUTO-ENABLES for this conversation,
  is visible to any conversation opened on the same folder, and travels with the repo (git). This is
  the intended way for you to build yourself a tool mid-task. Its storage/permissions/contract are
  identical to a global plugin.
- **Shadowing:** if a workspace plugin's \`id\` collides with a global one, the GLOBAL plugin wins and
  the workspace copy is shown as invalid ("shadowed"). Pick a distinct id.

## Minimal example

manifest.json:
{
  "id": "notepad",
  "name": "Notepad",
  "version": "0.1.0",
  "description": "A scratch note the agent and user share.",
  "kind": "panel",
  "entry": "index.html",
  "permissions": ["context"],
  "defaultDock": "right",
  "contextExports": [
    { "key": "note", "label": "Shared note", "format": "markdown", "maxTokens": 800 }
  ]
}

index.html:
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script src="atelier-plugin://__runtime__/atelier.js"></script>
  </head>
  <body style="margin:0;background:var(--surface);color:var(--text)">
    <textarea id="n" style="width:100%;height:100vh;background:transparent;color:inherit;border:0"></textarea>
    <script>
      const n = document.getElementById('n')
      let t = null
      window.atelier.on('load', async () => {
        n.value = (await window.atelier.context.get('note')) || ''
        n.addEventListener('input', () => {
          clearTimeout(t)
          t = setTimeout(() => window.atelier.context.set('note', n.value), 350)
        })
        // Re-read when the agent edits the note via its set_notepad__note tool.
        window.atelier.on('context', async (p) => {
          if (p && p.key === 'note' && document.activeElement !== n) {
            n.value = (await window.atelier.context.get('note')) || ''
          }
        })
      })
    </script>
  </body>
</html>`
}
