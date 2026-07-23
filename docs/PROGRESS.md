# PROGRESS.md — Atelier build log

## Session 2026-07-23 — bugs.txt batch #2: global usage + context-size readout (read this first)

On branch `feat/terminal-plugin`. Two bugs.txt items, gate green (typecheck, lint, format:check,
`npm test` now **469**, `npm run build`):

1. **Session/usage status was conversation-scoped and stalled.** The top-bar usage meter polled
   `agent.usage(activeId)` every 10s keyed to the active conversation — the interval restarted on
   every tab switch and never ticked when nothing was focused. Made `AgentManager.usage()` global
   (no `instanceId`): it reads the account-scoped SDK usage from ANY live session, caches the last
   non-empty snapshot, and serves it clock-corrected. IPC/preload/`AtelierApi` dropped the arg;
   `App.tsx` now polls every **30s** unconditionally (not keyed to `activeId`).
2. **Context-size readout under the composer.** New `agent.contextSize(instanceId)` →
   `ContextBreakdown` (total estimated tokens + per-contributor list). `pluginContextContributions`
   (contextTools.ts) mirrors `buildContextBlock`/`buildSystemInstruction` exactly to estimate each
   plugin's injected context + system instruction (chars≈tokens×4), grouped by plugin display name;
   `estimateTranscriptTokens` covers the chat history. `AgentManager.contextBreakdown` combines them
   via a new `breakdownProvider` (wired to the registry in main.ts). `ChatPanel` shows
   "~N tokens in context" below the input, expanding on hover into a bar-chart breakdown.

Needs human spot-check (GUI/live-session behavior):

- Usage meter keeps updating across conversation switches and with no conversation focused.
- Context-size readout shows a sane total and, on hover, lists each enabled context-plugin + chat
  history; total grows as the conversation and pinned docs grow.

## Session 2026-07-23 — terminal agent tools + bugs.txt batch (read this first)

On branch `feat/terminal-plugin`. Two pieces of work:

**Terminal plugin — agent can now drive the shared PTY.** Added `terminal_send` /
`terminal_read` / `terminal_interrupt` tools (manifest `kind: "both"` + `tools`; a `msg.tool`
branch in backend.cjs that reaches the same per-conversation PTY the pane drives). Reads are
ANSI-stripped with optional `tailLines` for polling a monitor loop. Commit `99d80a5`.

**bugs.txt (3 bugs), each its own commit, plan in `docs/BUGFIX_PLAN_2026-07-23.md`:**

1. **Conversations dropdown was dead** (`3dcde8a`) — `.conv-dropdown` sat in the frameless
   title bar's `-webkit-app-region: drag` region without opting out; the OS ate the click as a
   window-drag. Added `no-drag`. Root cause was CSS, not the (correct) React state.
2. **Links hijacked the whole app** (`8cb2e67`) — the main window's `webContents` had no
   `will-navigate`/`setWindowOpenHandler` (only the `<webview>` guest was guarded). Added
   `installMainNavigationGuard`: pins the frame to its own URL, routes http(s) to
   `shell.openExternal`.
3. **Startup script gave unfollowable instructions on other PCs** (`d61a8c9`) — bootstrap.mjs
   detected only OS and assumed PowerShell. Now detects the real shell (ATELIER_SHELL hint from
   each launcher + MSYSTEM/WSL/PSModulePath inference), drives all instructions from a per-shell
   profile, prints the detected environment, and picks bash-vs-powershell for the auto-install.

Gate green after each commit: typecheck, lint, format:check, `npm test` (461), `npm run build`.
The pre-existing uncommitted work on this branch (PluginRail.tsx refactor + its `.rail-sep` CSS
hunk, and the staged `plugins/examples/*` → `plugins/*` reorg) was deliberately left untouched —
my commits include only my own files.

Needs human spot-check (GUI behavior, not automatable headlessly):

- Bug 1: click ☰ Conversations → the dropdown of past conversations opens; re-open / delete work.
- Bug 2: click an http link in a chat message → it opens in the default browser and Atelier stays
  put. Also test a plugin pane that calls `window.open`.
- Bug 3: on a second machine / from cmd + Git Bash + WSL, run the startup script with a missing
  prerequisite → the printed commands match the shell you're in.

## Overnight session 2026-07-21 — summary (read this first)

Brandon's morning review of the 2026-07-20 batch (notifications good; explorer messy;
whiteboard buggy/not-editable; agent-flow "nearly useless" — git should be the primary
pillar) drove tonight. All seven items done, gate green per commit (suite now **327**),
mod plans in `docs/plugin-proposals/mods/`:

1. **notifications** — `?` setup help on every channel card (Discord/Slack webhook
   creation, BotFather flow, ntfy topics, Pushover keys, generic-webhook POST contract),
   add-row type summary, field hints, auto-ping/quiet-hours explainers.
