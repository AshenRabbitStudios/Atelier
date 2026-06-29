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
