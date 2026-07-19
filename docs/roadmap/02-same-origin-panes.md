# 02 — Same-origin panes: ES modules, fetch, IndexedDB for plugin frames

**Goal:** lift the `sandbox="allow-scripts"`-only restriction on plugin iframes
(`PluginPane.tsx:409`) by adding `allow-same-origin`. Today every pane runs at an opaque
origin, which forbids ES modules loaded over `atelier-plugin://`, `fetch()` of the plugin's
own assets, IndexedDB/localStorage, and workers — this is why hologram must ship a
hand-bundled IIFE (`DECISIONS.md` 2026-06-29: "ES-module + fetch() loading over
atelier-plugin:// is unverified… deliberately avoided"). Agents should be able to author
normal multi-file ES-module plugins.

## Why this is safe under the corrected framing (and even under the old one)

With `allow-same-origin`, the frame's origin becomes `atelier-plugin://<pluginId>` — its
**own** origin, unique per plugin:

- It is still cross-origin to the renderer (`http://localhost` dev / `file://` prod), so it
  gains zero reach into the app document, `window.atelier` stays postMessage-only.
- It is cross-origin to every other plugin (`atelier-plugin://other`), so no
  cross-contamination.
- The protocol handler (`electron/plugin/protocol.ts`) already refuses path traversal out
  of the plugin's folder and is registered `standard: true, supportFetchAPI: true,
corsEnabled: true` — fetch support was anticipated.
- What it _does_ gain: same-origin storage (IndexedDB/localStorage keyed to its own
  origin), module scripts, workers. All self-scoped.

One behavioral change to verify: with a real origin, `location.hostname` (which
`runtime.ts:10` uses as `pluginId`) still returns the host of the custom scheme URL —
it does today (standard scheme), and must keep doing so.

## Work

1. `PluginPane.tsx`: `sandbox="allow-scripts allow-same-origin"`.
2. Verify matrix (add a throwaway test plugin, or extend an example):
   - `<script type="module" src="./main.js">` with a relative `import './lib.js'` — loads.
   - `fetch('./data.json')` — resolves with the plugin-folder file (protocol serves it,
     content-type from `protocol.ts` map; add `.wasm` → `application/wasm` to
     `CONTENT_TYPES` while here).
   - `indexedDB.open(...)` — works (note: this storage is NOT the durable `storage` API;
     PLUGIN_API §8's "only `storage` is guaranteed-restorable" contract is unchanged —
     IndexedDB is per-plugin cache, wiped whenever Electron's partition data is cleared,
     and NOT conversation-scoped. Say this explicitly in PLUGIN_API and the authoring
     guide, or agents will start persisting state in the wrong place).
   - `postMessage` relay + theme push + `pluginId` detection still work.
3. Docs: PLUGIN_API.md §1/§3 (module plugins now first-class; storage-contract caveat),
   `pluginAuthoringGuide.ts` (recommend ES modules over IIFE bundles for new plugins).
4. Optional follow-up (separate commit, low priority): rebuild hologram as native ES
   modules and delete the esbuild bundle step — only if the verify matrix is fully green;
   otherwise leave the bundle (it works).

## Related investigation (do in this phase, report in PROGRESS.md)

**Does a plugin iframe get its own Chromium process?** If `atelier-plugin://` frames are
in-process with the renderer, a `while(true)` in pane JS hangs the whole app — a real
"plugin suicides Atelier" vector under the fault-containment mandate. Check via
`process.getProcessMemoryInfo`/Task Manager or `webFrame`/`app.getAppMetrics()` while a
pane runs a busy loop. Record the finding:

- If OOPIF (own process): note it — containment is real, no action.
- If in-process: file it as a known containment gap with the recommended fix (host panes
  in `<webview>` instead of iframe — the host API is postMessage-only by design precisely
  so the sandbox tech can be swapped, PLUGIN_API §9), but do NOT migrate in this phase.

## Acceptance criteria

1. Verify matrix all green; findings (incl. process-isolation answer) in PROGRESS.md.
2. Every existing example plugin still loads and functions (manual spot-check list:
   cognition, browser, bash-stream, hologram, data-table, cartographer).
3. Gate green; DECISIONS entry recording the sandbox change + the storage-contract caveat.
