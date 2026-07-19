# DECISIONS.md — non-obvious choices (one line each)

- 2026-07-11 **`cartographer` plugin — one injected JSON map, not a separate mechanical digest.** The spec (docs/CARTOGRAPHER_SPEC.md §1/§5) assumed a file-edit architecture: the agent edits `map.json` via ordinary file ops and the host injects a _rendered compact digest_ each turn. Atelier has no such split — a context export is a `ctx:<key>` string, the injected value _is_ the agent's working copy, and injection reads that stored value verbatim (there's no on-change hook to recompute a derived digest with the pane closed). So Cartographer ships as a **single `map` context export** (`format:"json"`, `inject:true`, `maxTokens:7000`): the agent both reads it and maintains it, preferring `edit_cartographer__map` (targeted append/patch — the whole reason the edit_ tool landed first) and falling back to `set_` for restructures; `maxTokens` bounds it and the directives tell the agent to retire/prune. A backend-computed digest is a documented follow-up if token cost bites. **Directives** ride the `systemInstruction` primitive (`ctx:instructions`, seeded via `defaults.json`, agent-read-only, user-editable in the pane via `context.set('instructions', …)` — undeclared-key writes work, as the `instructions` plugin already relies on). **Config** (spec §6) is folded into the map JSON as a `config` block — there's no plugin-config primitive, and this keeps it inspectable/editable. **Panel** is dependency-free vanilla SVG (plugins get no CDN/network): a **ring-pack** layout (parent radius = enclosing ring of children, `R_ring = maxChildR / sin(π/k)`) stands in for d3.pack — encodings are faithful (radius=intensity, fill saturation=confidence, hue=root family, border style=channel, retired=hollow ring) but the packing is looser than true enclosure; swapping in real circle-packing is a follow-up. v1 panel is a **viewer + JSON write-back editor** (saves only valid JSON, never clobbers the last good view); the spec's inline add/remove/relink affordances (§4) are deferred to that same editor for now.

- 2026-07-11 **Context documents get a second write tool: `edit_<plugin>__<key>` (targeted find-and-replace) alongside `set_` (full replace).** Full-rewrite-only forces the agent to regenerate the _whole_ value to change any part of it — every untouched byte passes back through sampling, so paraphrase/detail drift is silent (the tool result shows no diff) and **compounds** (the mutated doc is next turn's injected ground truth; there is no stable substrate). It's also a mechanical data-loss path via `capValue`: a value over its token cap is injected truncated, and a rewrite composed from that truncated view permanently drops the tail. `edit_` mirrors the built-in Edit tool's semantics — `old_string` must exist and be unique (or `replace_all: true`); on not-found/not-unique it returns `isError` with guidance to fix the anchor or fall back to `set_`, writing nothing. Chosen over pointing the agent's built-in Edit tool at a real file because a context export is **not a file** — it's a `ctx:<key>` string inside the conversation's per-plugin `storage.json` (userData root), which the built-in tool can't target without leaking storage paths, editing outside cwd, and losing the validated main-process boundary. Implementation is contained to `buildContextMcpServers` (contextTools.ts): both tools generated per pinned export (incl. push-only `inject:false`), sync read-modify-write in main (single-threaded → no interleave with a pane's `context.set`), `split/join` not `String.replace` (never interprets `$` patterns in `new_string`), same `onChange` → pane refreshes with no renderer change. `set_` retained for first write + deliberate re-synthesis. +7 tests (22 total in contextTools).