2. **whiteboard** — two real bugs found and fixed: (a) the tab × called `confirm()` and
   rename `prompt()`, which are **silent no-ops in the sandbox** (no `allow-modals`) —
   replaced with inline confirm/rename, pitfall documented in PLUGIN_API.md ("no native
   dialogs"); (b) `mutateDoc` re-rendered the board when the save debounce fired, dumping
   focus out of the note/mermaid textareas mid-typing (the "can't write in the note
   board" report) — new `mutateDocSilent` path. Plus: teaching empty state with per-type
   add cards, chart type switcher + full visual data editor + waterfall renderer, table
   format mode (cell bg/text/bold/align in a `styles` map, style-key remap on row/col
   delete — pure helpers, tested), 3×3 table starter, note edit/split/preview modes,
   mermaid snippet bar + templates. `model.test.mjs` (14).
3. **workspace-explorer** — per-level indentation with guide lines (rows were flush-left),
   `icons.js` file-type registry (colored per-type doc glyphs + special shapes for
   folders/images/git/package/lock/docker/config), preview modes: .md renders (md.js,
   incl. pipe tables), .json prettifies, both toggle to code; mode persisted per
   extension; hover size badges.
4. **agent-flow REWORK** — four tabs → two. **Repo** (primary): health strip
   (branch/dirty/last-commit/CI badge/worktrees), accordion navigator — working tree →
   diffs, history with lane-graph gutter + ref/tag chips + search + full commit message
   body + per-file commit diffs (`commitDiff` multi-file op), branches & worktrees with
   per-worktree session annotation, stashes → stash diff, submodules, CI via `gh run
list --json` (absent-tolerant, 60s poll while visible). **Agent**: flat exact-order
   event log with a verbosity slider (L1 turns → L2 +tools → L3 everything → L4 raw JSON
   expanders), chips/search/follow-scroll, cross-links both directions. Parsers +9 tests.
5. **mission-control** (NEW, designs/mission-control.md v1 M1–M6) — in-progress/fleet/
   commands/done lanes, completed-while-away inbox (rebind-clear suppressed), templated
   nudges via agent.send with working guard, agent-maintained `work_summary` context
   export, history backfill.
6. **http-workbench** (NEW, designs/http-workbench.md) — builder + inert response viewer
   (JSON tree windowed, escaped text only), shared user/agent history (capped, secret-
   redacted, replay-with-edit), readonly ctx digest, `http_request` backend tool.
   **DEVIATION** from design §4.4: the backend performs the tool's fetch itself
   (mirroring `netFetch.ts` constraints exactly via `shared.cjs` — method allow-list,
   cookie dropped, 2MB/4MB caps, 60s max) because the host-relay wiring doesn't exist;
   ctx digest refreshes from the pane (live when open, rebuilt on mount).
   `shared.test.mjs` (11).
7. **Repo hygiene** — `electron/shared/pluginManifests.test.ts` validates every shipped
   plugin manifest against the live schema (auto-includes new ones); bugs.txt F2
   reconciled to done-pending-spot-check (Phase 7 workspace-local plugins closed it);
   PROPOSALS.md status updated.

**Needs live-app spot-check (2026-07-21 batch — headless can't cover panes):**

- whiteboard: × shows inline confirm and deletes; dblclick renames inline; type in a note
  without losing focus past the save debounce; chart type switcher + data editor round-
  trip; waterfall renders; table format mode paints cells and survives row/col delete;
  empty pane shows the four add cards (not "connecting" + blank).
- explorer: tree indents with guides; icons distinguish types at a glance; PROGRESS.md
  renders as markdown with tables; package.json prettifies; toggles persist per extension.
- agent-flow: health strip matches `git status` on this repo; history graph + refs render;
  commit click shows body + per-file diffs; worktrees annotate "this conversation" on the
  matching cwd; CI badge shows this repo's real runs; stash a change → Stashes section
  appears with a diff; Agent tab slider L1→L4 changes density, L4 rows expand to raw
  JSON; follow-scroll unpins on scroll-up.
- mission-control: run a subagent → fleet row with ticking clock + activity line; let it
  finish with the pane open → exactly one inbox chip; a Bash command shows in Commands;
  a nudge lands in the chat as the templated message; ask the agent to set the work
  summary → panel updates.
- http-workbench: send a GET to a real URL → status/timing/JSON tree; ask the agent to
  use `http_request` → the entry appears live in the open pane tagged "agent" and in the
  next turn's context digest; replay-with-edit from history; auth header shows redacted
  in history; close/reopen restores history.
- notifications: each channel's `?` expands readable setup steps.

## Overnight session 2026-07-20 — summary

All four plugins from the user review are BUILT and merged to main, gate green (276 tests):

1. **Host-API Tier 1 (A1–A8)** per docs/plugin-proposals/HOST-ADDENDUM.md — fs.list,
   shell.openPath, agent.compose, os.\*, agent.history, backend cwd/conversationId,
   backend.call RPC, backend storage protocol. PLUGIN_API.md + authoring guide updated.
2. **whiteboard** — mermaid/table/chart/note boards, comments, bidirectional sync.
3. **workspace-explorer** — lazy tree, heat overlay, live preview, open-in-editor,
   mention-in-chat.
4. **notifications** — 7 channels, notify_user tool (works with pane closed), rate caps.
5. **agent-flow** — Timeline/Changes/History/Branches tabs + git-reader service backend.

Docs updated per the 5-point user feedback (consolidation → agent-flow; mission-control and
http-workbench addenda; PROPOSALS.md status block). Each plugin's section below carries its
**needs human spot-check** list — the live-app checks to run in the morning (whiteboard
rendering, explorer heat/compose, notifications with real webhook URLs, agent-flow tabs,
plus OS toast/flash on real Windows).

Built `plugins/workspace-explorer/` (manifest.json, index.html, explorer.js) on the landed
Tier-1 host verbs (`fs:list`, `shell:open`, `agent:compose`, `agent:read`+`agent.history`).
Pure sandboxed frontend — no host code changed.

**Shipped (all spec §9 acceptance criteria):**

- Lazy one-level tree via `atelier.fs.list` (root + expand-on-click); expansion set persisted in
  `storage` and re-listed on mount (§9.1). dirs-first + ignored-sink sort.
- gitignore graying from the host `ignored` flag; "Hide ignored" toggle (persisted) removes them
  entirely; ignored dirs are not auto-listed (§9.2, §6).
- Read/write heat overlay: `tool_use` events classified (Read/Grep/Glob→read;
  Write/Edit/MultiEdit/NotebookEdit→write), stored as bounded `(path,kind,ts)` ring in `storage`,
  hue-distinguished (cool read bar / warm write bar), exponential decay computed at render (90s
  half-life, no per-file timers), folder rollup on collapsed dirs, hover detail, legend, freeze +
  clear-heat controls. Backfill via `agent.history(1000)` on mount (§9.3).
- Click preview: `file:` DataBus tail (live-updates), 128 KB truncation marker, images via
  `readAsset`, hand-rolled lightweight tokenizer (see DECISIONS) (§9.4).
- Double-click → `atelier.shell.openPath` (§9.5); right-click "Mention in chat" →
  `atelier.agent.compose('`path`')` with clipboard fallback on `{ error }` (§9.6).
- Targeted dir re-list on live agent _writes_ into an expanded dir (§6c) — no global watch/enumerate.

Gate green: typecheck, lint, format:check, `vitest run` (241/241). Manifest validated against the
live `ManifestSchema`.

**Needs live-app spot-check** (not verifiable headlessly — sandboxed iframe + real agent):

- Tree renders/expands and expansion survives close-reopen in the running app.
- Heat glows appear on real agent reads/writes, are read/write-distinct, and decay; reopening the
  pane rebuilds heat from `storage` + `agent.history`.
- `file:` preview live-updates when the selected file changes; image + truncation rendering.
- Double-click opens the external editor; right-click "Mention in chat" inserts into the composer
  without sending (and the clipboard fallback fires when the ChatPanel is unmounted).
- Containment: a deliberate throw in explorer.js stays isolated to the pane (rail error, app alive).

**Deviation from spec:** spec proposed `composer:insert`/`shell:openPath` permission names; the
landed names are `agent:compose`/`shell:open` with `atelier.agent.compose(text)` — reconciled to
the shipped host API (verified in `electron/shared/plugins.ts` + `runtime.ts`). Syntax highlight is
a lightweight hand-rolled tokenizer, not Shiki (see DECISIONS).

## agent-flow plugin (2026-07-20, autonomous session, worktree feat/agent-flow)

Built `plugins/agent-flow` per `docs/plugin-proposals/designs/agent-flow.md` — ONE panel pane,
four tabs, backed by a `service` git-reader backend.

Shipped:

- **Backend** (`backend.js`, service): learns `cwd` from hello/enable; runs git via `child_process`;
  RPC ops over `atelier.backend.call` — `status` (`--porcelain=v2 --branch -z`), `diff`
  (`file`/`staged`/`commit` variants, `<hash>^!` for a commit), `log` (US/RS pretty, cap 200),
  `commit` (header + `--name-status`), `branches` (`branch -vv` + `worktree list --porcelain`).
  Publishes `flow:status` on the DataBus on a ≥5s debounce (armed on enable + after any RPC).
  Diff capped at 500KB (`truncated:true`), git timeout 15s. Non-git cwd / missing git →
  `{ error:'not a git repository' | 'git not found' }` and a friendly pane empty state — never throws.
- **Parsers** (`gitParse.cjs`): pure, dependency-free `parseStatus/parseLog/parseBranches/`
  `parseWorktrees/parseDiff` — the bug farm, unit-tested in `gitParse.test.mjs` (20 fixture tests,
  node env; vitest `include` extended to `plugins/**/*.test.mjs`). All never throw on malformed input.
- **Pane** (`index.html` + `flow.js` + `styles.css`): tabs (Timeline/Changes/History/Branches).
  Timeline segments turns by `result` boundaries (AgentEvents carry no turn id), renders tool calls
  with one-line summaries + durations + ok/error, permission/question blocks, per-turn result/token/
  cost line, filter chips (all/tools/files/errors), and "view diff" cross-links. Changes: grouped
  staged/unstaged/untracked/conflicted list + unified diff (plain mono, add/del backgrounds, line
  numbers), refresh on file-write tool_result / tab focus / manual button / flow:status push.
  History: commits (session-window marked by mount-time), details + per-commit diff reusing the
  Changes renderer. Branches: branches + worktrees, READ-ONLY. Cross-link file→turns index both
  directions (timeline "view diff"→Changes; Changes "n turns" chip→timeline). Persists active tab /
  filter / selected file via `storage`.

Gate (all green): `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`
(261 tests, 29 files, incl. the 20 agent-flow parser tests).

Manifest note: the schema (`electron/shared/plugins.ts`) accepts `kind:"panel"` + `backend` +
`service:true` directly — the spec's `kind:"both"` fallback was NOT needed; validated against
`ManifestSchema.safeParse`.

Needs live-app spot-check (not verifiable headlessly):

1. Open on this dirty repo → Changes lists exactly what `git status` shows; staged vs unstaged split
   is correct; clicking a file renders a readable diff; a rename shows old→new.
2. Agent edits a file → Changes refreshes within ~5s with no user action (flow:status push); the
   Timeline shows the Edit with a working "view diff" link that selects it in Changes.
3. Close + reopen the pane → active tab, filter, and selected file restore; Timeline backfills past
   turns via `agent.history` and streams new ones live.
4. History renders recent commits with the "this session" badge on commits made after the pane
   mounted; clicking a commit shows its details + diff.
5. Branches lists branches (current highlighted, ahead/behind) + worktrees (this repo's multi-session
   worktrees) with no destructive buttons.
6. Non-git cwd → every git tab shows the friendly empty state, no thrown errors in devtools.
7. Kill the backend child mid-session → pane shows a per-op "backend unavailable" error and recovers
   after respawn (manager crash-loop guard).
8. A >500KB diff shows the truncation marker.

## Default plugin suite: proposals + bugs.txt fixes (2026-07-19, autonomous session)

- **bugs.txt bug 2 fixed** (commit `fix(agent): defer plugin-toggle rebind…`): toggling a
  plugin with tools/context exports rebound the SDK query immediately, closing the live
  query mid-turn and killing the streaming chain of thought. `setPluginEnabled` now rebinds
  only when idle; mid-turn it sets `pendingRebind`, applied at the next release in
  `maybeRelease` (same pattern as the standing-instruction rebind). **Spot-check:** toggle a
  plugin while Claude is mid-response — the response must finish; new tools apply next turn.
- **bugs.txt bug 1 verified as already implemented** (☰ Conversations dropdown lists all
  persisted conversations, reopen + delete; `AgentManager.listAll`). Marked done-pending-
  spot-check in bugs.txt.
- **Default plugin suite proposals**: `docs/plugin-proposals/PROPOSALS.md` — 13 researched
  candidates (git-workbench, change-review, agent-timeline, cost-dashboard, test-lens,
  proc-manager, workspace-explorer, mission-control, http-workbench, db-explorer,
  prompt-library, pr-watch, attention) with need/usage/pitch + suggested tiers and build
  order. Per-plugin design docs in `docs/plugin-proposals/designs/` (one Opus subagent
  each). Recurring HOST-GAP themes across designs (agent-event feed for plugins,
  composer-insert verb, chat-injection verb) should be reconciled before building.
- **Open question for Brandon:** bugs.txt F2's remaining half (conversation-local plugin
  discovery/registration) still awaits your call per the 2026-07-18 writeup.

## Install/startup system (bugs.txt F1) — landed (2026-07-19)

Design + reference: **docs/INSTALL.md**. `run.bat` / `run.sh` are thin Node-locators; all
logic is `scripts/bootstrap.mjs` (builtins only — runs pre-`npm install`): version gate →
`npm ci`+lockfile stamp → electron-binary repair → Claude CLI presence (consent-gated
official installer) → `claude auth status` login gate → build-staleness → detached launch.
`launch.ps1` (Desktop shortcut) now delegates to it. Also: `npm run doctor` / `bootstrap`,
`engines` field, `*.bat` pinned CRLF in .gitattributes.

**NEEDS HUMAN SPOT-CHECK:** (1) true fresh clone on a machine without Node / without the
Claude CLI / logged out (the interactive `claude auth login` + installer-consent paths);
(2) plain `run.bat` launch — not exercised headlessly because Atelier has no
single-instance lock and a second instance would share the live instance's userData.
Verified headlessly: doctor all-PASS + idempotent re-run, unverified→install→stamp→build
fix path, both wrappers (cmd + bash), stale-build detection.

## Plugin capability roadmap Phases 0–7 (2026-07-19)

Design: `docs/roadmap/`. Framing: sandbox = fault containment + coupling contract (DECISIONS
2026-07-19). Phases 0–6 committed on `feat/plugin-capability-roadmap` (PR #1). **Phase 7
(workspace-local plugins) landed too** and gate-green (206 tests) — decisions resolved (D1
workspace-local, D2 auto-enable). Per-phase detail in DECISIONS. This **closes bugs.txt F4 part (b)**
(the deferred conversation-local plugin authoring; the DEFERRED writeup below is now historical).

**Phase 7 (workspace-local plugins) — NEEDS HUMAN SPOT-CHECK (headless can't cover the GUI):**

1. In a conversation, have the agent write `<cwd>/.atelier/plugins/demo/{manifest.json,index.html}` →
   it appears in the rail badged "workspace" and auto-enables (pane mounts) with no restart.
2. Its tools + context exports work like a global plugin's; a `data:write`/`net:fetch` verb it uses
   is permitted.
3. Open a SECOND conversation on the same cwd → it sees `demo`. Open one on a DIFFERENT cwd → it does
   not.
4. Author a plugin whose id equals a global one → the rail shows it invalid ("shadowed"); the global
   one still works.
5. Delete the folder → it leaves the rail; an enabled-but-now-missing plugin degrades without a crash.

**Phase 6 (browser drive) — NEEDS HUMAN SPOT-CHECK:** run `npx electron scripts/verify-webview.mjs`
(GUI harness, now includes exec/fill/click drive cases + the nav-guard mirror). In-app: a
`browser:embed` plugin can `fill` + `click` on a live page and `read` the outcome.

**New plugin capabilities available to author against (Phases 1–6):** `agent.info/onEvent/send`,
`data.history`, `data.writeFile` (`data:write`), `layout.onResize`, `net.fetch` (`net:fetch`),
any-mime `readAsset`, `service:true` backends with DataBus publish + rich tool schemas +
`timeoutMs`, `browser.exec/click/fill`, and ES-module/same-origin panes. See PLUGIN_API.md +
`plugin_authoring_guide`.

**Phase 4 (backend services) — NEEDS HUMAN SPOT-CHECK (headless can't cover):** add a `service:true`
example plugin (a backend that publishes a heartbeat onto a channel its pane subscribes to) and
verify: enable → pane ticks; disable → child process dies (no orphan PID); re-enable → resumes; a
tool with `timeoutMs:120000` survives a 60s handler; reloading one plugin doesn't kill another's
backend. (Manager logic itself is unit-tested with an injected transport — 14 tests.)

**Phase 2 (same-origin panes) — NEEDS HUMAN SPOT-CHECK (headless can't cover):**

- **Process-isolation question (open — verify in-app).** Under the fault-containment mandate a
  `while(true)` in pane JS must not hang the whole app. With `allow-same-origin` the frame runs at
  origin `atelier-plugin://<id>`, a distinct site, so Chromium site isolation SHOULD give it its own
  renderer process (OOPIF) — but this is unverified. To check: run the app, open a plugin, run a
  busy loop in its console (or a temp plugin), and watch whether the app UI keeps responding +
  whether a separate PID appears (Task Manager / `app.getAppMetrics()`). If it hangs the app, file
  the fix (host panes in `<webview>` — the host API is postMessage-only so the sandbox tech is
  swappable, PLUGIN_API §9); do NOT migrate speculatively.
- **Verify matrix (open a plugin that exercises each):** `<script type="module">` with a relative
  `import` loads; `fetch('./x.json')` resolves from the plugin folder; `indexedDB.open` works;
  postMessage relay + theme + `pluginId` detection still work.
- **Regression spot-check:** every existing example still loads/functions (cognition, browser,
  bash-stream, hologram, data-table, cartographer) — the sandbox attribute change is app-wide.
- Optional follow-up (deferred): rebuild hologram as native ES modules + drop the esbuild bundle,
  only once the verify matrix is green.

## Live browser surface — `browser:embed` + `atelier.browser.*` (2026-07-19, uncommitted)

- **New shared plugin verb: a host-owned real-Chromium surface.** Permission `browser:embed`
  (electron/shared/plugins.ts; authoring guide auto-syncs from the enum) + `atelier.browser.*`
  runtime namespace (`open/close/back/forward/reload/stop/setBounds/read` + `on('browser')` nav
  events). `PluginPane` composites an Electron `<webview>` as a DOM sibling of the plugin iframe
  (wrapper div, bounds in pane coords from the plugin) and mediates every call; readback is
  host-side `executeJavaScript` extracting url/title/visible-text/interactive-elements (+capped
  HTML on request). Main hardens every attach (zero-privilege guest, http(s)-only, popups→in-place)
  — see DECISIONS 2026-07-19.
- **Browser plugin upgraded (0.3.0):** URL sources go live in the surface (real JS + real nav;
  webview-first back/forward layered over the source-history stack; page/snapshot exports from
  `browser.read()`); file/agent-pushed content unchanged in-doc. If the surface is unavailable or
  denied it falls back to the legacy static `url:` fetch render.
- **RESTART REQUIRED:** `webviewTag:true` is read at window creation — a running instance keeps the
  fallback until Atelier is restarted.
- **MACHINE-VERIFIED (2026-07-19, `npx electron scripts/verify-webview.mjs` — 12/12 + https
  bonus):** webview attaches under `webviewTag:true`; guard-hardened guest has no node globals;
  the production readback script (shared `electron/shared/browserRead.ts`) extracts
  title/text/links (incl. hrefs + input placeholders) from a live page; `window.open` opens NO OS
  window and navigates in place; guest history back/forward works; non-http `src` attach is
  prevented; a real https site (example.com) loads and reads back. Findings folded into the code:
  webview needs `allowpopups` (else `window.open` dies before the handler) and the open-handler
  must `setImmediate` the in-place `loadURL`.
- **NEEDS HUMAN SPOT-CHECK (integrated pane behavior only):** after restart —
  (a) `set_browser__source` → google.com renders live in the pane; (b) in-surface clicks track in
  the address bar, nav buttons, and `page` export; (c) Snapshot returns text+links+HTML; (d) file↔URL
  switching shows/hides the surface at the right bounds (toolbar visible; resize/dock/tab-hide
  tracks); (e) pre-restart the pane falls back to the static fetch without erroring.

## Status

- **Current phase:** P4 — Data channels + tool-contributing plugins + ambient Bash tap.
  **All three slices landed** on branch `feat/p4-data-channels` (gate-green — see the P4 sections):
  S1 DataBus + live file tail, S2 ambient Bash tap, S3 tool-contributing plugins. P4 is
  **code-complete; awaiting the GUI spot-check pass + merge to main.** P0/P1/P3 are functionally
  complete (human spot-checks outstanding); P2 + P5 are declared done by the user (2026-06-30). A
  renderer crash-recovery fix (ErrorBoundary + render-process-gone auto-reload) landed on main
  (6774568, CI green) and is merged into this branch.
- **Verified headlessly (2026-06-28):** `npm run typecheck` clean (both bundles). Earlier:
  `npm run build` clean; `npm run dev` launches Electron (4 processes, no errors); a one-shot
  SDK probe confirmed subscription auth (apiKeySource `none`, no API key) and token-by-token
  streaming.
- **NOTE:** prior PROGRESS said "current phase: P0" — that was stale. P0 is done and most of
  P1 shipped without the status being updated. This entry corrects the record.

## Context-doc `edit_` tool + `cartographer` plugin (2026-07-11, branch `feat/context-edit-tool`)

- **`edit_<plugin>__<key>` — targeted diff writes for context documents.** Every pinned export now
  gets `edit_` (old_string/new_string/replace_all) beside `set_`. Motivation: full-rewrite-only
  re-samples every untouched byte, so context docs silently drift and compound turn-over-turn, and
  an over-`maxTokens` value composed from its truncated injected view loses its tail. Contained to
  `buildContextMcpServers`; no renderer change (same `onChange` → pane refresh). +7 tests (22 in
  contextTools). Gate green (typecheck ×2, lint, 122 tests, build). DECISIONS 2026-07-11.
- **`cartographer` plugin.** Maps a subject's blocked conceptual shapes (blocks/shapes/probes,
  Map/Director framework — docs/CARTOGRAPHER_SPEC.md). One `map` JSON context export the agent
  maintains via `edit_`/`set_`; directives via `systemInstruction`; config folded into the map.
  Vanilla-SVG panel: nested-circle cluster (ring-pack, not d3.pack) + Memories (blocks) + Probe
  queue + valid-only JSON write-back editor + directives editor. Validated against the real
  `PluginRegistry` (manifest OK; all 10 plugins still valid). DECISIONS 2026-07-11.
- **NEEDS HUMAN SPOT-CHECK (not yet eyeballed in-app):** enable Cartographer in a conversation and
  confirm — (a) the pane renders (empty-state hint, then circles as shapes are added); (b) the agent
  sees the seeded map + gets `edit_cartographer__map`/`set_cartographer__map` and the directives in
  its system prompt; (c) agent edits push to the pane live; (d) the Source tab round-trips human JSON
  edits (invalid JSON blocks save); (e) the Directives tab writes the systemInstruction. The headless
  gate cannot exercise the rendered panel or the live agent loop.

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

## P4 — Data channels (slice 3: tool-contributing plugins) — landed 2026-06-30

A `kind:"both"` plugin contributes agent tools backed by an isolated child process. Gate green
(typecheck node+web, 79 tests, lint, format, build). Branch `feat/p4-data-channels`.

- `electron/plugin/PluginBackendManager.ts` — runs each plugin's `backend` as one Electron
  `utilityProcess` (lazy on first call, killed on disable/reload/quit; never in-process — CLAUDE.md).
  Request/response correlation by id, 30s timeout, child-exit rejects pending. **Transport-injected**
  so the broker is unit-tested without Electron (7 tests); the real `utilityProcess` transport is in
  main. Protocol: parent posts `{id,tool,input}`, child replies `{id,result|error}` via
  `process.parentPort`.
- `electron/plugin/pluginTools.ts` — `jsonSchemaToZodShape` (manifest descriptor → Zod, since
  manifests can't carry Zod) + `buildPluginTools`/`buildPluginToolServers` (each enabled tool-plugin's
  tools become SDK MCP tools whose handler forwards to the backend; merged into `mcpServers` as
  `atelier_plugins`). 6 tests.
- `AgentManager.setPluginEnabled` now also rebinds when a plugin `hasTools` (not only when it has
  context exports) — otherwise a tool-only plugin's tools never appeared. main.ts computes `hasTools`,
  stops the backend on disable, `stopAll` on reload/quit.
- `plugins/examples/tool-plugin/` — `kind:"both"`: a panel + `reverse_text`/`sum_numbers` tools with a
  `backend.cjs`.

**Needs human spot-check** (GUI + live agent turn, not headlessly verifiable — this is the
least-verifiable slice, all of it needs a real Electron run):

- Enable `tool-plugin`, ask the agent to "use the reverse_text tool on 'hologram'" → the tool is
  called, the backend (child process) returns `margoloh`, the result comes back in the turn.
- Disable the plugin → on the next turn the tool is gone (and its backend process is killed).
- Reload the plugin after editing `backend.cjs` → the next call runs the new code (fresh child).

## P4 — Data channels (slice 2: ambient Bash tap) — landed 2026-06-30

Read-only Pre/PostToolUse hooks tap the agent's Bash tool onto the DataBus; an xterm.js pane renders
it. Gate green (typecheck node+web, 68 tests, lint, format, build). Branch `feat/p4-data-channels`.

- SDK verification first (CLAUDE.md): confirmed hook surface against sdk.d.ts v0.3.195 — events are
  PascalCase, and **no streaming-stdout hook exists** (Pre = before/command, Post = after/full output).
  Recorded in docs/SDK_NOTES.md. So the tap is command-granular (announce → full output), not live
  token-by-token.
- `electron/agent/bashTap.ts` — `BashPublish` type + `bashResponseText` (faithful, ANSI-preserved
  extraction across the `tool_response` shapes). 6 unit tests (`bashTap.test.ts`).
- `AgentManager` — `buildBashHooks` adds PreToolUse/PostToolUse/PostToolUseFailure matchers scoped to
  `Bash`, publishing `{toolUseId, phase, command|text}` to the conversation-scoped `bash:stdout`
  channel; threaded as a `bash` provider (Session ctor + AgentManager ctor + `hooks()`); wired in
  main.ts to `dataBus.publish` (forward-ref). Hooks return `{continue:true}` — never block.
- `plugins/examples/bash-stream/` — an **xterm.js** pane (xterm + addon-fit vendored under `vendor/`,
  added to `.prettierignore`; xterm is a devDep), subscribes to `bash:stdout`, writes each frame
  (CRLF-normalized, ANSI intact), with a visible "Reality · ambient bash" banner (acceptance: marked
  ambient, not agent-authored).

**Needs human spot-check** (GUI, not headlessly verifiable):

- Enable `bash-stream`, ask the agent to run a shell command (e.g. `ls` / `echo`), confirm the
  command + its real output appear in the xterm pane, ANSI/colors intact, banner visibly marks it
  ambient. (Appears when the command completes — command-granular, by SDK limitation.)
- A failing command (e.g. `ls /nope`) shows its stderr as an error frame.

## 2026-07-02 — `browser` example plugin + launcher fix + Fable re-enabled (on feat/p4-data-channels)

Three small landings on the P4 branch (gate green each: typecheck node+web, 79 tests, lint, format):

- **`plugins/examples/browser`** — a render/browse surface built on P4. The agent pushes HTML/Markdown
  (`content` export, push-only) or the user loads a local file (`file:` DataBus source); it renders
  **in the plugin's own document** (so the live, post-interaction DOM is readable under the
  `allow-scripts`-only sandbox), and streams the page state + on-demand snapshots back as the `page`
  and `snapshot` exports. Toolbar: load/clear, Rendered/Source, Run-scripts, Stream-state, Snapshot.
  Local Markdown renderer (common subset). **Scope is local/authored content**; real external-site
  browsing (webview + main-process read/capture) is the documented follow-up (DECISIONS.md).
  _Needs human spot-check:_ enable it, have the agent `set_browser__content` some HTML → it renders;
  load a project `.md` → renders; interact → the agent's `page` state updates; Snapshot → agent gets it.
- **Launcher rebuild-on-change** — the pinned shortcut ran a frozen `out/` build so edits never showed;
  `scripts/launch.ps1` now rebuilds only when source is newer than the last build, then starts the app.
- **Fable 5 re-enabled** in the model picker (dropped the disabled/"(unavailable)" flag).

## P4 — Data channels (slice 1: DataBus + live file tail) — landed 2026-06-30

The `DataBus` + `data` host API, with a built-in file source and a `living-doc` example. Gate green
(typecheck node+web, 62 tests, lint, format, build). Branch `feat/p4-data-channels`.

- `electron/plugin/DataBus.ts` — per-conversation pub/sub. `subscribe/unsubscribe/publish`; sources
  open lazily on a channel's first subscriber and close on its last; the last value is cached and
  replayed to late joiners; `dropConversation` releases a conversation's channels on close. The
  `createFileSource` source tails `file:<rel>` (full contents on subscribe + on every change,
  debounced 50ms; read failures emit `{error}`).
- Path scoping: `resolveWithinCwd` (main.ts) maps a `file:` channel to a path **inside the owning
  conversation's cwd** and rejects escapes — a plugin can only tail files within its project.
- Wiring mirrors `context:changed`: `data` namespace in `runtime.ts` (a per-channel listener map),
  `data` branch in the `PluginPane` relay (perm-checked: `data:subscribe`/`data:publish`),
  `onDataMessage` routed to the owning pane by `pluginId`+`conversationId`, IPC + Zod schemas
  (`PluginDataChannelSchema`/`PluginDataPublishSchema`) + preload bridge. `AgentManager.cwdFor`.
- `plugins/examples/living-doc/` — a panel that live-tails a project file (default `docs/PROGRESS.md`),
  path persisted via `storage`.

**Needs human spot-check** (GUI, not headlessly verifiable):

- Enable `living-doc` in a conversation whose cwd is this repo → it renders `docs/PROGRESS.md`; have
  the agent (or you) edit that file → the pane updates live with **no reload and no polling**.
- Point it at a path outside the cwd (e.g. `../secret`) → it shows the "outside the conversation
  folder" error rather than reading the file.

**Remaining P4 slices:** S2 — ambient Bash tap (Pre/PostToolUse hook → `bash:<toolUseId>:stdout`
channel + `bash-stream` xterm.js example, marked ambient); first do the CLAUDE.md SDK hook
verification. S3 — tool-contributing plugins (`tools` perm + child-process backend worker +
`kind:"both"` example; unload removes the tool).

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

Remaining hardening backlog (lower priority, not blocking): AgentManager lifecycle tests
(SDK faked at the boundary); add the dev-compatible strict CSP (below).
_2026-07-21 (delegated to sonnet subagents in worktrees):_ transcriptModel reducer coverage
(+63 tests) and the IPC Zod-schema audit (+74 tests, all 17 plugin schemas incl. numeric
bounds) landed — suite 462; `no-explicit-any` was already at zero, so `npm run lint` now
enforces `--max-warnings 0`.

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

## 2026-06-30 — Hologram: agent→pane focus/command channel

Completed the bidirectional loop. A new `command` context export (`inject:false`) lets the agent
drive the pane: the pane polls it (700ms) and calls `engine.focusNode({ nodeId, path? })`, which
optionally switches to the node's cached path, highlights/selects the node, and flies the camera to
frame it. Unhandled commands (mid-tween, or the level not pushed yet) are left un-consumed so they
retry — so "push a scene, then focus a node in it" works even with the 1s poll. Build + manifest +
prettier clean. needs human spot-check after reload + pinning "Hologram command".

Bidirectional control now: pane→agent = `selection` (what the user references) + drill `request`;
agent→pane = `architecture` (the scene) + `command` (focus/highlight a node).

## 2026-07-04 — Agent environment self-awareness

A fresh conversation now knows it's inside Atelier and what plugins exist. Two always-on pieces
(`electron/plugin/introspection.ts`, wired in `main.ts`, docs/ENVIRONMENT_AWARENESS.md): a stable
`<atelier-environment>` briefing prepended to the system-prompt append (Atelier + cwd + catalog of all
discovered plugins), and a built-in `atelier` MCP server (`list_plugins`/`describe_plugin`) always
registered so the agent can introspect live enabled/pinned state + each plugin's tools/exports. Added
optional `description` to the manifest schema; populated it on every example plugin + hologram.
Gate green (typecheck node+web, 96 tests incl. new introspection.test.ts, eslint, prettier).

needs human spot-check: open a NEW chat in a NEW folder, ask "what plugins can you access / where are
you?" — expect the agent to name Atelier + list the catalog and offer describe_plugin; then have it
call describe_plugin on one and confirm the detail (tools/exports/enabled state) is accurate.

## 2026-07-04 — Three UX bug fixes (plugin pane / scroll / tool collapse)

1. **bash-stream (any plugin) re-opening after close.** The pane-reconcile effect re-asserted
   "enabled ⇒ mounted" every run, so a hand-closed pane reopened on the next registry `onChanged`
   (fresh `plugins` array). Now transition-based vs a `prevEnabledRef` baseline (App.tsx); the
   serialized layout owns open/closed. 2. **Chat jumped to top when closing a bottom panel.** Dockview
   reparents the transcript container → native scrollTop resets to 0. Added a ResizeObserver that
   re-pins to the tail when the user was at the bottom (ChatPanel.tsx). 3. **Read-only tool calls
   start collapsed** (`read|glob|grep|ls|toolsearch|webfetch|websearch`), failed ones still open
   (ToolCall.tsx). Gate green (typecheck node+web, 96 tests, eslint, prettier).

needs human spot-check after relaunch: close bash-stream → stays closed; close a bottom panel while
at chat tail → stays pinned to bottom; a Read call renders collapsed with its summary line.

## 2026-07-04 — Fix: bypass approvals not sticking + eternal "working" spinner

Root causes (both state-management, SDK behavior probe-verified sound): (1) `permissionMode` was
never persisted — every relaunch/reopen silently reverted bypass to 'default', so approval prompts
came back; (2) pending approvals/questions, busy status, and the mode toggle lived only in
ChatPanel's reducer — any panel remount lost the pending card while main stayed blocked on the
`canUseTool` promise, rendering as "working" for 20+ minutes with frozen tokens (a new user message
"unfroze" it because the CLI aborts the pending request → our abort handler denies → turn resumes).

Fixes: permissionMode persisted per conversation + `defaultPermissionMode` for new ones; new
`agent:ui-state` IPC serving a `UiStateSnapshot` the ChatPanel hydrates from on (re)mount (after
subscribing to events, so no gap); pending entries retain their announced payloads for re-serving;
`turnsInFlight` counter replaces `input.hasPending()` for truthful busy state (the SDK drains the
queue eagerly); header chip shows "needs approval" when blocked on a card; a cleanly-ended pump
(CLI died) now surfaces an error + restarts instead of sticking at 'working'; `setPermissionMode`
on a dead query rebinds instead of dropping the mode. Live probes (3, Haiku, temp cwds) confirmed:
bypass at build AND via runtime setPermissionMode suppress `canUseTool` entirely; 'default'
consults it — recorded in SDK_NOTES.md.

Gate green (typecheck node+web, 102 tests incl. new transcriptModel + conversationStore cases,
eslint, prettier).

needs human spot-check after relaunch: (a) toggle bypass ON, restart the app → toggle still ON and
tool calls run unprompted (incl. in a brand-new conversation); (b) trigger an approval prompt
(bypass off), switch conversations and back → the card is still there and answerable, header says
"needs approval"; (c) queue a second message mid-turn → status stays working until the second turn
finishes.

## 2026-07-04 — Refactor: per-conversation view store (visible and hidden tabs identical)

User-reported trio — elapsed timer restarting on tab switch, streamed text missing until the
message finished, composer drafts cleared — were all one lifetime mismatch: conversation view
state lived inside Dockview-disposed panels. New `src/services/conversationViewStore.ts`: a
store per open conversation (App creates them eagerly in refresh()), one app-level event router
reducing every AgentEvent into its store regardless of visibility, ChatPanel reduced to a pure
subscribing view. transcriptModel gains `turnStartedAt` (clock anchor, also main-tracked and in
UiStateSnapshot) + `autoResumeEnabled` (+ set-auto-resume action). Composer draft and scroll
position are non-reactive write-through store fields (keystrokes/scrolls never re-render the
transcript); scroll position is restored on remount (tail-pinned users land at the tail).
Removed: the `atelier-reload-transcript` CustomEvent bus, per-panel onEvent subscriptions, the
per-remount uiState hydration effect (hydration now happens once at store creation), and the
mount-time turnStartRef. Store routes only to EXISTING stores so dropped conversations can't
resurrect as zombies (close/delete → dropStore).

Gate green (typecheck node+web, 115 tests incl. 9 new store tests, eslint, prettier).

needs human spot-check after relaunch: start a long turn, switch tabs mid-stream and back →
full partial text present immediately, elapsed clock continuous; type a draft, switch away and
back → draft intact; scroll up in a long chat, switch away/back → same scroll position; clear
chat still empties the view; edit/fork, background viewer, and "needs approval" cards all still
behave.

## 2026-07-16 — Browser plugin: agent-set source (file path or URL), host-side URL fetch

User-reported: agent could only push content blobs (8k cap) into the Browser pane, and URLs
typed into the path box were resolved as cwd-relative FILE paths (`http://google.com` →
ENOENT). Rework: (1) new agent-writable `source` context export — a cwd-relative file path
(live-tailed) or an http(s) URL; preferred flow is now "write a viewable file, point source at
it". (2) New DataBus `url:` source in main — one-shot fetch, 15s timeout, 2MB cap, textual
content types only, `{error}` shape parity with the file source, abort + closed-guard on
close. (3) New `net:fetch` permission gating `url:` subscriptions at the PluginPane boundary.
(4) Pane: URL detection in the box, `source` context handling, restore order
(unconsumed source > last-loaded > pushed content > welcome), external links click through via
url: fetch, scripts in url-fetched content never execute (bridge-abuse guard).

needs human spot-check in-app: (a) agent sets `source` to a repo .md/.html → renders, then
edit the file → pane live-updates; (b) agent sets `source` to an https URL → fetches and
renders text (no scripts), page state export shows its visible text; (c) URL in the path box
works the same; bad URL/404 shows a readable error, not ENOENT; (d) plugin without `net:fetch`
subscribing to url: is rejected (permission error surfaced); (e) content push still works and
survives reload; (f) external link click inside rendered content navigates via fetch.

## 2026-07-16 — Browser plugin: images render (remote rewrite + local mediated read)

User-reported: images displayed as broken links. Cause: content renders in-document under
the pane's opaque origin (atelier-plugin://browser/), so relative/local <img> src resolved
to the plugin folder → 404 (and remote pages' relative images 404 the same way). Fix (both
cases): (1) remote url:-sourced content — pane rewrites relative img src/srcset to absolute
against the page URL. (2) local-file/agent-authored content — new mediated cwd binary read:
`atelier.data.readAsset(path)` → `plugin:read-asset` IPC → `createAssetReader` (electron/
plugin/assets.ts), image-ext allowlist + 10MB cap, cwd-scoped via the same resolver as the
file: source; the pane fetches each relative image and swaps in a data: URL. Reuses the
`data:subscribe` permission (no new capability). Snapshot HTML now collapses inlined data:
URIs so they don't eat the budget.

needs human spot-check in-app: (a) agent writes an .html/.md referencing a sibling PNG +
set_browser__source to it → image renders; edit the image on disk, reload → updates; (b)
fetch a remote page with relative images (set_browser__source to an https URL) → images
load; (c) a missing local image shows a titled broken marker, not a crash; (d) content push
with a relative image resolves from cwd root; (e) an absolute https image in local content
still loads directly.

## 2026-07-18 — Status lockstep: the busy indicator can no longer lie

User-reported (third iteration): conversations show "working"/"Running <tool>…" hours
after the turn finished. Live forensics (a conversation wedged 4.7h with a cleanly
completed transcript) + root-cause: status was edge-triggered inference — a stored field
plus a hand-maintained turnsInFlight counter compensated per-path — with no invariant, no
introspection, and no reconciliation, so one missed transition lied forever. Six defects
(B1–B6) and the full design are in docs/STATUS_LOCKSTEP.md. Rebuilt in 4 commits:
TurnLedger (at most one turn inside the SDK; sends↔turns 1:1 by construction) + status
derived from single-writer facts, seq-stamped from one sync() point; rebind now owns the
ledger swap (no rebind path can leave status stale); Stop gets a bounded grace rebind;
renderer applies status by seq and resyncs on store creation / panel mount / window focus /
30s-while-working; a 12-minute stall watchdog (guarded by pending cards + background work)
bounds unknown-unknowns; uiState carries statusSeq + the derivation facts.

needs human spot-check in-app: (a) run a turn to completion → header goes idle within a
second of the reply ending; (b) queue 2–3 messages while a turn runs → status stays
working through all of them, goes idle after the LAST reply, and each queued turn runs;
(c) mid-turn setEffort / plugin toggle / branch switch → the running turn stops but status
recovers (no eternal working); (d) Stop mid-turn → idle (or an error + recovery within
~10s); (e) switch away/back to a busy conversation → clock and status keep continuity;
(f) the previously wedged conversation reads idle after relaunch.

## 2026-07-18 — bugs.txt sweep: TaskCreate/spellcheck fixes + cognition/browser/plugin features

Worked the user's `bugs.txt` (now gitignored). Two bugs + three features shipped; Feature 4
part (a) shipped, part (b) designed and deferred. Full suite green (150 tests), typecheck +
lint + format:check clean. Not committed (awaiting user).

**Bugs (done, removed from bugs.txt):**

- **TaskCreate tasks miscategorized as background work.** `state.background` mixes
  `kind:'subagent'` (real running processes) and `kind:'task'` (TaskCreate to-do items); the
  renderer showed both under one spinner'd "running in the background" bar. Split in
  `ChatPanel.tsx`: subagents keep the spinner'd background bar; tasks get their own collapsible
  `.tasks` bar docked directly above the composer, below the background set, with NO spinner.
  Added `showTasks` to `ViewState`.
- **No spellcheck right-click suggestions in the composer.** Chromium was underlining
  misspellings but Electron ships no default context menu. Added `webPreferences.spellcheck:true`
  - `installSpellcheckMenu` in `main.ts` (a `context-menu` handler over editable content:
    `dictionarySuggestions` → `replaceMisspelling`, "Add to dictionary", cut/copy/paste/select-all).

**Features:**

- **F1 North Star (cognition).** Generic `readonly:true` context-export flag (schema + contextTools
  - introspection) — injected, no write-tool, user-only, non-empty-gated. Cognition gets a
    `north-star` export (first, readonly) + a North Star tab. See DECISIONS 2026-07-18.
- **F2 Clear button (cognition).** Header "Clear" → confirm → wipes the four agent docs (model/
  slots/plan/problems) via per-section clearers that reset DOM + write ''. North Star + guides kept.
- **F3 Browser nav.** back/forward/reload/stop with an in-pane history stack. See DECISIONS.
- **F4a `plugin_authoring_guide` tool.** Always-on `atelier`-server tool returning the plugin
  contract/API/rules/example; enums synced to the real schema (tested).

needs human spot-check in-app (headless can't cover the GUI): (a) trigger a TaskCreate → a
spinner-less task bar appears above the composer, below any background bar; collapsible;
subagents still show the spinner'd bar. (b) right-click a misspelled word in the composer →
suggestions + Add to dictionary. (c) set a North Star in the cognition pane → it appears in the
agent's `<atelier-context>` framed read-only and first; clear it → the section disappears; the
agent has no set_/edit_ tool for it. (d) cognition "Clear" → model/slots/plan/problems empty in
both the pane and the agent's context; North Star + guides intact. (e) browser: load two sources,
Back/Forward move between them, Reload refetches, Stop cancels an in-flight URL fetch; buttons
disable correctly at the ends and when idle. (f) `plugin_authoring_guide` returns the full brief.

**F4 part (b) — conversation-local plugin authoring — DEFERRED (needs a product+security call):**

Goal: a conversation authors a plugin visible only to itself, not global / not other conversations.
Blockers that make this a real decision, not a mechanical add:

1. **Registry is global + pervasive.** `PluginRegistry` is a single id-keyed catalog scanning
   `/plugins`, and `registry.get(id)` is called all over `main.ts` (context block, MCP servers,
   asset serving, introspection). Per-conversation plugins mean either (i) a per-conversation
   registry overlay merged into every resolution site, or (ii) scoping every call by conversation.
   Both are wide changes; a half-slice leaves dead/confusing code. There is no small reversible
   slice that delivers value on its own.
2. **On-disk location is a product choice.** "folder-specific" suggests `<cwd>/.atelier/plugins/<id>`
   (tied to the working directory — travels with the repo, visible to git). Alternative:
   per-conversation userData. These have different sharing/leak semantics and different answers to
   "what happens when two conversations open the same cwd" (then it's not really conversation-local).
3. **Trust model.** An agent authoring a plugin folder that then loads sandboxed code + registers
   tools into the GUI is a meaningful capability escalation (self-authored tools/panels). CLAUDE.md
   invariants (capability-bounded plugins; backends as child processes, never in-process hot-reload)
   still hold, but whether the agent may do this unprompted, or only on explicit user action / with a
   confirmation, is the user's call.

Recommended most-reversible design if we proceed: discover `<cwd>/.atelier/plugins` as a SECOND
source, merged read-only into ONLY that conversation's available-plugins list (id collisions with
global lose to global or are flagged), enable-state stays per-conversation as today, assets served
by resolving the conversation's local dir first. Gate creation behind an explicit user action or a
per-plugin confirmation. The `plugin_authoring_guide` tool (shipped) is the agent-facing half and is
useful regardless of where (b) lands.

## whiteboard plugin — done (feat/whiteboard worktree)

Built `plugins/whiteboard` per docs/plugin-proposals/designs/whiteboard.md. All five
milestones implemented: tab shell + note + comments + sync (M1), table boards (M2),
charts bar/line/area/scatter/pie (M3), mermaid vendored + error-tolerant + pan/zoom +
svg export (M4), defaults.json guide + starter-board-of-each-type + size guard +
active-tab steering (M5).

Files: manifest.json, index.html, defaults.json, model.js (pure sync/merge),
note.js, charts.js, table-board.js, mermaid-board.js, app.js, vendor/mermaid.min.js
(mermaid@11.16.0, MIT, offline).

Verified headlessly:

- model.js: 25 unit assertions (parse tolerance, malformed-keeps-raw, unknown-field
  preservation on serialize, immutable updateBoard/addComment, unique newBoard ids,
  boardFieldChanged, sizeInfo guard, active-only + array-top edge cases) — all pass.
- note.js markdown: 8 assertions (headings/lists/bold/code/fence/HTML-escape/null) — pass.
- defaults.json valid JSON; embedded ctx:boards parses to one board of each of the 4
  types with active:"arch". guide:boards present (2.2KB).
- All 6 JS files pass `node --check`. Whiteboard files pass `prettier --check`.
- Repo gate green: `npm run lint`, `npm run typecheck` (node+web) both pass. format:check
  shows only 4 PRE-EXISTING doc warnings (agent-flow/notifications/README/whiteboard .md)
  I did not touch; my files are clean.
- mermaid.min.js confirmed self-contained (0 dynamic import()/chunk refs; sets global
  `mermaid`) so it renders offline from a single <script>.

Needs human spot-check (live app — supervisor):

1. Load the plugin; the starter boards render — mermaid flowchart, bench table, grouped
   bar chart, and the note (all 4 tabs, acceptance #1).
2. Agent `set_whiteboard__boards` with one board of each type → all four render.
3. Edit a table cell + add a comment → next agent turn's injected `boards` export shows
   both (acceptance #2).
4. `edit_whiteboard__boards` changing one mermaid node label re-renders; comments/edits
   elsewhere survive (acceptance #3).
5. Push a mermaid syntax error → error card + raw source shown; other tabs unaffected;
   doc not corrupted (acceptance #4).
6. Close/reopen pane + restart app → boards restore (context) and last-active tab restores
   (storage key `activeTab`) (acceptance #5).
7. Malformed JSON export → non-destructive banner with raw text + fix-in-place; never
   overwritten with {} (acceptance #6).
8. Confirm no network requests at runtime (offline) — vendored mermaid only (acceptance #7).
9. Chart interactions: hover tooltips, legend, "view as table" toggle; scatter + pie boards.
10. Mermaid pan/zoom (wheel/drag), copy-source, download-.svg buttons.
11. Theme: verify boards read host CSS vars in both dark and light themes.

## Host-API addendum Tier 1 (A1–A8) — landed

Implemented the full Tier-1 slice of docs/plugin-proposals/HOST-ADDENDUM.md:

- A1 atelier.fs.list(dir?) — perm fs:list; cwd-scoped non-recursive listing, host-side
  gitignore `ignored` flag, 5000-entry cap (electron/plugin/fsList.ts + test).
- A2 atelier.shell.openPath(path) — perm shell:open; re-gated cwd-scoped opener
  (electron/plugin/openPath.ts + test). Renderer's app.openPath stays unexposed to sandboxes.
- A3 atelier.agent.compose(text) — perm agent:compose; stages into the pane's ChatPanel
  composer at the cursor via src/services/composerRegistry.ts; { error:'composer not open' }.
- A4 atelier.os.* — perm os:notify; Electron Notification + tag coalescing + rate cap, flash,
  badge (best-effort), focus query, notification-click + window-focus push events
  (electron/plugin/osNotify.ts + test).
- A5 atelier.agent.history(limit?) — perm agent:read; per-conversation ring (cap 1000),
  oldest→newest, default 200/max 1000 (electron/plugin/agentHistory.ts + test).
- A6 cwd in hello/enable, conversationId on tool invokes (PluginBackendManager).
- A7 atelier.backend.call(op, params?, timeoutMs?) — panel→own service backend RPC
  (PluginBackendManager.callRpc + tests).
- A8 backend storage protocol { id, storage:{op,conversationId,key?,value?} } gated by the
  plugin's `storage` permission (PluginBackendManager broker + tests).
  Docs updated: PLUGIN_API.md, in-app plugin_authoring_guide, example backend.cjs.
  Needs human spot-check: OS notifications / taskbar flash / badge behavior on real Windows
  (headless tests cover the manager logic, not Electron's Notification/flashFrame/setBadgeCount);
  composer insertion caret behavior in the live app.
  Future work: A5 history ring is in-memory only (no persistence across restart).

## notifications plugin (feat/notifications) — 2026-07-20

Built `plugins/notifications` per docs/plugin-proposals/designs/notifications.md.

Done:

- Manifest (`kind:both`, `service:true`, perms agent:read/storage/os:notify/data:subscribe/
  data:publish/net:fetch; `notify_user` tool; readonly `notify_status` context export). Validated
  against the real ManifestSchema in a test (schema is ground truth). No deviation needed — the
  spec's manifest sketch validates as-is; the `tools` permission is NOT required (tools register
  from the `tools` array), so it is omitted.
- Backend (`backend.cjs`, service): owns outbound HTTP for webhook/discord/slack/telegram/ntfy/
  pushover via Node `fetch`; `notify_user` tool with per-conversation rate caps (≤1/10s, ≤10/hr)
  returning `{ delivered, failed }`; pane RPC ops `sendTest` + `send`; reads pane settings via the
  A8 storage protocol; appends to a bounded-200 ping log in storage; publishes each outcome on the
  `notify:log` DataBus channel; per-channel failure isolation via `Promise.allSettled`; 15s
  per-request abort; malformed settings → clear `{ error }`, never a throw.
- Pure logic split into `channels.cjs` (payload builders + urgency mapping) and `ratelimit.cjs`
  (rate limiter) — framework-free CommonJS, unit-tested headlessly in
  `electron/plugin/notificationsPayloads.test.ts` (15 tests: manifest, all 7 builders, error
  paths, secret-not-in-error, rate caps incl. per-conversation isolation + hour-window slide).
- Pane (`index.html` + `channels.browser.js`): channel add/edit/remove with masked secret inputs,
  per-event-class toggles (turn-finished/blocked/error/agent-initiated), quiet hours (HH:MM, wraps
  midnight), ping log (seeded from storage + live via `notify:log`), os-toast delivery via
  `atelier.os.notify` (also fulfils backend `notify:toast` requests when open), and the auto-event
  watcher (`agent.onEvent` + `agent.history` catch-up) with debounce/re-arm per spec §4 (one
  turn-finished per result msgId; one blocked ping per unresolved permission/question requestId,
  re-armed on resolve; a single catch-up blocked ping for a block already pending at mount).
  Maintains the readonly `notify_status` export (channel NAMES + enabled flags only — never
  secrets).

Needs human spot-check in the live app (cannot verify headlessly):

- Add a Discord/generic webhook, click "Send test" → message arrives + shows in the ping log (AC1).
- Agent calls `notify_user` with the pane CLOSED → delivery still happens via the service backend
  (AC2). REQUIRES the user's own webhook URL / bot tokens — no real endpoints can be hit in CI.
- Turn finish / permission block with the pane open → OS toast + enabled channels ping, respecting
  toggles + quiet hours (AC3).
- Confirm secrets stay masked after entry and never appear in the ping log, tool result, or the
  `notify_status` export (AC4 — enforced in code + a unit test for builder error strings).
- Bad-URL channel is contained: reported in log + `failed`, other channels still deliver (AC5).
- Rate cap holds under a notify_user loop (AC6 — unit-tested; confirm end-to-end).

Note: real channel delivery requires the user to paste their own webhook URLs / bot tokens; none
can be exercised in automated tests, hence the payload-builder + rate-limiter unit tests instead.

## 2026-07-22 — terminal plugin (interactive PTY shell)

New bundled plugin `plugins/terminal/`: a real, interactive shell pane (xterm.js front,
`@homebridge/node-pty-prebuilt-multiarch` PTY backend running in the utilityProcess). One shell
per conversation, spawned on `enable` in the conversation cwd, killed on `disable`; pane drives it
over `backend.call` RPC (`attach`/`write`/`resize`/`restart`) and reads output from the
`terminal:out` DataBus channel. Defaults to git-bash on Windows (falls back to cmd;
`ATELIER_TERMINAL_SHELL` overrides). See DECISIONS.md 2026-07-22 for the dependency + protocol
rationale.

De-risked before building UI (the native-module question was the whole risk):

- **Native module loads under Electron's ABI with no rebuild/compiler** — probed the real
  `utilityProcess` (Electron 42, `NODE_MODULE_VERSION` 146, win-x64): shipped `build/Release/pty.node`
  loaded and drove a live `cmd.exe` (ConPTY, real `%TIME%` expansion). PASS.
- **Backend contract verified end-to-end** — drove the real `backend.cjs` with
  PluginBackendManager's exact `hello`/`enable`/`rpc` message shapes: spawned git-bash, `attach`
  returned the scrollback buffer + shell/cwd/pid, `write` of `echo $((6*7))` streamed back a publish
  containing `INTEGRATION_42` (live execution, correct conversation-scoped publish). PASS.

Gate green: format:check, lint, typecheck, `npm test` (466), `npm run build`.

Needs human spot-check (not automatable headlessly):

- Enable the Terminal plugin in a conversation → a bash prompt appears in the pane; type
  `ls`/`vim`/`htop` → interactive TUIs render and respond; resize the pane → shell reflows.
- Close and reopen the pane on a running shell → scrollback tail restored via `attach`.
- Restart button kills and respawns the shell.
- macOS: the fork ships no darwin prebuilt in the tarball — confirm install behavior there (may
  source-build; bootstrap `checkNativeModules()` notes a missing binary but never blocks launch).
