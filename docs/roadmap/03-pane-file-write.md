# 03 — Pane file writes: `data.writeFile` (permission `data:write`)

**Goal:** panes currently have read-only filesystem reach (`file:` tails, image `readAsset`)
and no write verb at all — an editor, scratchpad, exporter, or any artifact-producing pane
must beg the agent to do its writes. Add one cwd-scoped write verb. It is exactly as
containable as the existing read path (same resolver), and it turns panes from viewers into
tools.

## Contract

- New permission **`data:write`** in `PLUGIN_PERMISSIONS` (`electron/shared/plugins.ts`).
  Separate from `data:subscribe`/`data:publish` because mutating the workspace is a
  different coupling class than observing it — a plugin's manifest should confess it.
- Runtime:

```js
// Write a UTF-8 text file at a cwd-relative path (parents created). Needs "data:write".
// Returns {} or { error }. Refuses paths outside the conversation cwd.
writeFile: function (path, content) { return call('data', 'writeFile', [path, content]) }
```

- Text only, UTF-8, in v1. **No binary write, no delete, no rename, no mkdir verb** — keep
  the surface minimal until a real plugin needs more (record follow-ups, don't build them).
- Size cap: **5 MB** per write (constant next to `MAX_ASSET_BYTES` in
  `electron/plugin/assets.ts` or a new `electron/plugin/fileWrite.ts`).

## Implementation

1. `electron/plugin/fileWrite.ts` (new, unit-testable like `assets.ts`):
   `createFileWriter(resolvePath)` → `(conversationId, rel, content) => Promise<{ok:true} | {error}>`.
   - `resolvePath` = the existing `resolveWithinCwd` from `main.ts:176-183` (inject it; do
     not duplicate). Null → `{ error: 'outside the conversation folder' }`.
   - Enforce the size cap; `mkdir -p` the parent; **atomic write** (temp file in the same
     directory + rename — reuse the atomic-write helper introduced by Phase 0 / ARCH_REVIEW
     P0 #5; if that phase extracted no shared helper, extract one now and use it in both
     places).
   - Every failure returns `{ error }`, never throws (assets.ts pattern).
2. IPC `pluginWriteFile` (`{ conversationId, pluginId, path, content }`), Zod schema in
   `events.ts`, preload method, main handler with **main-side permission + enablement
   check** (the verb checklist in README — this is a mutating verb; do not ship it
   renderer-gated only).
3. Relay branch in `PluginPane.tsx` under the `data` namespace, gated on `data:write`.
4. Interaction note for the docs: a write to a file some pane is tailing via `file:` will
   echo back through the watcher — that is correct behavior (the tail shows truth), just
   document it so plugin authors expect the round-trip.
5. Docs: PLUGIN_API §3/§4, authoring guide + sync test.

## Containment invariants

- cwd scoping via the single shared resolver — no second path-containment implementation.
- Atomic writes — a crashing host mid-write must not corrupt user files.
- The cap + text-only bound the blast radius of a confused agent-authored plugin looping
  writes; the DataBus echo makes runaway writes _visible_ rather than silent.

## Acceptance criteria

1. Unit tests on `fileWrite.ts`: happy path, parent creation, out-of-cwd refusal (`..`,
   absolute path, drive-letter path on win32), size-cap refusal, error-shape on locked file.
2. End-to-end: a scratch plugin with `data:write` saves a file; the living-doc pane tailing
   it updates; a plugin without the permission is refused at BOTH the relay and the main
   handler (test the main check directly).
3. Gate green; PLUGIN_API + guide updated; DECISIONS entry (one line: new permission, caps,
   v1 scope).