- 2026-07-02 **`browser` example plugin — local/authored scope, in-document render (webview deferred).** A panel that renders agent-pushed HTML/Markdown (the `content` export, `inject:false`) or a local file (via the P4 `file:` DataBus source), which the user views/navigates; the live page state + on-demand snapshots go back as the `page`/`snapshot` exports (`inject:true`). Key constraint that shaped it: the plugin iframe is sandboxed `allow-scripts` only (opaque origin), so a nested content frame can't be made same-origin-readable — to read the user's **live, post-interaction** DOM we render content **in the plugin's own document** (a container div; pushed `<script>`s re-created so they run) and read that. Trade-off: pushed scripts share the plugin's global scope (acceptable for single-user/local, gated by a "Run scripts" toggle). Real external-site browsing (google.com, X-Frame/CSP-protected sites, cross-origin DOM reads) is out of scope here — it needs an Electron `<webview>`/`WebContentsView` + main-process `executeJavaScript`/`capturePage`, which expands the trust model; deferred as the documented follow-up. Snapshot is a text/DOM capture, not a raster image (an image can't be consumed through the text context channel). No host/electron changes — pure new plugin folder on proven P4 mechanisms.

- 2026-07-02 **Launcher rebuilds on source change.** The Desktop/Start-Menu shortcut ran `electron.exe` against a frozen `out/` build, so pinned launches never reflected code edits. `scripts/launch.ps1` now mtime-gates a rebuild (newest file under `electron/`,`src/`, or the build config vs `out/main/main.js`; `plugins/` excluded — they load live) then starts the app; `install-shortcut.ps1` targets the launcher (minimized). Unchanged relaunches skip the build.

- 2026-06-30 **P4 slice 3 — tool-contributing plugins (child-process backends).** A `kind:"both"` plugin declares `tools[]` + the `tools` permission + a `backend` module; each tool becomes an in-process SDK MCP tool (same `tool()`/`createSdkMcpServer` path as the context tools, merged into `mcpServers` as `atelier_plugins`) whose handler does NO work — it forwards the call to the plugin's **backend child process** and returns its result. Per CLAUDE.md backends never run in-process: one Electron **`utilityProcess`** per plugin, spawned lazily on first call, killed on disable/reload (so a reloaded plugin always runs fresh code) and on quit. `PluginBackendManager` (request/response correlation by id, 30s timeout, exit→reject pending) is **transport-injected** so it's unit-tested without Electron (7 tests); the real `utilityProcess` transport lives in main. Backend protocol: parent posts `{id,tool,input}`, child replies `{id,result|error}` via `process.parentPort`. Manifest `inputSchema` is a serializable `{field:"string"|"number"|"boolean"}` descriptor → `jsonSchemaToZodShape` (manifests can't carry real Zod). **Fix:** `setPluginEnabled` only rebound when a plugin had context exports — extended to also rebind when it `hasTools`, else a tool-only plugin's tools never appeared. Example: `plugins/examples/tool-plugin` (reverse_text / sum_numbers). The backend is trusted plugin code with full Node privilege (process-isolated, not sandboxed) — that is inherent to tool plugins. The harness path resolves from the plugin dir (real fs path), so packaging will need to ship plugin backends as files (noted; app runs via `npm run dev` today). 13 new tests.

- 2026-06-30 **Renderer crash recovery.** Two event-driven recoveries (no periodic reload): a root React **ErrorBoundary** (a thrown component shows a recoverable panel + Try again/Reload, not a blank window) and a main-process `render-process-gone` auto-reload capped at 3 reloads/10s (a load that crashes on sight can't loop). Module-eval errors before React mounts are out of scope.

- 2026-06-30 **P4 slice 2 — ambient Bash tap (read-only Pre/PostToolUse hooks).** SDK-verified (sdk.d.ts v0.3.195, SDK_NOTES.md): hook events are PascalCase; **there is no streaming-stdout hook** — PreToolUse fires before the command (gives the command line), PostToolUse fires after it completes (gives `tool_response` = the full output), and a hook cannot supply a tool result. So the tap is **command-granular, not sub-second live**: announce on PreToolUse, publish the full ANSI-intact output on PostToolUse (PostToolUseFailure → error frame). Hooks return `{ continue: true }` — read-only, never block; permission still flows through `canUseTool`. **Channel deviation:** the ROADMAP said `bash:<toolUseId>:stdout`, but a pane can't pre-subscribe to a per-command id, so the tap publishes to one **conversation-scoped `bash:stdout`** channel with each frame tagged by `toolUseId` (a future per-command view can demultiplex). Wired via a new `BashPublish` provider threaded through AgentManager → Session.buildOptions (forward-ref to the DataBus in main, since the bus needs `agents.cwdFor`). The `bash-stream` example is an **xterm.js** pane (invariant #1: ANSI only ever rendered in xterm), with xterm/addon-fit vendored into the plugin folder (devDep source, like hologram's three) and a visible "Reality · ambient bash" banner. `bashResponseText` extractor unit-tested (6 tests).

- 2026-06-30 **P4 slice 1 — DataBus + file source (`electron/plugin/DataBus.ts`).** Generalized the merged context-push plumbing into a per-conversation pub/sub bus instead of a second bespoke push path: a plugin `atelier.data.subscribe(channel, cb)/unsubscribe/publish` (perm `data:subscribe`/`data:publish`) rides the **same** `postMessage→IPC→webContents.send` route as `context:changed`, and `DataMessageEvent` is routed to the owning pane by `pluginId`+`conversationId` exactly like `ContextChangedEvent`. Sources are **lazy** (open on a channel's first subscriber, close on its last) and **cached** (a late joiner gets the current value immediately). The one built-in source tails files: channel `file:<rel>`, resolved by `resolveWithinCwd` to a path **scoped within the owning conversation's cwd** — a plugin can never read outside the project folder (invariant #3 held: bounded host capability, never direct fs). Read failures emit `{error}` rather than throwing. Pane cleanup unsubscribes its channels (tracked with the conversation they were scoped to, so a conversation switch still releases watchers); `dropConversation` on close is the safety net. Example: `plugins/examples/living-doc` (live-tails a project file). 8 DataBus unit tests; full gate green.

- 2026-06-29 **Reversed the M2 "suppress Dockview's native tab bar" decision** — it removed the drag handle, so panels couldn't be moved/docked/tabbed (user-reported). Now Dockview's **native tab bar IS the panel header**, themed to the design via `--dv-*` vars + a selectable pill `.dv-tab`; the custom `Panel.tsx` is **removed** and each Dockview kind renders its body directly (the kind only supplies the body, per DESIGN_SYSTEM §4). Drag-to-move, drag-to-dock-region, and **drag-onto-another-header-to-tab** (both titles shown side by side) all work natively. The rounded "card" look + `--bg-2` gutter come from group padding (`.dv-groupview` is a flex column; 4px padding insets the tab bar + content → ~8px inter-panel gap) with split top/bottom `border-radius` across the tab-container (top) and content-container (bottom) so they read as one bordered card.

- 2026-06-29 Visual-refresh migration M2–M6 done (docs/DESIGN_SYSTEM.md). M2: universal `Panel` shell, every Dockview kind routed through it, Dockview's native tab bar suppressed so the Panel header is the single chrome (tradeoff: same-group tab-switching not exposed). M3: frameless window (`frame:false`) + `window:minimize/maximize/close` IPC + a 36px title bar carrying the app mark, the LD-2 `UsageMeters` (account-wide, always visible), the segmented theme switcher, and the Windows controls. M4: plugin sidebar reworked to the §5 pattern over the real registry. M5: composer → §5 pattern (round Send / square Stop), tool-kind tints; **LD-1 confirmed already-correct** (branch nav on the user message row, not the header). M6: **plugin frames are themed by pushing the active theme's token values into the sandboxed (cross-origin) iframe** — `PluginPane` reads `getComputedStyle` on the app root and posts a `theme` event; the host runtime sets the vars on the plugin's `documentElement`; re-pushed on theme/density change via an `atelier-theme` window event. `hello-panel` re-skinned to tokens-only as the canonical plugin body. All steps gate-green; visual fidelity across the three themes is a human spot-check.

- 2026-06-29 Visual-refresh migration (handoff → docs/DESIGN_SYSTEM.md): tokenized, themeable design system — Slate/Carbon/Daylight themes × comfortable/compact density, selected by `[data-theme]`/`[data-density]` on the app root. **M1 (tokenize) done**: `src/styles.css` `:root` replaced by the three theme token blocks + density + base; every raw hex/rgba in component rules re-pointed to tokens (only `#e81123`, white switch-thumbs, and the `rgba(0,0,0,.5)` modal scrim remain — all per the design's own `components.css`). Legacy var names (`--bg-elev`/`--bg-input`/`--text-dim`/`--accent-dim`/`--panel`) kept as `:root` **aliases** → semantic tokens as an M1 bridge so the 1148-line sheet themes via the cascade without rewriting every rule; inlined away over M2/M5. theme/density persisted in `localStorage` with a temporary cycle switcher in the conversation bar (the proper title-bar `.seg` switcher lands in M3). Handoff bundle is **gitignored** (reference only; durable spec copied to docs/DESIGN_SYSTEM.md).

- 2026-06-28 P3 plugin sandbox = sandboxed `<iframe>` over a custom **`atelier-plugin://` standard scheme** (registered privileged before app `ready`; serves plugin folder assets read-only with path-traversal guard, and the host runtime at `atelier-plugin://__runtime__/atelier.js`). Host runtime is a **bundled string** (electron/plugin/runtime.ts) — no runtime path resolution. Plugin ↔ renderer over `postMessage`; renderer ↔ main over IPC. Chosen over `<webview>` (Electron-discouraged, heavier, needs its own preload); host API stays identical if we switch later. Registry is **app-wide** (watch /plugins, depth ≤ 2 so examples/ is found, Zod-validated, a broken manifest becomes an invalid entry rather than throwing); **enablement is per-conversation** in the conversation manifest (`plugins{enabled,pinnedExports}`); **storage is per (conversation, plugin)** at conversations/<id>/plugins/<pluginId>/storage.json. `PLUGINS_DIR` = `process.cwd()/plugins` in dev, overridable via `ATELIER_PLUGINS_DIR`. Backend + IPC + hello-panel landed with 11 unit tests; renderer rail/pane is the next slice.

- 2026-06-28 Plugin architecture resolved (docs/PLUGIN_ARCHITECTURE.md): registry is **app-wide** (watcher over `/plugins`), but **enablement is per-conversation** (`plugins{enabled,pinnedExports}` on the conversation manifest). Added two primitives beyond PLUGIN_API.md: **context pinning** (plugins declare `contextExports`, push fresh snapshots via `context.update`; host injects pinned exports as an ephemeral host-framed block each turn — never into editable transcript — bounded by per-export `maxTokens`) and **universal agent control** (`plugin_control(pluginId,command,payload)` built-in tool over a reserved `control:<pluginId>` channel; boundary fixed, payload free). Build order: P3 plugin host + perma-docked left rail (app chrome, not a Dockview pane) must precede P4 channels/control/pinning; manifest fields defined now for day-one persistence.

- 2026-06-28 Per-conversation Dockview layout (task #14): each conversation persists `layout` (api.toJSON) in its manifest; switching restores via api.fromJSON (falls back to a default Claude pane if absent/incompatible). Saved debounced on `onDidLayoutChange` with the snapshot captured at change-time (survives a fast conversation switch); programmatic restores are guarded by a `restoring` flag; `applied` ref dedupes the mount-time double-apply. Layout's claude-panel `params.instanceId` == conversation id (stable), so restore re-binds the right transcript. Pairs with plugin panes when P3 lands.
- 2026-06-28 Composer input state isolated into its own component so typing never re-renders the transcript (fixed multi-second keystroke lag on huge chats); Shiki highlighting capped at 20k chars (huge dumps render as plain text instead of locking the UI). Usage meters moved to an account-level strip under the conversation bar (10s poll; manager caches last non-empty snapshot to disk since idle sessions report null windows). Effort selector added right of the model dropdown, gated on the model's `supportedEffortLevels`.

- 2026-06-28 Conversation delete = SDK `deleteSession()` for every branch's transcript + remove the Atelier manifest/plugin dir (`deleteConversationData`); exposed as a 🗑 per row in the far-left "☰ Conversations" dropdown (lists name + bound folder). Usage meters moved from the header to next to Send (compact 2-window UsageMini: % + time-to-reset inline), polled every 10s.

- 2026-06-28 Conversation lifecycle: **open** = live Session in RAM + a tab; **closed** = serialized to disk, reachable via the top-bar ▾ dropdown. `state.json` tracks `openIds` + `activeId`; `restore()` on launch recreates only the open set (so the bar isn't cluttered with every conversation ever). Explicit close → serialize + tear down the live session + drop from openIds (manifest kept). App quit (`closeAll`) serializes + tears down but PRESERVES openIds so relaunch restores the same set. Per-conversation actions: **Clear chat** (abandon branches → fresh SDK session, old JSONL orphaned) and **Clear plugins** (delete the conversation's plugin storage dir) — reuse a folder without clutter.

- 2026-06-28 Persistence is **per-conversation**, not a global workspace store (SPEC §4.5). A conversation is a self-contained restorable document: branch tree + cwd + title + model + exact dock layout + loaded plugins + per-plugin data. Message content is referenced from the SDK's per-session JSONL (Option A — no copy); the manifest references sessionIds. Plugin state survives only via the host `storage` API scoped per (conversation, plugin); the host restores storage + re-docks panes (PLUGIN_API §8). UI: a top conversation bar selects/creates conversations; the workspace below renders the active conversation (one at a time, no nested layouts); the Claude pane drops its in-widget conversation selector. Restore-on-launch makes the renderer reflect disk, never the source of truth — fixes the reload/restart data-loss (empty window).

- 2026-06-28 `AskUserQuestion` (agent→user multiple-choice) is answered through `canUseTool`, not `onUserDialog`: allow the tool with `updatedInput.answers` (question-text → chosen label; multi-select comma-joined; optional freeform `response`). Probe-verified the SDK ignores `onUserDialog`/`supportedDialogKinds` once `canUseTool` is provided. Atelier routes it to a dedicated `question_request` event + `QuestionCard` (not the Allow/Deny card); Skip/abort = allow with empty answers ("user did not answer"). (docs/SDK_NOTES.md)

- 2026-06-28 A user-pressed Stop arrives as a `result` with `subtype:"error_during_execution"` + `terminal_reason:"aborted_streaming"` whose only `errors` are internal `[ede_diagnostic]` notes; we now treat aborts (tracked via an `interrupted` flag set in `interrupt()`, cleared in `send()`/next result) as a clean "stopped" turn and filter `[ede_diagnostic]` strings out of surfaced errors, so Stop no longer renders a red error pane. (Found via dogfooding: stopping mid-`AskUserQuestion`.)

- 2026-06-27 Build on V1 `query()` API (not V2 preview): we require session forking, which is V1-only. (CLAUDE.md)
- 2026-06-27 Auth: inherit Claude Code session; main process must never set `ANTHROPIC_API_KEY` and must warn if one is present, to avoid pay-as-you-go API billing. (user requirement)
- 2026-06-27 Loading project CLAUDE.md needs BOTH `settingSources: ['project']` AND `systemPrompt: { type:'preset', preset:'claude_code' }` — refinement of CLAUDE.md, per current SDK docs.
- 2026-06-27 Token streaming via `includePartialMessages: true` + `partial_assistant` deltas, not by diffing full assistant messages.
- 2026-06-28 "Also rewind files" / file checkpointing **descoped — will not build** (supersedes the 2026-06-27 plan to implement it via `Query.rewindFiles()`). Reverting the working tree on a fork can silently undo changes the user intended to keep; the user manages file history with git versioning instead. Forks are conversation-only and never modify files. (user decision)
- 2026-06-27 Build tooling: `electron-vite` (purpose-built Vite wrapper for Electron) over hand-rolled multi-config Vite — handles main/preload/renderer bundling + HMR. Custom config keeps CLAUDE.md's `/electron` + `/src` layout.
- 2026-06-27 Pinned versions to resolve a peer conflict: `vite@7.3.6` + `@vitejs/plugin-react@5.0.4` (plugin-react@6 requires vite@8, which electron-vite@5 doesn't allow yet).
- 2026-06-27 Dockview React bindings come from the separate `dockview-react` package in v7 (`dockview` itself is now just the vanilla core re-export).
- 2026-06-27 Billing guard: main process deletes `ANTHROPIC_API_KEY` from env at startup (after warning) so the SDK child can't bill the API; treat apiKeySource `oauth`/`none` as safe-subscription, warn on any actual key source.
- 2026-06-27 Multi-turn via one long-lived `query()` per instance fed by a streaming `AsyncIterable` input queue (keeps the session + `interrupt()` live across turns), not a fresh query per turn.
- 2026-06-27 Tool approvals: SDK `canUseTool` callback → `permission_request` event → in-app approval card (Allow / Allow-always / Deny); decision returns a `PermissionResult`. Safe ops the SDK doesn't gate run without a card (verified: `echo` ran silently, `Write` prompted).
- 2026-06-28 Editing history works by editing the SDK's on-disk session JSONL (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`); `resume` re-reads it (probe-verified: edited an assistant message RED→BLUE on disk, resume → Claude saw BLUE). Save = edit-in-place, no regeneration; effective on next query. Fork = user messages only, branches via `forkSession`. Messages on disk carry `uuid`+`parentUuid` (a native tree).
- 2026-06-28 Fable 5 marked `disabled` in the model dropdown (unavailable on this plan) via a `disabled` flag on ModelOption.
- 2026-06-28 Smart autoscroll: transcript only sticks to the bottom when the user is within 40px of the tail (tracked via a scroll ref, no re-render); sending forces a jump to the tail.
- 2026-06-28 Editable history: each conversation branch = one SDK session. Save edits the on-disk JSONL in place (no regen) then rebinds; Fork (user msgs only) resumes at the edited message's **parentUuid** + `forkSession` so the edit replaces the message and regenerates on a new branch. Branch tree tracked in-memory; canonical transcript reloaded from disk after each turn so messages carry real uuids.
- 2026-06-28 Errors are surfaced as expandable UI blocks (message + full detail). Sources: thrown iterator errors (the authoritative reason, e.g. "model unavailable"), `result` errors with concrete `errors[]`, `assistant.error` codes, `rate_limit_event` rejections, `auth_status` errors.
- 2026-06-28 A terminal turn error kills the `query()` generator (the iterator throws), which would silently brick the instance. Session now auto-restarts (resume same session, fresh input queue) on a thrown pump error, bounded to 3 consecutive restarts; a clean result resets the counter. (Found via Fable-5-unavailable dogfooding.)
- 2026-06-28 Model dropdown pre-populated from a curated `KNOWN_MODELS` list (full specific IDs), merged with extra `claude-*` IDs from `supportedModels()`; bare family aliases skipped.
- 2026-06-28 Model dropdown sourced from `Query.supportedModels()` (default/sonnet/opus/haiku/claude-opus-4-8), switched via `setModel()` at runtime.
- 2026-06-27 `canUseTool` allow MUST return `updatedInput` (a record) — this SDK build's runtime Zod schema requires it even though the `.d.ts` marks it optional. We echo the original input back unchanged on allow. (Found via in-app dogfooding: a bare `{behavior:'allow'}` threw a ZodError.)
- 2026-06-27 Bypass toggle = runtime `Query.setPermissionMode('bypassPermissions'|'default')`; `allowDangerouslySkipPermissions: true` set at init so the mode switch is permitted. This is Atelier's `--dangerously-skip-permissions` equivalent.
- 2026-06-27 Main prepends a known Node dir (`C:\Program Files\nodejs`) to PATH at startup if present and missing, so the spawned agent's Bash can find node/npm when Atelier is launched from a GUI shortcut (avoids exit 127).
- 2026-06-27 App-window preload uses `sandbox: false` (ESM/Node preload) while keeping `contextIsolation: true` + `nodeIntegration: false`; plugin webviews will still be fully sandboxed (P3).
- 2026-06-29 `instructions` plugin: a per-conversation standing instruction pinned to the **top system prompt** (via `systemPrompt.append` on the `claude_code` preset), not the per-turn `<atelier-context>` user block. Generic, manifest-driven (`systemInstruction: { key, maxTokens }`) like context exports — no hardcoded plugin id; `buildSystemInstruction()` mirrors `buildContextBlock()`. Read in `buildOptions()` and replayed verbatim, so an unchanged instruction stays prompt-cached; `send()` rebinds (resume → history kept) only when the value changed, so the one-time cache invalidation lands exactly on the edit. Chosen over a raw mid-array `role:"system"` message because the v1 SDK input is user-messages-only (no system role in `messages[]`) — confirmed in `sdk.d.ts` v0.3.195.
- 2026-06-29 Per-section author guide for context-document plugins: a user-authored "how to use this section" note injected into the `<atelier-context>` block alongside the doc value, but stored under a separate `guide:<key>` storage key (not `ctx:<key>`). The agent's `set_<plugin>__<key>` tool only writes `ctx:<key>`, so the guide is structurally read-only to the agent (enforced by storage layout, not prompt wording). Panes write it via the existing generic `storage` API (requires the `storage` permission) — no new IPC/host API. `buildContextBlock` reads `guide:<key>` and frames it "fixed author instructions — follow, do not edit/echo." Generic: any context export gets this for free; applied to mental-model/working-memory/plan.
- 2026-06-29 `hologram` plugin (3D "Architecture Hologram" viewer): ported the handed-off Neural Hologram Three.js engine into a sandboxed panel plugin. JS ships as ONE esbuild IIFE bundle (`hologram.bundle.js`, three@0.160.0 + OrbitControls/EffectComposer/RenderPass/UnrealBloomPass baked in) loaded via a classic `<script>` — the proven path for the opaque-origin `sandbox="allow-scripts"` iframe. ES-module + `fetch()` loading over `atelier-plugin://` is unverified (data-table precedent only uses classic `<script>`/`<link>`), so it is deliberately avoided. `three` + `@fontsource/{rajdhani,ibm-plex-mono}` added as devDeps purely as vendoring sources; the four woff2 weights are copied into the plugin for offline use. Source stays ESM (`hologram.js`/`architectures.js`/`entry.js`); `npm run build:hologram` regenerates the bundle.
- 2026-06-29 Hologram data flow = push-to-pane only, no readback (per user). The agent keeps architecture as editable files under `docs/architecture/` (outside `/plugins`, which is watched recursively) and pushes a snapshot to the pane. Planned host change (NOT yet built, deferred to the push-wiring step): an optional `inject` flag on `ContextExportSchema` (default true = today's behavior; `false` = `buildContextMcpServers` still registers the `set_` write-tool but `buildContextBlock` skips injecting the value back). Keeps inject-back a capability, not a necessity.

- Context exports gained an optional `inject` flag (default true). `inject:false` = push-only: the
  host registers the agent's `set_` write-tool but never injects the value back into context. Lets
  the Hologram `architecture` scene be pushed to the pane at zero per-turn token cost, while a tiny
  `selection` export stays `inject:true` for the reverse "what am I looking at" channel. Injection is
  thus per-export, not all-or-nothing. (electron/shared/plugins.ts, electron/plugin/contextTools.ts)

- Hologram camera: replaced OrbitControls' rotate with a custom left-drag that orbits the
  last-selected node off-centre (OrbitControls always pivots at screen-centre, which re-aims/recenters
  the view — not what we want when the architecture is intentionally panned aside). OrbitControls is
  kept for pan + zoom + damping; its `target` is parked on the camera look-axis each frame so it does
  not fight the manual rotation. `enableRotate=false`. (plugins/hologram/hologram.js rotateAroundPivot)
- Hologram recursion: pushed scenes are cached by `path`; drilling navigates locally (cached) or asks
  the agent to push the child level via an `{action:'expand', path}` request on the `selection` export.
  The single `architecture` export always holds the scene to display; the pane caches each level it
  receives for instant Back. (docs/HOLOGRAM_DATA_MODEL.md §5)

- 2026-06-30 **Multi-agent workflow = git worktrees, one branch each** (docs/MULTI_AGENT.md). The repo
  is edited by several concurrent Claude sessions; sharing one working tree + `main` causes commit
  races (a concurrent session moving `HEAD` produced a near-empty `git diff HEAD` mid-task). Fix is
  _filesystem_ isolation: `scripts/worktree.mjs add <topic>` creates a sibling worktree + `feat/<topic>`
  branch and symlinks `node_modules` (junction on Windows) so it runs without reinstall; merge back
  through `main` + `ci:status`. Sub-agents use the harness `Agent(isolation:"worktree")`. The generated
  `plugins/hologram/hologram.bundle.js` is kept **tracked** (so the app runs from a clean checkout —
  `build:hologram` is standalone, not wired into `dev`/`build`) but marked `-diff linguist-generated`
  in `.gitattributes` and is **never hand-merged**: on conflict, rebuild and take the regenerated file.

- **2026-07-04 — Always-on environment self-awareness (host-level, not a plugin).** A fresh
  conversation's agent was blind to Atelier: context injection + the `systemInstruction` append only
  fire for _enabled_ plugins, so "what plugins can you access?" got nothing. Fix (docs/ENVIRONMENT_AWARENESS.md,
  `electron/plugin/introspection.ts`): (a) a stable `<atelier-environment>` briefing prepended to the
  system-prompt append on every conversation — Atelier + cwd + a catalog of all discovered plugins;
  (b) an always-registered built-in `atelier` MCP server (`list_plugins`/`describe_plugin`) so the
  agent can introspect live per-conversation state + each plugin's tools/exports. Briefing holds only
  install-level facts (per-conversation state lives in the tools) so it stays prompt-cached. Added an
  optional `description` to `ManifestSchema` for the catalog/detail text. Composed in `main.ts`, not a
  plugin — a plugin can't describe the app or a plugin the user hasn't enabled.

- **2026-07-04 — Plugin pane reconcile is transition-based, not "enabled ⇒ mounted".** The effect
  that syncs plugin panes to the enabled set used to re-assert on every run: any enabled plugin whose
  panel wasn't mounted got (re)added. Since the registry emits a fresh `plugins` array on any fs event
  under /plugins, a hand-closed pane (enablement and panel-open are decoupled — a plugin can be enabled
  with its pane closed) kept re-opening. Now it mounts/unmounts only on enable→disable transitions
  vs a `prevEnabledRef` baseline (reset per-conversation before the state update so a switch doesn't
  diff against the previous conversation); the serialized Dockview layout owns open/closed state.
- **2026-07-04 — Tail-pin the transcript on resize (ResizeObserver).** Closing a bottom-docked panel
  makes Dockview reparent the transcript scroll container, resetting native `scrollTop` to 0 with no
  React state change to re-scroll. A ResizeObserver on the transcript re-pins to the tail when the user
  was at the bottom (also glues the tail through window/panel resizes generally).
- **2026-07-04 — Read-only lookup tool calls render collapsed by default.** `read|glob|grep|ls|
toolsearch|webfetch|websearch` start collapsed in the chat (they're just retrieved content, often a
  whole file), so the transcript isn't dominated by things the user didn't ask to read. A FAILED one
  still opens so errors stay visible; action/narrative tools (bash, edits, sub-agents, questions,
  context writes) keep default-open.
- **2026-07-04 — Permission mode is persisted (manifest) + app-wide default (state.json).** Bypass
  approvals silently reverted to 'default' on every relaunch/reopen because `permissionMode` lived
  only in the live Session — the user kept getting prompts they'd turned off. Now per-conversation in
  the manifest, and the last mode set anywhere becomes `defaultPermissionMode` for NEW conversations
  (the user treats bypass as one app-wide switch, not a per-conversation chore). Probe-verified
  (SDK_NOTES): under bypassPermissions the CLI never consults `canUseTool`, both at query build and
  after a runtime `setPermissionMode` — so honoring the mode is purely our state management.
- **2026-07-04 — Live UI state is pulled on panel mount (`agent:ui-state`), not event-only.** Push
  events only reach panels mounted when they fire; a ChatPanel remount (conversation switch, layout
  change) dropped pending approval cards — leaving the SDK blocked forever on a `canUseTool` promise
  nobody could see (the eternal "working" spinner with frozen tokens; a new message "unfroze" it only
  because the CLI aborts the pending request). Main now serves a `UiStateSnapshot` (status, mode,
  pending, questions, background, auto-resume, tokens) that the panel hydrates from on mount, ordered
  after the event subscription so nothing can fall in the gap. Pending entries keep their announced
  payloads so the exact cards can be re-served.
- **2026-07-04 — Busy state = turns in flight (counter), not `input.hasPending()`.** The SDK drains
  the input queue eagerly, so a message queued behind a running turn was invisible to `hasPending()`
  at result time — status flipped to 'idle' while the queued turn ran. Now send/fork increment and
  each `result` decrements; rebind/rate-limit-rejection/user-Stop reset to 0 (queued messages don't
  reliably survive those). A blocked-on-approval turn shows "needs approval", not "working".
- **2026-07-04 — A cleanly-ended pump = dead CLI → restart.** The message stream ending WITHOUT an
  error (CLI crash/kill) previously did nothing: status stayed 'working' forever and later sends
  queued into a stream nobody read. Now treated like a thrown pump error (surface + bounded restart).
- **2026-07-04 — Conversation view state lives in a renderer store, not the panel (visible ≡
  hidden).** Dockview disposes a conversation's panels on tab switch; holding live state in
  component state made hidden tabs second-class: streamed deltas broadcast while unmounted were
  dropped (text missing until the result reconciled), the elapsed clock restarted per remount, and
  composer drafts vanished. `src/services/conversationViewStore.ts`: one store per OPEN
  conversation (eagerly created by App), fed by ONE app-level onEvent router — state is written
  identically whether or not a panel is mounted; ChatPanel is a pure view (useSyncExternalStore).
  Ownership hierarchy: main = durable truth (uiState + on-disk transcript, consumed at store
  creation/crash-reload) → store = live working copy → panel = disposable view. High-frequency
  fields (composer draft, scroll position) are write-through NON-reactive store fields so a
  keystroke/scroll can never re-render the transcript. Killed with it: the
  `atelier-reload-transcript` window CustomEvent bus (App now calls store.reset()), per-panel
  event subscriptions, and the per-remount hydration crutch. Elapsed clock anchors on
  `turnStartedAt` (main-tracked, in UiStateSnapshot; mirrored by the reducer on status
  transitions) instead of a mount-time ref.

- Browser plugin input is a LOCATION, not a blob: new agent-writable `source` export takes a
  cwd-relative path (live-tailed file: channel) or an http(s) URL; `content` stays as a
  small-fragment fallback. Files beat blobs: no token cap, live reload, and the artifact
  persists in the repo.
- URL fetching is a DataBus source in main (`url:<href>`, one-shot, 15s/2MB/textual-only),
  NOT a pane-side fetch (sandbox has no network) and NOT an embedded webview (nested webviews
  don't work inside sandboxed plugin frames; readable-text-back-to-agent is the point).
- New `net:fetch` permission gates `url:` subscriptions separately from `data:subscribe` —
  network reach is a different capability class than reading the conversation's own files
  (invariant #3). Enforced at the PluginPane RPC boundary like the rest.
- Scripts in url-fetched content never execute in the Browser pane (even with "Run scripts"
  on): remote JS could drive the atelier bridge (context.set → text the agent trusts).
  External links in rendered content now click through via the url: fetch instead of a
  "needs webview" toast.

- Browser images render via URL resolution against the source, because content renders
  in-doc under the pane's own opaque origin (atelier-plugin://<id>/) so any relative/local
  <img> resolves to the plugin folder and 404s. Two cases: remote-fetched pages rewrite
  relative src/srcset to absolute against the page URL (pane-side, network loads them);
  local-file/agent-authored content fetches each relative image through a new mediated
  host read and swaps in a data: URL.
- Local image reads go through the bridge (new `atelier.data.readAsset(path)` →
  `plugin:read-asset` IPC → createAssetReader), NOT a new global privileged scheme: a raw
  <img> subresource GET carries no conversation id, so the host couldn't cwd-scope it; the
  bridge already knows the conversation. Reuses resolveWithinCwd; gated by the existing
  `data:subscribe` (same capability that reads cwd text via file:) — no new permission.
  Bounded to image extensions + a 10MB cap so it can't become a general file channel.
- Agent busy status is DERIVED, never assigned: a TurnLedger releases at most one user
  turn into the SDK at a time (the next only after the previous settles), and status is a
  pure function of closed/wedged/ledger.busy, emitted seq-stamped from a single sync()
  point. Chosen over patching the turnsInFlight counter because two iterations proved
  edge-triggered inference unfalsifiable: any missed/extra transition wedged the display
  permanently (docs/STATUS_LOCKSTEP.md). Consequences accepted: a message queued behind a
  running turn now waits for the turn to END (it can no longer interject mid-turn inside
  the CLI — deliberate, it was the 1:1-breaking path), and queued turns get their context
  block captured at RELEASE time (fresher than capture-at-send).
- Renderer reconciliation is level-triggered on top of pushes: resync (uiState pull,
  seq-gated) on store creation, panel mount, window focus (ALL stores — a hidden wedged
  tab heals unvisited), and every 30s while a store shows working. Encoded as tests
  because the aaf5a5d hydrate-on-remount guarantee silently regressed once already.
- Transient errors no longer flash status=error; they surface in the error list while
  status re-derives (working/idle). Sticky error is reserved for restart-budget-exhausted
  and auth failures (wedged flag), cleared by the next send.
