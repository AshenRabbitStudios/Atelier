# PROGRESS.md — Atelier build log

## Status

- **Current phase:** P3 — Plugin host. **Backend slice landed** (registry/watcher/schema,
  per-conversation enablement, storage, `atelier-plugin://` sandbox protocol + runtime, IPC,
  hello-panel, 11 tests — see P3 section). Renderer rail/pane is next. P1 is functionally
  complete (rewind descoped); P2 partially started early (per-conversation layout persistence).
- **Verified headlessly (2026-06-28):** `npm run typecheck` clean (both bundles). Earlier:
  `npm run build` clean; `npm run dev` launches Electron (4 processes, no errors); a one-shot
  SDK probe confirmed subscription auth (apiKeySource `none`, no API key) and token-by-token
  streaming.
- **NOTE:** prior PROGRESS said "current phase: P0" — that was stale. P0 is done and most of
  P1 shipped without the status being updated. This entry corrects the record.

## P1 — Multiple instances + editable history (acceptance breakdown)

- [x] **N isolated instances.** `AgentManager` is fully N-instance (`create`/`open`/`close`/
      `list`/`delete`, per-`Session` `cwd`+SDK session+transcript). UI: a top **conversation bar**
      with tabs, a ☰ all-conversations dropdown, ＋ new-in-another-folder, ⤓ import-existing-session,
      rename, and 🗑 delete. Each instance sets `settingSources:['project']` + the claude_code preset,
      so it loads its own project `CLAUDE.md`. _Needs human spot-check:_ two folders side by side,
      confirm each picks up its own CLAUDE.md and they run concurrently/independently.
- [x] **Editable user message → fork → new continuation.** `saveEdit` (on-disk JSONL edit, no
      regen) and `fork` (resume at parentUuid + `forkSession`, regenerate) + `switchBranch`; inline
      ‹n/m› branch switcher. Transcript reconciled to canonical (real uuids) after each turn.
      _Needs human spot-check:_ the fork flow (automated probe was inconclusive on trivial prompts).
- [x] **"Also rewind files" — DESCOPED (will not build).** Reverting the working tree on a fork
      is a foot-gun that can silently undo intended work; file history is handled by git versioning
      instead. Forks are conversation-only and never touch files. (DECISIONS.md / ROADMAP.md updated.)
      **With this descope, P1 is functionally complete** — only the two human spot-checks above remain.

## P2 — Docking polish + persistence (early partial progress)

- [x] **Layout persistence.** Per-conversation Dockview layout is serialized (`api.toJSON`,
      debounced on change) into the manifest and restored on launch / conversation switch
      (`api.fromJSON`, falls back to a default Claude pane). (DECISIONS.md 2026-06-28.)
- [ ] Dock to each region / tabify / in-app floating groups — not yet wired (LayoutService only
      adds the single Claude pane today).
