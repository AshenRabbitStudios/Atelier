# workspace-explorer — design

A default `kind: "panel"` plugin: a collapsible file tree of the conversation's cwd, overlaid
with an **agent-activity heatmap** (reads vs. writes, decaying over time), with click-to-preview
(Shiki, read-only), double-click-to-open-externally, and a right-click "mention in chat".

Status: **design**. Grounded in PLUGIN_API.md, docs/PLUGIN_ARCHITECTURE.md,
docs/CONTEXT_SYSTEM.md, the current `electron/shared/events.ts` host surface, and proposal #7 in
docs/plugin-proposals/PROPOSALS.md. Passages marked **[EXTRAPOLATION]** go beyond what the docs
state and are my proposals, not settled contract. This design **depends on new host verbs** — see
[HOST-GAP](#5-host-gap).

---

## 1. Purpose + user stories

Atelier has no file browser. The user's model of "what is this repo / what has the agent been
touching" lives in a separate editor (PROPOSALS #7). This plugin makes the workspace and the
agent's **trace over it** spatial and legible, inside the workbench.

- **As a user new to a repo**, I want a tree of the cwd so I can orient before I trust the agent.
- **As a user watching a run**, I want files the agent recently _read_ to glow one way and files
  it _wrote_ to glow another, fading over time, so I can see at a glance that "it's been circling
  these four files" (the trace made spatial).
- **As a user**, I want to click a file and see a syntax-highlighted, read-only preview without
  leaving Atelier, and double-click to open it in my real editor when I want to edit.
- **As a user talking to a CLI-shaped agent**, I want to right-click a file and drop its path into
  the composer instead of typing it out — the quiet fix for the most annoying part of the flow.

Non-goals (v1): editing files in-pane (preview is read-only; editing is the external editor's job),
git status decoration beyond gitignore graying, multi-root workspaces (one cwd per conversation).

---

## 2. Panel UX

Single pane, `defaultDock: "left"` (orientation lives next to the rail; **[EXTRAPOLATION]** —
`right`/`center` are equally valid, user re-docks freely). Two regions, split vertically:

**Tree (top, primary).**

- Standard collapsible tree rooted at the conversation cwd. Folders expand/collapse; expansion set
  persists in `storage` so a remount restores the open state (PLUGIN_API §8 — treat every mount as
  a restore).
- Rows show the icon (folder/file-by-extension), name, and a **heat glow** (below). Directories
  roll up the max heat of their descendants so a collapsed folder still signals activity inside it.
- Lazy: a folder's children are listed only when it is first expanded (see [Performance](#6-performance)).

**Heat rendering.**

- Each file carries two independent heat values, `read` and `write`, each in `[0,1]`.
- **Reads vs. writes are distinguished by hue**, not just intensity: writes render on the accent/warm
  channel, reads on a cool channel (exact tokens from DESIGN_SYSTEM.md; **[EXTRAPOLATION]** on which
  vars). A file both read and written shows both (e.g. a warm fill with a cool ring). Intensity =
  the heat value → opacity of a left-edge bar or row-background wash.
- **Time decay.** Heat decays exponentially toward 0 with a half-life (default ~90 s, configurable
  in `storage`). Decay is computed at render time from the event timestamp, not by a background
  timer, so a closed/reopened pane recomputes correct current heat from stored `(path, kind, ts)`
  records. **[EXTRAPOLATION]** — half-life value and the decay-at-render approach.
- A small legend + a "freeze/clear heat" control. Hovering a hot row shows "read 3× · wrote 1× ·
  last 12s ago".

**Preview pane (bottom, collapsible).**

- Click a file → its text loads into a read-only Shiki-highlighted view (Shiki is the stack's code
  renderer per CLAUDE.md). Language inferred from extension. Large files are truncated with a
  "showing first N KB — open externally for the rest" marker.
- Binary/image files: images render via `atelier.data.readAsset` (bounded data: URL, §3 of the
  contract). Other binaries show a "binary file" placeholder with size.
- The preview updates live if the file changes while selected (it is backed by a `file:` tail —
  see [Data flow](#4-data-flow)).

**gitignore handling.**

- Ignored files/folders (`.gitignore` + `.git/`, `node_modules/`, etc.) are **shown but grayed and
  de-prioritized**, and collapsed by default — orientation shouldn't hide the repo, but noise
  shouldn't dominate. A toggle "hide ignored" removes them entirely; the toggle state persists.
- `.gitignore` parsing depends on the tree source actually honoring ignore rules. The cleanest
  design is for the **host** to compute ignore status when it lists a directory (it has fs + can
  read nested `.gitignore` files); the plugin just renders the `ignored` flag it receives. This is
  part of the listing HOST-GAP below. **[EXTRAPOLATION]** — that the host, not the plugin, owns
  ignore evaluation.

---

## 3. Manifest sketch

Matches the live schema (`PluginRegistry` Zod validation; fields as used by
`plugins/cartographer/manifest.json` and `plugins/examples/browser/manifest.json`). The
`permissions` marked **†** are **proposed new permissions** gating the new host verbs in
[HOST-GAP](#5-host-gap); without those verbs this manifest cannot function.

```jsonc
{
  "id": "workspace-explorer",
  "name": "Workspace Explorer",
  "version": "0.1.0",
  "description": "File tree of the conversation cwd with an agent-activity heat overlay (reads vs. writes, decaying over time). Click a file for a syntax-highlighted read-only preview; double-click to open it in your editor; right-click to mention its path in the chat composer.",
  "icon": "M2.5 3.2h4l1.2 1.4h5.8v8.2H2.5zM2.5 6.3h11",
  "kind": "panel",
  "entry": "index.html",
  "permissions": [
    "data:subscribe", // file: tails for preview + readAsset for images (existing)
    "agent:read", // observe tool_use/tool_result to build heat + learn cwd (existing)
    "storage", // expansion state, heat history, decay half-life (existing)
    "fs:list", // † list a directory, cwd-scoped, read-only (NEW — HOST-GAP A)
    "composer:insert", // † insert text into this conversation's composer (NEW — HOST-GAP C)
    "shell:openPath" // † open a cwd file in the OS default editor (NEW — HOST-GAP D)
  ],
  "defaultDock": "left"
}
```

Notes:

- **No `contextExports`** and **no `backend`** in v1: this pane is a viewer, not a context document,
  and needs no privileged tool responder. (A future variant could export a "recently-touched files"
  digest as a pinned context document — that reuses CONTEXT_SYSTEM.md's primitive and is out of
  scope here.)
- `icon` is a single-path 16px line glyph (folder-with-tab), distinct from siblings (PLUGIN_API §1).
- The existing `permissions` (`data:subscribe`, `agent:read`, `storage`) are real and already
  enforced; only the three **†** entries are new and require host work.

---

## 4. Data flow

### 4a. Listing + reading files (what fs access the host actually grants)

**Careful reading of the contract: the host grants NO directory listing today.** The plugin fs
surface in PLUGIN_API §3 / `AtelierAPI.plugins` is:

- `data.subscribe('file:<rel>', cb)` — tails **one** text file, cwd-scoped, live (`data:subscribe`).
  It is a DataBus channel (confirmed in `electron/plugin/runtime.ts`), not a lister.
- `data.readAsset(path)` — reads **one** cwd-scoped image as a bounded data: URL (`data:subscribe`).
- `data.writeFile(path, content)` — writes **one** cwd-scoped text file (`data:write`).
- `data.history` / `net.fetch` / `browser.*` — not fs.

There is **no verb that enumerates a directory**. The `resolveWithinCwd` scoping used by
`writeFile` (see `electron/plugin/fileWrite.test.ts`) resolves a single path and refuses escape; it
is not a lister. So:

- **Preview + live-update** are already possible: on file click, `data.subscribe('file:'+rel)` and
  render each payload with Shiki; `readAsset` for images. This needs no new host verb.
- **The tree itself is not possible with today's API** — enumerating the cwd requires a new listing
  verb. This is the central HOST-GAP (A).

### 4b. Learning about agent reads/writes

The plugin needs `agent:read` and subscribes via `atelier.agent.onEvent(cb)`, which forwards this
conversation's `AgentEvent` stream (PLUGIN_API §3; scoped to the pane's conversation). The relevant
event is the `tool_use` kind (see `electron/shared/events.ts`, `AgentEvent` union):

```ts
{ instanceId, kind: 'tool_use', messageId, toolUseId, name, input }
```

The plugin classifies by `name` + `input.file_path` (extrapolating the SDK's built-in tool names):

- **Read** (cool heat): `name === 'Read'`; also treat `Grep`/`Glob` hits as weak reads of the paths
  they touch if the path is present. **[EXTRAPOLATION]** — exact tool-name set.
- **Write** (warm heat): `name === 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit'`.
- Extract the cwd-relative path from `input.file_path` (SDK passes absolute paths; normalize against
  the cwd from `agent.info().cwd`). Non-file tools are ignored.

Each classified event appends a `{ path, kind: 'read'|'write', ts }` record to an in-memory ring and
to `storage` (bounded, newest-kept). Heat is derived from these records at render time (decay in §2).
Because records persist in `storage`, reopening the pane rebuilds the current heat correctly.

**Note on `fileWrite` events:** the repo has a `fileWrite` module (`electron/plugin/fileWrite.ts`),
but that is the **plugin→disk write path** (`data.writeFile`), not an _agent-activity_ feed — it does
not tell a plugin what the agent wrote. The observable source of agent reads/writes is the
`tool_use` AgentEvent stream, above. A dedicated, pre-classified activity feed would be cleaner and
is proposed as HOST-GAP B (optional).

**Freshness gap:** `onEvent` only delivers events to a _mounted_ pane. Activity that happened while
the pane was closed is not replayed. v1 accepts this (heat is a live, decaying signal). A fuller fix
would have the host retain a bounded per-conversation activity ring the pane can backfill from on
mount — folded into HOST-GAP B.

### 4c. "Mention in chat"

Right-click → "mention in chat" should insert the file's cwd-relative path (e.g. `` `src/foo.ts` ``)
into the **composer**, at the cursor, **without sending** — the user keeps typing around it.

Today the only agent-write verb is `atelier.agent.send(text)` (`agent:send`), which **submits a full
turn immediately**. That is the wrong primitive: it fires the message rather than staging text for the
user to edit. There is no composer-insert verb. → **HOST-GAP C.**

(A degraded v1 could copy the path to the clipboard and toast "path copied — paste into chat", using
no new verb. Acceptable stopgap, but it misses the point of the feature; the real design needs C.)

### 4d. "Open in editor"

Double-click → open the file in the user's external editor. The preload bridge already exposes
`app.openPath(path)` (`AtelierAPI.app.openPath`, IPC `app:open-path`) — but that is the **renderer's**
privileged bridge, **not** the plugin-facing `atelier` host API. A sandboxed plugin has no `app.*`.
So the plugin cannot open a path today. → **HOST-GAP D** (expose a cwd-scoped `shell.openPath` on the
plugin host, mediated + bounded, mirroring how `readAsset`/`writeFile` are cwd-scoped).

---

## 5. HOST-GAP

Four host additions. A/C/D are required for the described feature set; B is an optional quality
upgrade. Each follows the contract's existing patterns: cwd-scoped, Zod-validated at the receiving
side, permission-gated, error-returning (never throwing into the host).

### A. Read-only directory listing, cwd-scoped — **required** (the tree)

New host verb + permission `fs:list`:

```ts
// atelier.fs.list(dir?): dir is cwd-relative ('' = root). Read-only. Non-recursive (one level).
fs: {
  list(dir?: string): Promise<
    | { entries: { name: string; kind: 'file' | 'dir'; size?: number; ignored: boolean }[] }
    | { error: string }
  >
}
```

- Scoped with the same `resolveWithinCwd` guard `writeFile` uses (`electron/plugin/fileWrite.ts` /
  `.test.ts`): refuse any path escaping the cwd; return `{ error }` on denial, never throw.
- **Non-recursive** by design (one directory per call) so large trees are paged by user expansion,
  not enumerated wholesale.
- `ignored` is computed host-side from `.gitignore` + defaults (the host has fs and can read nested
  ignore files) so the plugin renders the flag without shipping a gitignore parser. **[EXTRAPOLATION]**
  — host-owned ignore evaluation; alternatively the plugin parses `.gitignore` itself by tailing it
  via `file:`, which is uglier and misses nested/negated rules.
- Caps: entries-per-dir capped (e.g. 5000, truncation-marked) to bound payloads.

Zod (mirrors `PluginReadAssetSchema` in `events.ts`): `{ conversationId, pluginId, dir }`.

### B. Agent-activity feed — **optional** (quality)

The tree can be built from the raw `tool_use` stream (§4b), so this is not strictly required. But a
host-provided, **pre-classified + backfillable** feed is cleaner and fixes the "closed pane misses
activity" gap:

```ts
// on 'activity': { path (cwd-rel), op: 'read' | 'write', ts }, plus a bounded history for backfill.
agent.activity(limit?: number): Promise<{ path: string; op: 'read' | 'write'; ts: number }[]>
```

- Host classifies SDK tool calls once (Read/Grep/Glob → read; Write/Edit/… → write) and keeps a
  bounded per-conversation ring, so every activity-consuming plugin agrees on classification and a
  remounted pane backfills. Gated by existing `agent:read`.
- If deferred, v1 uses §4b directly and accepts the freshness gap.

### C. Composer-insert verb — **required** ("mention in chat")

New host verb + permission `composer:insert`:

```ts
// Insert text into THIS conversation's composer at the cursor; does NOT send. Scoped like agent.send.
agent.composerInsert(text: string): Promise<void>
```

- Distinct from `agent.send` (which submits a turn). Routes to the mounted ChatPanel's composer for
  the pane's conversation (same conversation-scoping as `agent.info`/`onEvent`). **[EXTRAPOLATION]**
  — the renderer plumbing to reach the composer's editor state; the host verb is the clean boundary.
- Zod: `{ conversationId, pluginId, text }` with a length cap.

### D. Open-in-editor verb, cwd-scoped — **required** ("open in editor")

New host verb + permission `shell:openPath`:

```ts
// Open a cwd-relative file in the OS default handler / user's editor. cwd-scoped, refuses escape.
shell: { openPath(path: string): Promise<{ ok: true } | { error: string }> }
```

- Backed by the existing `app:open-path` main-process handler, but **re-exposed on the plugin host**
  with the `resolveWithinCwd` guard and a permission — the renderer's `app.openPath` must NOT be
  handed to sandboxes unbounded. Returns `{ error }` on denial. **[EXTRAPOLATION]** — cwd-scoping a
  verb whose current renderer form is unscoped.

All four are Zod-validated at the receiving side and permission-checked (PLUGIN_ARCHITECTURE.md DOs).

---

## 6. Performance (large repos, watching)

- **Lazy, one-level listing.** Never enumerate the whole tree. `fs.list(dir)` returns one directory;
  children load on expand. A 100k-file monorepo only lists the dirs the user opens.
- **Ignored dirs collapsed + not auto-listed.** `node_modules/`, `.git/`, and gitignored dirs are
  grayed and _not_ listed until explicitly expanded, so the common expensive dirs cost nothing by
  default.
- **Heat is O(records), decay at render.** No per-file timers; a single rAF/interval recomputes
  decayed opacity from the bounded record ring. The ring is capped (e.g. last ~1000 activity records,
  `storage`-persisted) so memory is bounded regardless of run length.
- **Watching.** v1 does **not** file-watch the whole tree (the host has no directory-watch verb, and
  watching a large repo is costly). The tree refreshes: (a) on manual "refresh", (b) for the
  _selected_ file via its `file:` tail, and (c) opportunistically — when an agent `write` activity
  names a path in a currently-expanded dir, re-`list` just that dir. This gives "the file the agent
  just wrote appears" without a global watcher. **[EXTRAPOLATION]** — the targeted-re-list strategy.
- **Preview caps.** Truncate large files (first N KB) in preview; images size-capped by `readAsset`.
- **Payload caps.** `fs.list` entries capped per dir (HOST-GAP A) so a pathological directory can't
  flood the bridge.

---

## 7. Implementation milestones (ordered)

1. **Static tree (needs HOST-GAP A).** Manifest + `index.html`; render a lazy, collapsible tree from
   `atelier.fs.list`, cwd-scoped. Persist expansion set in `storage`; rebuild on mount. gitignore
   graying from the `ignored` flag. _Acceptance: the cwd's structure is browsable and restores._
2. **Preview pane (no new host verb).** Click → `data.subscribe('file:'+rel)` → Shiki read-only
   render; images via `readAsset`; truncation for big files. Live-update on file change.
3. **Heat overlay (uses `agent:read`; better with HOST-GAP B).** Subscribe `agent.onEvent`, classify
   `tool_use` into read/write records, persist to `storage`, render decaying heat with read/write hue
   distinction + rollup on collapsed folders + legend/clear.
4. **Open in editor (needs HOST-GAP D).** Double-click → `atelier.shell.openPath(rel)`; stopgap
   clipboard-copy behind a flag if D lands late.
5. **Mention in chat (needs HOST-GAP C).** Right-click menu → `atelier.agent.composerInsert('`'+rel+'`')`;
   stopgap clipboard-copy if C lands late.
6. **Polish.** Targeted dir re-list on agent writes; hide-ignored toggle; heat half-life control;
   keyboard nav; token/heat legend.

Host work (A, C, D required; B optional) should be scheduled before or alongside milestones 1/4/5 —
the plugin cannot ship its headline features without them.

---

## 8. Risks

- **HOST-GAP dependency.** Three of the five features (tree, open-in-editor, mention) need new host
  verbs. Without them the plugin degrades to "preview + heat + clipboard stopgaps". Mitigation:
  land A first (the tree is the spine); C/D are small, patterned additions.
- **Re-exposing `openPath` too broadly.** Handing sandboxes an unscoped open-path is a real footgun
  (open anything on disk). Must be cwd-scoped with the `resolveWithinCwd` guard — do **not** forward
  the renderer's `app.openPath` verbatim.
- **Heat misclassification.** Tool-name→read/write mapping is extrapolated; SDK tool names can drift
  (CLAUDE.md warns the SDK surface is in flux). HOST-GAP B (host-owned classification) de-risks this
  by centralizing it. Verify names against the live SDK before building milestone 3.
- **Freshness/backfill.** `onEvent` misses activity while the pane is closed; without B, heat can
  under-count. Documented as an accepted v1 limitation.
- **Large-repo cost.** Mitigated by lazy listing + not watching globally (§6); a naive recursive
  list would be a regression — must stay one-level.
- **Preview for huge/binary files.** Truncation + binary placeholder required to avoid flooding the
  bridge or the Shiki renderer.
- **Path normalization.** SDK tool paths are absolute; heat keys must normalize to cwd-relative
  consistently with `fs.list` paths or heat won't align to tree rows.

---

## 9. Acceptance criteria

1. **Tree.** With the plugin enabled, the pane shows a collapsible tree of the conversation cwd;
   folders lazy-load on expand; the expansion set survives a reload/close-reopen (`storage`).
2. **gitignore.** Ignored entries are grayed and collapsed by default; a "hide ignored" toggle
   removes them; toggle state persists.
3. **Heat.** After the agent reads and writes files, the corresponding rows glow — **reads and
   writes visually distinct** — and the glow **decays over time** toward none. Collapsed folders roll
   up descendant heat. Reopening the pane recomputes correct current heat from `storage`.
4. **Preview.** Clicking a text file shows a Shiki-highlighted, **read-only** preview; large files
   truncate with a marker; images render; the preview updates if the file changes while selected.
5. **Open in editor.** Double-clicking a file opens it in the user's external editor (via the
   cwd-scoped host verb); a path outside the cwd is refused.
6. **Mention in chat.** Right-click → "mention in chat" inserts the file's cwd-relative path into the
   composer **without sending**; the user can edit around it.
7. **Containment.** A malformed manifest lists-but-doesn't-mount; a runtime throw in the pane is
   isolated and surfaced in the rail, never crashing the app or another plugin (PLUGIN_API §2).
8. **Scoping.** No host verb the plugin calls can read, list, open, or write outside the conversation
   cwd; all new verbs return `{ error }` on an escaping path, never throw.
9. **Performance.** Opening the pane on a large repo (with `node_modules`) is responsive: no global
   enumeration or global file-watch; only expanded directories are listed.
