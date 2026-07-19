# 04 — Backend services: persistent workers, DataBus publish, rich tool schemas, resource limits

**Goal:** backends today are tool-call responders only — spawned lazily on the first tool
invoke (`PluginBackendManager.ts`), request/response over `{id,tool,input}`, killed on
disable/reload, hard 30 s timeout, and a flat `{field:"string"|"number"|"boolean"}` input
schema. That shape forbids the plugin class where a backend is the _point_: build watchers,
port monitors, pollers, language servers. This phase gives backends a service lifecycle,
a push channel, expressive tool contracts, and the containment bounds the review flagged.

## Manifest additions (`electron/shared/plugins.ts`)

```jsonc
{
  "backend": "backend.cjs",
  "service": true, // NEW: spawn on enable, keep alive (default false = on-demand tool responder)
  "tools": [
    {
      "name": "run_build",
      "description": "…",
      "timeoutMs": 300000, // NEW: per-tool, default 30000, max 600000
      "inputSchema": {/* NEW: JSON-Schema subset, see below */}
    }
  ]
}
```

`service: true` requires `backend`; valid with or without `tools`. Keep the existing flat
`inputSchema` map working (back-compat — every shipped manifest uses it).

## Child protocol (extend, don't replace)

Current: parent → `{id, tool, input}`; child → `{id, result|error}` via
`process.parentPort`. Add, all optional for old backends:

- **parent → child on spawn:** `{ hello: { pluginId, service: boolean } }` — lets a service
  start its loops only when run as a service.
- **child → parent (unsolicited):** `{ publish: { conversationId, channel, data } }` —
  main validates that (a) the plugin declares `data:publish`, (b) the plugin is enabled for
  `conversationId`, then routes to `dataBus.publish`. Invalid → dropped with a
  `console.warn`, never a crash. This is the backend→pane push path: a service publishes,
  the subscribed pane renders.
- **parent → child on conversation close/disable:** `{ bye: { conversationId } }` (advisory;
  the child may ignore it).

The backend cannot _subscribe_ in v1 (panes and the agent are the consumers; a backend that
needs input gets it via tool calls). Record as an explicit non-goal.

## Lifecycle

- `service: true` → `PluginBackendManager` spawns on first **enable** (any conversation)
  and keeps the child until the plugin is disabled in the _last_ conversation that had it
  enabled, or on reload/quit. The manager needs an enable/disable refcount API called from
  the `pluginsSetEnabled` handler in `main.ts` (which today only calls `backends.stop` on
  disable — extend it).
- On-demand backends (`service` absent/false): behavior unchanged.
- **Fix while here (`main.ts:515-520`):** `pluginsReload` currently ignores its parsed
  `pluginId` and calls `backends.stopAll()` — make it stop only the named plugin's backend
  (ARCH_REVIEW P1 #11).

## Containment (the review's #12 — mandatory in this phase, not optional)

- `utilityProcess.fork(..., { resourceLimits })` in `utilityBackendTransport`
  (`main.ts:122-136`): start with `maxOldGenerationSizeMb: 512` (constant, documented).
- **Respawn budget** in `PluginBackendManager`: a child that exits ≤ 5 s after spawn counts
  as a crash; 3 crashes in a row → mark the plugin's backend wedged, reject invokes with a
  clear message ("backend crashed repeatedly — fix the plugin and reload"), clear the wedge
  on explicit plugin reload. Mirrors the Session restart budget philosophy
  (`AgentManager.ts` `restarts`). Unit-test via the injected transport.
- A service child's unsolicited messages are Zod-parsed in main before acting.

## Rich tool schemas

Extend `jsonSchemaToZodShape` (`electron/plugin/pluginTools.ts`) to accept a JSON-Schema
subset alongside the legacy flat map (discriminate: legacy values are strings; JSON Schema
values are objects/`{type:…}`):

- `type: string|number|boolean|array|object`, `items`, `properties`, `required`, `enum`
  (strings), `description` (→ `.describe()` — this is what the agent reads; it matters).
- Depth cap 4, unknown constructs → `z.unknown()` (never throw on a weird manifest —
  invalid-manifest philosophy is "surface, don't crash").
- Unit tests: legacy map unchanged; nested object; array of enum; description propagation;
  depth-cap fallback.

## Acceptance criteria

1. Example service plugin (extend `tool-plugin` or add `plugins/examples/watch-demo`): a
   service backend that publishes a heartbeat + file-derived value onto a channel its pane
   subscribes to; enable → pane ticks; disable → child dies (verify no orphan via process
   list); re-enable → resumes.
2. Crash-loop test: a backend that exits immediately gets wedged after 3 attempts with the
   clear error; reload clears it. (Injected-transport unit test.)
3. A tool with `timeoutMs: 120000` survives a 60 s handler; default tools still time out at
   30 s.
4. Rich-schema tool callable by the agent with a nested input; agent sees field
   descriptions (check via the SDK tool listing or a live call).
5. `pluginsReload('x')` no longer kills plugin `y`'s backend (unit test on the handler
   logic or manager).
6. Gate green; PLUGIN_API §2/§5 + authoring guide updated (service lifecycle, publish
   protocol, schema subset, limits); DECISIONS entry.