- [ ] Font-scale control on the chat panel — not yet.
      _(Full P2 begins after P1's rewind item closes.)_

## P3 — Plugin host + first panel plugin (in progress)

**Backend landed (commit, gate green: typecheck/lint/format/test/build):**

- `electron/shared/plugins.ts` — Zod `ManifestSchema` (+ permissions, tools, contextExports for
  day-one persistence), `DiscoveredPlugin`, `ConversationPluginState`.
- `electron/plugin/PluginRegistry.ts` — app-wide discovery of /plugins (depth ≤ 2 so `examples/`
  is found), Zod validation, broken manifest → invalid entry (never throws), `fs.watch` + debounced
  re-scan, `plugins:changed` push.
- Per-conversation **enablement** persisted in the conversation manifest (`plugins{enabled,
pinnedExports}`), threaded through `Session`/`AgentManager` like `layout`.
- `electron/plugin/pluginStorage.ts` — per-(conversation, plugin) KV (the restorable state).
- `electron/plugin/protocol.ts` + `runtime.ts` — `atelier-plugin://` scheme serving plugin assets
  (traversal-guarded) + the injected `window.atelier` host runtime (postMessage RPC).
- IPC: `plugins:list/enabled-for/set-enabled/reload`, `plugin:storage-get/set/keys`, `plugins:changed`.
- `plugins/examples/hello-panel/` — storage + layout.dock example.
- **11 new unit tests** (manifest schema, registry scanning incl. broken/mismatch/nested, storage
  isolation). Suite now 39 tests.

**Renderer landed (commit B; gate green):**

- `src/components/PluginRail.tsx` — perma-docked left rail (app chrome, not a Dockview pane):
  collapsed icon strip → expanded app-wide list; per-conversation enable toggle; broken plugins
  shown with their error; per-plugin reload.
- `src/components/PluginPane.tsx` — the sandboxed plugin host: an `<iframe sandbox="allow-scripts">`
  over `atelier-plugin://`, plus the `postMessage` relay that permission-checks and forwards
  storage→IPC and layout.dock/setTitle→LayoutService. Only messages from the pane's own frame are
  honored.
- `LayoutService` — `addPlugin`/`dockPlugin`/`removePlugin`/`setPluginTitle`/`hasPlugin` (Dockview
  panes, dock-region + floating).
- `App.tsx` — loads the catalog + subscribes `onChanged`; loads `enabledFor(activeId)`; reconciles
  mounted panes with the enabled set; toggle + reload handlers; renders the rail beside the dock.

**Needs human spot-check** (GUI, not headlessly verifiable) — P3 acceptance:

- `hello-panel` appears in the rail on discovery and toggling it mounts a dockable pane.
- The pane docks/floats via its buttons (`layout.dock`); typing a note persists across reload and
  conversation switch (`storage`).
- Editing the plugin file + reload updates the pane without an app restart.
- A deliberately broken plugin lists with an error and does **not** crash the app.

Deferred to P4 (per architecture): context pinning (`contextExports` + injection), the
`plugin_control` channel, the DataBus, and tool-contributing backends.

## P0 acceptance — self-check

- [x] `npm run dev` opens a window with one docked chat panel. _(launches; window contents
      need a human spot-check — see below)_
- [~] Typing a prompt streams a response token-by-token. _(streaming pipeline proven via
  probe: text deltas accumulate; needs human spot-check in the actual UI)_
- [~] Fenced code renders highlighted (Shiki), whitespace intact, not garbled. _(code path
  built with plain-`<pre>` fallback; needs human spot-check)_
- [~] Thinking block renders collapsed, expands on click. _(built as `<details>`; spot-check)_
- [~] Tool call shows expandable tool_use row with its result. _(built; spot-check — ask the
  agent to read a file)_
- [~] In-flight response can be interrupted. _(Stop button wired to `Query.interrupt()`; spot-check)_

## Added after P0 (from dogfooding feedback)

- **Tool-approval workflow**: gated tool calls surface an in-app card (Allow / Allow always /
  Deny). Verified headlessly: `canUseTool` fires for `Write` (with suggestions → Allow-always),
  Deny blocks the op; safe ops like `echo` run without a card.
- **Bypass toggle** in the chat header → `setPermissionMode('bypassPermissions'|'default')`.
- **Node-on-PATH fix** in main so the in-app agent's Bash finds node/npm (GUI-launch exit 127).

## Editable history + branches (P1 core)

- On-disk session store (`electron/agent/sessionStore.ts`): locate `~/.claude/projects/<slug>/<id>.jsonl`,
  parse → canonical transcript (verified on a real 377-message session: tool results all paired),
  edit a message's text by uuid, look up parentUuid.
- AgentManager: `rebind` primitive (restart query with resume/resumeSessionAt/forkSession), `saveEdit`
  (on-disk edit + rebind, no regen), `fork` (resume at parent + forkSession + regenerate), `switchBranch`,
  branch tree tracking.
- After each turn the renderer reconciles to the canonical transcript (real uuids; needed for edit/fork).
- UI: per-message ✎ edit → Save (both roles) / Fork (user only) / Cancel; inline ‹n/m› branch switcher.

## Dogfooding findings (from running Atelier on itself)

- **FIXED — Stop rendered as a hard error.** Pressing Stop produced a red error pane showing the
  raw SDK `result` JSON (`subtype:"error_during_execution"`, a `[ede_diagnostic]` note). Cause:
  `result` handler flagged any non-`success` as an error. Now aborts render as a clean stopped turn
  (interrupt flag + `terminal_reason:"aborted_streaming"`), and `[ede_diagnostic]` strings are filtered
  from surfaced errors. Typecheck clean. **Needs human spot-check:** press Stop mid-response and confirm
  no red error pane, instance stays usable.
- **FIXED — `AskUserQuestion` now renders as an answerable question card.** SDK-verified via a probe
  (see SDK_NOTES "AskUserQuestion"): the tool arrives at `canUseTool`; the host answers it by allowing
  with the user's choices injected as `updatedInput.answers` (question-text -> label). `onUserDialog`/
  `supportedDialogKinds` do NOT fire when `canUseTool` is supplied — ruled out by probe. Wiring:
  `requestPermission` special-cases `AskUserQuestion` → emits `question_request` (parsed questions)
  instead of `permission_request`; `Session.answer()` resolves the held promise with the allow+answers
  shape; new IPC `agent:answer`; renderer `QuestionCard` (option buttons, multi-select, freeform
  "Other", Skip). Aborting/Skipping allows with no answers → tool reports "user did not answer"
  (graceful). Typecheck + build clean. **Needs human spot-check:** in-app, make the agent ask a
  multiple-choice question and confirm a blue question card renders, selecting an option + Submit feeds
  the choice back (agent continues using it), and Skip doesn't error.

## Needs human spot-check

- **Editing/forking (NEW):** in the app, hover a message → ✎ → edit. **Save** (a Claude message and one of
  yours) and confirm the text persists and is used on the next turn with no regeneration. **Fork** one of
  YOUR messages with different text → confirm a new branch streams a fresh answer, the header shows ‹1/2›,
  and the ‹ › arrows switch between the original and the fork. (Automated fork probe was inconclusive due to
  the claude_code preset's behavior on trivial prompts — needs a real prompt.)
- Branch tree is in-memory per session (not persisted across app restarts) — acceptable for now.
- Launch `npm run dev` and visually confirm: chat panel renders; send a prompt and watch it
  stream; ask it to "read package.json" to see a tool_use row + result; confirm a fenced code
  block is highlighted with whitespace intact; expand/collapse a thinking block; press Stop
  mid-response. Confirm the header badge reads **subscription** (green), not an API source.
- Run on PowerShell: Node is installed at `C:\Program Files\nodejs` but not on this shell's
  PATH in-session; new terminals should pick it up. If `npm` isn't found, open a fresh shell.

## Open questions (carried from SPEC / PLUGIN_API)

- Transcript persistence: per-instance JSON vs. session resume as source of truth — decide in P1.
- xterm.js stream pane: built-in panel kind vs. first example plugin — leaning example plugin (P4).
- Plugin tool scoping: global vs per-instance — default global (P4).
- Sandbox tech: Electron `<webview>` vs sandboxed iframe — pick early in P3.

## Agent context-document plugins (docs/CONTEXT_SYSTEM.md) — built 2026-06-29

The "clear context often, carry your working state" system. Shared P4 infrastructure (per-turn
injection + auto-generated update tools + host `context` API + auto-pin) is in `electron/plugin/
contextTools.ts` and wired through AgentManager; 6 unit tests (suite 45). Five panes shipped under
`plugins/examples/` (built by parallel sub-agents to the host contract): **mental-model**,
**working-memory** (10 slots), **plan**, plus extras **diagram** (text DSL → SVG) and **data-table**
(CSV/TSV → sortable table). Each declares `contextExports` → the host injects it every turn, gives
the agent a `set_*` tool, and the pane reads/writes via `atelier.context.get/set`. Values persist
in per-conversation plugin storage (survive Clear chat, restart, open/close).

**Autonomous decisions + the GUI spot-check list are in docs/MORNING_REVIEW.md** — read that first.
Gate green; runtime behavior (agent updates a doc → pane reflects it → next turn the agent recalls
it) is the human spot-check.

## Visual-refresh migration (docs/DESIGN_SYSTEM.md) — M1–M6 done

Tokenized, themeable design system (Slate/Carbon/Daylight × comfortable/compact). All six
migration steps landed, each gate-green (typecheck/lint/format/39 tests/build) and CI-verified:

- **M1 Tokenize** — `[data-theme]`/`[data-density]` token blocks; every component color re-pointed.
- **M2 Panel** — universal `Panel` shell; every Dockview kind routed through it; native Dockview
  tabs suppressed (Panel header is the single chrome).
- **M3 Chrome** — frameless window + window-control IPC; 36px title bar with app mark, **LD-2**
  `UsageMeters` (account-wide, always visible), segmented theme switcher, Windows controls.
- **M4 Sidebar** — plugin rail reworked to the §5 sidebar over the real registry.
- **M5 Blocks** — composer (round Send / square Stop), tool-kind tints; **LD-1** holds (branch nav
  on the user message row, never the header).
- **M6 Reference** — plugin frames themed by pushing token values into the sandbox; `hello-panel`
  re-skinned to tokens-only as the canonical plugin body.

**Needs human spot-check** (GUI): launch `npm run dev` and verify in **all three themes** + both
densities against the normative spec (`docs/DESIGN_SYSTEM.md`; the interactive handoff prototype
has been removed now that M1–M6 landed) — chrome reads native, frameless window controls work, both usage meters show bar+%+reset, the
Panel shell looks right (watch for chat double-header / suppressed Dockview tabs), the plugin pane
reskins with the theme, and Carbon/Daylight have no missing tokens.

**Remaining §5 polish (follow-up, non-blocking):** diff line colors, card-strip restructure for
permission/question cards, block-summary chevrons, and folding ChatPanel's instance/chat header
into the Panel header (removes the transitional chat double-header).

## Engineering hardening run — DONE (2026-06-28)

The hardening run is complete; the three previously-unwired practices in docs/ENGINEERING.md are
now mechanically enforced. Full local gate is green: **typecheck → lint → format:check → test →
build**.

- **Test suite (Vitest).** 25 tests across 3 files seeding the highest-risk logic:
  - `electron/shared/events.test.ts` — IPC boundary Zod schemas (valid/invalid payloads, enums).
  - `electron/agent/sessionStore.test.ts` — transcript parsing (tool_result pairing, sidechain
    skip, block ordering), `editMessageText` (user-replace / assistant text-collapse), and
    `parentUuidOf`/`childUuidOf` threading. Runs against a temp `~/.claude/projects` fixture
    (mocks only `os.homedir`).
  - `electron/conversationStore.test.ts` — manifest save/list (sorted), delete, and app-state
    get/set isolation (mocks Electron `app.getPath` → temp dir).
  - Scripts: `npm test` (run once) / `npm run test:watch`. Config: `vitest.config.ts` (node env,
    v8 coverage). Test files excluded from the production tsconfigs so `npm run typecheck` stays
    fast/clean.
- **ESLint + Prettier.** Flat config (`eslint.config.js`): `@eslint/js` + typescript-eslint +
  react-hooks, with `no-console: error` and `react/no-danger: error` so the two intentional
  opt-outs (main's billing warning; Shiki's `dangerouslySetInnerHTML`) are explicit, and
  eslint-config-prettier last. Prettier (`.prettierrc.json`, repo style: no-semi, single-quote,
  width 100) applied across the repo; `npm run lint` / `format` / `format:check`. Removed the one
  genuinely-dead `eslint-disable` (App.tsx exhaustive-deps).
- **CI.** `.github/workflows/ci.yml` runs install → typecheck → lint → format:check → test →
  build on push to `main` and every PR (Node 22, npm cache, concurrency-cancel).

Remaining hardening backlog (lower priority, not blocking): broaden coverage to
`transcriptModel.ts` and AgentManager lifecycle (SDK faked at the boundary); audit that _every_
IPC boundary has a Zod schema; consider `--max-warnings 0` once `no-explicit-any` warnings are
burned down; add the dev-compatible strict CSP (below).

## Tech debt / deferrals noted during P0

- Shiki is bundled full (every grammar lazy-loads → many chunks + a >1MB warning). Consider a
  slim highlighter with a fixed language set in a later polish pass.
- No CSP meta yet (would break Vite HMR). Add a dev-compatible strict CSP in a hardening pass.
- React StrictMode is off to avoid Dockview double-panel mounts in dev; revisit.

## 2026-06-29 — instructions plugin (standing system-prompt instruction)

New `plugins/examples/instructions/` panel: one per-conversation textarea whose value is pinned
to the **top system prompt** via `systemPrompt.append` (not the per-turn `<atelier-context>`
block). Generic manifest field `systemInstruction: { key, maxTokens }`; host helper
`buildSystemInstruction()` (third provider hook into AgentManager). Cache-safe: unchanged value
replays verbatim and stays prompt-cached; `send()` rebinds (resume → history preserved) only when
the value changed. Builds clean; `buildSystemInstruction` unit-tested (contextTools.test.ts).

Needs human spot-check (not verifiable headlessly):

- Enable the `instructions` plugin, type an instruction, send a turn → agent honors it.
- Edit it and send again → it re-applies that turn.
- Leave it unchanged across turns → `usage.cache_read_input_tokens` stays non-zero (still cached).
- Apply timing: takes effect on the next `send()` after an edit (one long-lived query is rebound
  then). Confirm the rebind-on-change isn't disruptive if a turn is in flight.

## 2026-06-29 — per-section author guide (mental-model / working-memory / plan)

Each cognitive pane now has a collapsible "Usage instructions" footer: a user-authored note on
how to use that section, injected into the `<atelier-context>` block alongside the doc but stored
under `guide:<key>` (separate from `ctx:<key>`), so the agent's set_ tool can never edit it.
Host: `buildContextBlock` reads+frames the guide (unit-tested); panes write it via the generic
`storage` API (added `"storage"` permission to all three manifests). mental-model built as the
reference; plan + working-memory done by two parallel subagents (each confined to its own folder).
Builds clean; 51 tests pass; prettier/lint clean.

Needs human spot-check: open each pane, expand "Usage instructions", type a note → it persists and
appears in the agent's context next turn, and the agent's set_ updates never wipe it.

## 2026-06-29 — `hologram` plugin: Neural Hologram viewer port (increment 1 of N)

A new sandboxed panel plugin `plugins/hologram/` that reproduces the handed-off Neural Hologram 3D
viewer (dark "lab", wireframe glyph nodes, UnrealBloom glow, orbit, single-click inspect,
double-click fly-in drill, Back). Built as the fidelity-locking first slice; data is still the two
hardcoded demo architectures (transformer / RNN), NOT yet agent-fed.

Done:

- Vendored three@0.160.0 + OrbitControls/EffectComposer/RenderPass/UnrealBloomPass and Rajdhani +
  IBM Plex Mono (woff2) offline. Engine bundled to one classic-script IIFE (`hologram.bundle.js`)
  via `npm run build:hologram` (avoids unproven ES-module loading in the opaque-origin sandbox).
- Engine ported ~verbatim into framework-free ESM (`hologram.js`): scene/bloom/particles/grid,
  `renderScene`, all 13 glyph builders, sprite labels, flowing edge packets, raycast picking,
  `flyTo`/`drillInto`/`goBack` tween. Cleaner disposal than the prototype (materials + sprite
  textures freed). Data source is a `resolveModel`/`resolveDetail` seam (so the agent can feed it
  later without touching the renderer); selection/view go out via `onSelect`/`onViewChange` hooks.
- HUD ported as vanilla DOM (`index.html`): title/subtitle, Transformer/RNN switch, Back, inspector
  panel, hints, corner brackets/scanline/vignette, loader, and a glow/auto-rotate/palette tweaks bar.
- prettier clean; `plugins/` is eslint-ignored by design; bundle added to `.prettierignore`.

Needs human spot-check (not verifiable headlessly — WebGL/visual):

- Load `Hologram` from the plugin rail → renders the transformer tower, looks like the design
  (cyan wireframe, bloom, scanlines, fonts Rajdhani + IBM Plex Mono).
- Orbit/zoom; single-click a node → inspector fills; double-click → camera flies into internals;
  Back flies out; Transformer/RNN switch; tweaks (glow/auto-rotate/palette) respond.
- Confirm the classic-script bundle loads in the sandbox (if blank, check devtools for CSP/module
  errors) and that the two woff2 families load (else inline as base64 — non-fatal, cosmetic).

Left to finish the plugin (next increments):

1. Generalize the schema for arbitrary AI systems: optional pos/size/color; auto-layout (layered
   DAG / tower) for nodes without coordinates; a clean neutral default glyph + categorical color.
2. Recursive N-level drill + breadcrumb; cache pushed levels in `storage` keyed by path; a
   "not detailed yet" state when a level is missing.
3. Push wiring: add the optional `inject` flag to `ContextExportSchema` (+ test); declare the
   `architecture` export `inject:false`; pane reads `ctx:architecture` and renders; agent maintains
   `docs/architecture/*.json` and pushes snapshots.

## 2026-06-29 — Hologram step 2: archviz/2 schema, open registries, 3D auto-layout

Generalized the viewer from the NN-only prototype to the extensible model in HOLOGRAM_DATA_MODEL.md,
while keeping the transformer/RNN demos working. New modules in `plugins/hologram/`:

- `glyphs.js` — open GLYPH registry (13 ported builders as pure `(node,gx)=>Group` fns) + a `neutral`
  fallback slab + `KIND_DEFAULTS` (kind→glyph) + `CATEGORY_COLORS` (categorical palette).
- `layout.js` — open LAYOUT registry emitting real [x,y,z]: `flow`, `layered` (3D Sugiyama, cycle-robust
  ranking, fans a rank across two axes), `stack`, `grid`, `radial`, `manual`. Explicit `node.pos` wins.
- `scene.js` — `normalizeScene(raw)`: fills glyph/color from kind, default sizes, runs the layout,
  derives a 3/4 default camera + grid from bounds, and adapts the legacy archviz/1 demo (type→kind,
  desc→summary) so it still renders.
- `architectures.js` — added a coordinate-less `system` archviz/2 demo (agentic RAG) exercising
  auto-layout + neutral glyphs + categorical color + detail panels + typed edges.

Engine (`hologram.js`) refactored: glyph building delegates to the registry; `buildModel`/drill
normalize raw scenes; edges generalized (kind/style → color/packet, dangling-edge tolerance);
overview title/subtitle can come from the scene. Inspector (`index.html`) now renders descriptive
**detail panels** (markdown/table/keyValue/list/code/json/chart) decoupled from the glyph, with a
**System** button. Bundle rebuilt; esbuild + prettier clean.

Needs human spot-check (WebGL/visual): load Hologram → Transformer/RNN unchanged; **System** renders
an auto-laid-out 3D layered graph (depth used, neutral slabs in category colors, flowing edges);
clicking a system node shows its detail panels (tables/lists/markdown). Auto-layout/readability of the
layered view is the main thing to eyeball.

Left: rest of step 3 (edge picking + inspect, expand/maximize big details); step 4 multi-select +
`selection` export; step 5 recursion (drill+containment, path cache); step 6 `inject` flag + push.

## 2026-06-29 — Hologram step 6: live architecture push + middle-mouse pan

- Host: `ContextExportSchema` gained an optional `inject` flag (default true, backward-compatible).
  `buildContextBlock` skips exports with `inject:false`; `buildContextMcpServers` still registers
  their `set_<plugin>__<key>` write-tool. So an export can be **push-only** — the agent writes it and
  the pane reads it, but its (large) value is never fed back into the agent's context. Test added
  (`contextTools.test.ts`); full suite 52/52, typecheck clean.
- Plugin: manifest declares an `architecture` export (`inject:false`, json, 16k). The pane polls
  `context.get('architecture')` every 1s and calls the new `engine.loadScene(raw)` on change — so an
  agent push re-renders **live, no reload**. Built-in demos still work (buttons override).
- Pan: OrbitControls now `enablePan + screenSpacePanning`, **middle-drag = pan** (left=orbit,
  right=pan, scroll=zoom). Left-button-only selection so middle/right drags don't deselect.

Activation (one-time): restart the dev app (host change is main-process), reload the Hologram plugin
(new bundle + manifest), and PIN "Hologram architecture" (gives the agent the push tool; inject:false
keeps it out of context). Then the agent pushes a scene via `set_hologram__architecture` and it
appears live. needs human spot-check: live push re-renders without reload; middle-drag pans.

## 2026-06-29 — Hologram: recursion, edge inspection, maximize, off-centre pivot, structural glyphs

The plugin is now feature-complete (build OK, typecheck OK, 52/52 tests, prettier clean).

- **Recursion (step 5):** double-click an `expandable` node loads its child scene by `path`. Scenes
  are cached by path (instant Back, breadcrumb in the subtitle). A drill into an un-authored path
  shows "not detailed yet" and writes an `{action:'expand', path}` request to the `selection` export,
  so the agent authors that level and pushes it (then the pane flies in). Built-in demos keep their
  one-level legacy drill. `loadScene` keeps the camera on a same-id re-push, reframes on a new root.
- **Edge inspection:** edge lines are now raycast-pickable (nodes take priority). Clicking an edge
  shows the tensor flowing on it (shape / dtype / modality / role).
- **Inspector maximize:** ⤢ button pops the panel large for long tables / descriptions.
- **Off-centre pivot (user request):** OrbitControls' rotate is disabled and replaced with a custom
  left-drag that tumbles around the **last-selected node's centre** without re-aiming — a panned,
  off-centre architecture stays exactly where you put it. OrbitControls keeps pan (middle-drag) +
  zoom; its target is parked on the camera's look-axis each frame so the two never fight.
- **Structural glyphs:** added `volume` (conv/feature-map), `router`/`moe` (dispatch fan),
  `cache`/`memory` (stacked slabs), `db`/`index` (drum) so non-NN scenes read structurally, not all
  as neutral slabs.
- **Host:** the push-tool description is now conditional on `inject` (push-only vs sync).

needs human spot-check (WebGL): off-centre tumble feel; multi-level drill + breadcrumb + "ask me";
edge click shows tensor; maximize; the live `transformer-encoder` push (mha1/mha2/ffn1/ffn2 expandable).
