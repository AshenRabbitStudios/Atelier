# 07 — Workspace-local plugins: re-opening F4b under the corrected framing

**Goal:** let a conversation's agent author a plugin that is available in that workspace
without installing it into the global `/plugins` catalog. This was deferred
(PROGRESS 2026-07-18) on two grounds: (1) the registry is global and pervasive, (2) "trust
model — agent authoring code that loads into the GUI is a capability escalation." Ground (2)
is **void** under the 2026-07-19 framing: agent-authored runtime plugins are the _intended
use case_ (PLUGIN_API "Why the sandbox exists", reason 1). What remains is the engineering
problem and two product decisions. This doc narrows to one recommended design.

## DECISIONS — RESOLVED (user, 2026-07-19)

- **D1 — Scope semantics → WORKSPACE-LOCAL.** Plugins live at `<cwd>/.atelier/plugins/<id>`:
  travels with the repo (git-visible), and every conversation opened on that cwd sees it.
  (Not strictly conversation-private — that's the accepted trade for "tooling belongs to the
  project.")
- **D2 — Enable friction → AUTO-ENABLE.** When the agent authors a workspace plugin, it
  auto-enables for the authoring conversation (no click-to-enable gate). Implication for the
  implementer: the workspace registry's watcher, on discovering a NEW valid workspace plugin,
  sets that conversation's `ConversationPluginState` for it to `{enabled:true}` and pins its
  context exports — the same effect as `pluginsSetEnabled(...true)`, fired automatically. A
  broken/invalid manifest must NOT auto-enable (it surfaces as invalid in the rail as usual).
  Because this mounts freshly-written sandboxed code without a click, lean on the containment
  invariants (Phase 0 #3/#4, fault isolation) — that is the whole point of the sandbox.

## Recommended design (assuming D1 = workspace-local)

### Discovery: a second registry instance, not a scoped rewrite

Do NOT thread conversation-scope through the global `PluginRegistry` (the PROGRESS entry
correctly calls that pervasive). Instead:

- `PluginRegistry` is already constructor-parameterized by root dir — instantiate **one
  extra registry per distinct open cwd** (`new PluginRegistry(join(cwd, '.atelier/plugins'),
onChange)`), managed by a small `WorkspaceRegistries` map in `main.ts` keyed by cwd,
  created on conversation create/restore, stopped when the last conversation on that cwd
  closes. `start()` is already safe when the root doesn't exist.
- Introduce a **resolver**: `resolvePlugin(conversationId | cwd, pluginId) →
DiscoveredPlugin | undefined` that checks the global registry first, then the cwd's
  workspace registry. **Global wins id collisions**; the workspace copy surfaces as
  `invalid` with error `id shadowed by a global plugin` (visible in the rail, no silent
  confusion).
- Audit every `plugins.get(...)` / `plugins.dirOf(...)` / `plugins.list()` call site in
  `main.ts`, `contextTools.ts`, `pluginTools.ts`, `introspection.ts` and route it through
  the resolver. All of these already receive `conversationId` or can derive cwd via
  `agents.cwdFor` — this audit is the bulk of the phase and must be exhaustive (grep for
  `registry.get|registry.dirOf|registry.list|plugins.get|plugins.dirOf|plugins.list`).

### Asset serving: encode the workspace in the protocol host

`atelier-plugin://<pluginId>/` carries no conversation/workspace context, and the protocol
handler resolves against the global registry only (`protocol.ts:54`). Encode it in the
host, which is already the plugin-identity channel (`runtime.ts` reads
`location.hostname`):

- Workspace plugin frames load `atelier-plugin://w--<workspaceKey>--<pluginId>/` where
  `workspaceKey` is a short stable hash of the cwd (main keeps the `hash → cwd` map in
  `WorkspaceRegistries`; hostnames must stay lowercase-safe, hence the hash rather than an
  encoded path).
- `handlePluginProtocol` parses the `w--` prefix → resolves via that workspace's registry;
  bare hosts resolve globally (unchanged). Traversal guard identical.
- `runtime.ts`: `pluginId` must become the _bare_ id (strip the `w--<key>--` prefix) so the
  RPC `pluginId` matches the manifest id; `PluginPane` gets the full host as its frame src
  but continues keying permissions/relay by bare id + its conversation. Keep this mapping
  in ONE shared helper (`electron/shared/plugins.ts`: `encodePluginHost`/
  `decodePluginHost`) used by protocol, PluginPane, and runtime-injection — three
  hand-rolled parsers is how this goes wrong.

### Enablement, storage, tools, context

- No schema change: `ConversationPluginState` already keys by plugin id per conversation;
  a workspace plugin enables exactly like a global one (per-conversation). Backend spawn
  (`pluginTools.ts` `backendPath`) and context tools already work off `dirOf` → they come
  free once the resolver audit is done.
- Storage stays per-(conversation, plugin) — unchanged, no leak surface.
- `list_plugins`/`describe_plugin`/environment briefing: include workspace plugins for that
  conversation, marked `[workspace]`. The briefing is built per-conversation already
  (`main.ts:164-167` passes cwd) — but NOTE: the briefing is deliberately cache-stable;
  adding workspace plugins makes it change when the agent authors one. That is correct and
  desirable (the agent must learn its new plugin exists) — a one-time cache invalidation
  per authored plugin, not per-turn churn.

### Authoring flow (with D2 = (a))

Agent writes `<cwd>/.atelier/plugins/<id>/...` with normal Write tools (it owns the cwd) →
the workspace registry's watcher picks it up → rail shows it (badged "workspace") → user
enables → live. No new agent tool needed; `plugin_authoring_guide` gains a section on the
workspace path + the shadowing rule.

## Containment invariants

- Same sandbox, same relay, same permission gates — a workspace plugin is not a new trust
  class, just a new discovery source.
- A broken workspace manifest surfaces as invalid in the rail (registry already guarantees
  this).
- Registry watchers on cwds must be cleaned up on last-conversation-close (fs watcher leak
  otherwise) — unit-test the `WorkspaceRegistries` lifecycle with injected roots.

## Acceptance criteria

1. Agent authors a plugin under `<cwd>/.atelier/plugins/demo` mid-conversation → it appears
   in the rail without restart → user enables → pane + tools + context exports all work.
2. Same cwd in a second conversation sees it; a different cwd does not.
3. An id collision with a global plugin shows the shadowed error; the global one wins
   everywhere.
4. Deleting the folder removes it from the rail; enabled state for it degrades gracefully
   (no crash; pane shows the standard invalid/missing state).
5. `WorkspaceRegistries` lifecycle unit tests (create/share/cleanup, watcher release).
6. Gate green; PLUGIN_API, authoring guide, PROGRESS (close F4b), DECISIONS (record D1/D2
   answers) updated.
