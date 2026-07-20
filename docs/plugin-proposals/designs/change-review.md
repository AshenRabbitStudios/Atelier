# change-review — design doc

**Status:** design (not built). **Tier:** T1 (ships enabled-by-default). **Kind:** `both`
(a panel + a small backend, plus context exports). Proposal source:
`docs/plugin-proposals/PROPOSALS.md` §2. Normative contracts this doc is grounded in:
`PLUGIN_API.md`, `docs/PLUGIN_ARCHITECTURE.md`, `docs/CONTEXT_SYSTEM.md`, and the shared
schemas in `electron/shared/plugins.ts` + `electron/shared/events.ts`.

Every API claim below is tagged: **[contract]** = stated in a normative doc / present in the
shared schema or injected runtime; **[extrapolation]** = my inference, not yet guaranteed;
**HOST-GAP** = a capability that does not exist yet and must be built for this plugin to work.

---

## 1. Purpose + user stories

**Purpose.** `change-review` is the _trust interface_ for the agent's work product. It is
distinct from `git-workbench` (repo plumbing: staged/unstaged, commit): change-review reviews
_what the agent did this session_, turn by turn, hunk by hunk, and lets the user **keep** or
**revert** individual hunks — attaching a one-line reason to a revert that is fed back into the
agent's context as steering feedback. It exists because the #1 community complaint about agentic
coding is discovering a runaway refactor after the fact (40 files changed, requirements missed,
duplicate code). change-review makes the changeset _bounded and reviewable per turn_ and warns
when a turn blows past a budget.

**Why it's uniquely possible in Atelier.** The host already streams every tool call (including
file edits) to observers as structured `AgentEvent`s **[contract]**, and already has a
first-class mechanism (`contextExports`) for feeding a document back into the agent every turn
**[contract]**. change-review is the composition of those two facts.

**User stories.**

1. _As a supervising user_, after the agent finishes a turn I want to see exactly which files
   it touched and the diff of each, grouped by the turn that produced them, so I never have to
   alt-tab to a terminal to `git diff`.
2. _As a cautious user_, I want to reject one bad hunk out of a good turn (e.g. the agent
   deleted a guard clause it shouldn't have) **without** throwing away the rest of the turn's
   work, and have the file written back to its pre-hunk state safely.
3. _As a user steering the agent_, when I revert a hunk I want to type one line of "why" and
   have the agent _see_ that its change was rejected and the reason, so its next turn corrects
   course instead of re-doing the same thing.
4. _As a user worried about runaway refactors_, I want a loud banner the moment a single turn
   exceeds N files or M lines, so I catch a 40-file blast **during** the turn, not on the bill.
5. _As a user who cleared the chat_, I want my review state (what I've already kept/reverted,
   pending rejections) to survive the clear, restart, and pane open/close, because
   change-review's storage is per-conversation and durable **[contract]**.

---

## 2. Panel UX

The pane is one scrollable review column. Top-down: **budget banner** (conditional) → **turn
groups** (newest first) → each turn's **file cards** → each file's **hunks** with per-hunk
controls.

### 2.1 Grouping by turn

- A **turn** is one user→agent round (delimited by the `result` `AgentEvent` **[contract]**,
  which marks a turn's end). Each turn group has a header: turn ordinal, timestamp, a one-line
  summary (`N files, +A −B lines`), and a collapse toggle.
- Within a turn, one **file card** per touched path: path (cwd-relative), file-level
  `+A −B` counts, a language-tagged, syntax-highlighted diff (Shiki, per the stack in CLAUDE.md),
  and a card-level status chip: `pending` / `kept` / `reverted (partial)` / `reverted (all)`.
- Newest turn is pinned at top and auto-expanded; older turns collapse to a one-line summary.

### 2.2 Hunk view

- Each file card renders its diff as discrete **hunks** (contiguous `@@` change blocks). Each
  hunk shows the unified-diff body (added lines green, removed lines red) and two controls:
  **✓ Keep** (default; no-op that just marks it reviewed) and **↩ Revert**.
- A hunk carries a stable local id (`turnId:path:hunkIndex`) so its keep/revert state persists
  in `storage` and survives a remount **[contract: §8 restore]**.
- Binary files and renames get a _summary row_ instead of a hunk body (see §8) — they are
  reviewable-as-a-unit (revert the whole change) but not hunk-splittable.

### 2.3 Revert flow

1. User clicks **↩ Revert** on a hunk. An inline reason field appears (placeholder: _"why is
   this wrong? (optional, but the agent will see it)"_).
2. User confirms. The pane asks the host to apply the reverse of that hunk to the file on disk
   (§4.2), then marks the hunk `reverted` and records the reason.
3. The reason (with the hunk's location) is appended to the plugin's **rejections context
   export** (§4.3), which the agent sees on its next turn.
4. A per-turn "Revert all in this turn" affordance reverts every still-present hunk of a turn in
   one action (useful for a whole bad refactor).

### 2.4 Budget banner

- Config: `maxFilesPerTurn` (default 10) and `maxLinesPerTurn` (default 400) **[extrapolation:
  defaults]**, editable in a small pane header settings popover, persisted in `storage`.
- When a turn's running totals cross either threshold **while the turn is still in flight**, a
  sticky banner appears at the top of that turn's group: _"⚠ This turn changed 23 files / 1,140
  lines — over your review budget (10 files / 400 lines)."_ The banner is amber for "over" and
  offers two buttons: **Jump to this turn** and **Pause agent** (best-effort; see HOST-GAP).
- The banner is advisory, not blocking — it never prevents the agent from writing; it makes the
  blast radius _loud_ the moment it happens. This matches the "diff stays within bounds"
  observability pattern the proposal cites.

---

## 3. Manifest sketch

Real JSON, validated against `ManifestSchema` / `ContextExportSchema` / `PluginToolSchema` in
`electron/shared/plugins.ts` **[contract]**. Every field below exists in that schema.

```jsonc
{
  "id": "change-review",
  "name": "Change Review",
  "version": "0.1.0",
  "description": "Review the agent's file edits this conversation, turn by turn, hunk by hunk. Keep or revert individual hunks; a reverted hunk writes the file back and its reason is fed back to you as steering feedback so you know the change was rejected and why. A budget banner flags any turn that changes more than N files or M lines. Read the `rejections` context each turn and course-correct: do not re-apply a reverted change.",
  "icon": "M3 3h7l3 3v7H3zM6 8.5l1.5 1.5 3-3M9.5 12.5l3-3",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.cjs",
  "permissions": ["agent:read", "data:write", "storage", "context", "tools"],
  "defaultDock": "right",
  "contextExports": [
    {
      "key": "rejections",
      "label": "Rejected changes",
      "format": "markdown",
      "maxTokens": 1500,
      "readonly": true
    }
  ],
  "tools": [
    {
      "name": "review_status",
      "description": "Report the current review state: per-turn file/line counts, which hunks are pending/kept/reverted, and any over-budget turns. Call this to check whether your recent edits were accepted before continuing.",
      "inputSchema": {}
    }
  ]
}
```

**Field notes (all grounded in the schema):**

- `permissions` — every entry is in `PLUGIN_PERMISSIONS` **[contract]**:
  - `agent:read` — subscribe to this conversation's `AgentEvent` stream to observe file-edit
    tool calls (§4.1). This is the load-bearing capability.
  - `data:write` — write a file back on revert via `atelier.data.writeFile(path, content)`
    (§4.2). Atomic, cwd-bounded, ≤5MB host-side **[contract: `fileWrite.ts`]**.
  - `storage` — persist review state (kept/reverted hunk ids, reasons, budget config) so the
    pane fully rebuilds on remount **[contract: §8]**.
  - `context` — needed so the host registers/injects the `rejections` export and the pane can
    write it via `atelier.context.set` (§4.3).
  - `tools` — register the `review_status` agent tool; requires the `backend` module
    **[contract: §5]**.
- `contextExports[0].readonly: true` — the `rejections` doc is authored by the pane/host (from
  the user's revert reasons), injected into context every turn to steer the agent, but the agent
  gets **no `set_`/`edit_` write-tool** for it — only the pane changes it. This is exactly the
  `readonly` export semantic in `ContextExportSchema` ("injected... but NO write-tool is
  registered — only the pane can change it") **[contract]**, mirroring cognition's `north-star`.
- `tools[0].inputSchema: {}` — a no-arg tool; the `inputSchema` map may be empty
  **[extrapolation: empty map accepted — the field is `.optional()` and a `{}` record validates]**.

---

## 4. Data flow

### 4.1 Learning which files the agent touched

**Mechanism [contract].** The plugin calls `atelier.agent.onEvent(cb)` (injected runtime,
`electron/plugin/runtime.ts`; gated by `agent:read`). This forwards **this conversation's**
`AgentEvent` union — the same one the chat consumes — which includes:

- `tool_use` — `{ kind:'tool_use', toolUseId, name, input }` **[contract:
  `electron/shared/events.ts`]**. For an edit, `name` is one of `Write` / `Edit` / `MultiEdit`
  and `input` carries the path + content (`Write`: `{ file_path, content }`; `Edit`:
  `{ file_path, old_string, new_string, replace_all? }`; `MultiEdit`: `{ file_path, edits[] }`)
  **[extrapolation: these are the standard Claude Code edit-tool shapes; the exact field names
  must be confirmed against the live SDK/tool schema and recorded in docs/SDK_NOTES.md before
  building]**.
- `tool_result` — `{ kind:'tool_result', toolUseId, ok, output }` **[contract]**. The plugin
  pairs a `tool_use` with its `tool_result` by `toolUseId` and only records an edit whose result
  is `ok:true` (a denied/failed edit never hit disk).
- `result` — `{ kind:'result', ... }` **[contract]** closes the turn; the plugin flushes the
  accumulated edits into a new turn group and evaluates the budget.

**Accumulation model.** The plugin maintains, in memory + `storage`, a list of turns; each turn
holds the edits observed between two `result` events. Because `onEvent` only forwards events to
panes _mounted when they fire_ **[contract: the same "push events only reach mounted panels"
caveat as `UiStateSnapshot`]**, a pane that mounts mid-session must reconstruct history — see
the HOST-GAP on transcript access.

**Computing hunks.** For each edit the plugin needs the _before_ and _after_ text to compute a
diff:

- For `Edit`/`MultiEdit`, the `old_string`/`new_string` in the tool `input` already **are** the
  change; a hunk falls out directly. **[extrapolation]**
- For `Write` (full-file replace) and to render surrounding context lines, the plugin needs the
  file's _prior_ content. It can subscribe to the file as a `file:<rel>` DataBus source
  (live-tailed, `data:subscribe`) **[contract]** to know the current on-disk text, but the
  _pre-edit_ baseline is what matters. The plugin captures a baseline snapshot the **first** time
  it sees a path in the session (reading current disk content) and then diffs each subsequent
  version against the running "kept" state. See §5 for the git-aware refinement.

### 4.2 Applying a revert safely

A hunk revert = re-write the file with that hunk's change undone, leaving every other hunk of the
file intact.

1. The pane holds the file's current text (from its `file:` subscription or its last-known
   post-edit snapshot).
2. It computes `newText` = current text with the target hunk's added lines removed / removed
   lines restored (a reverse-apply of that one hunk).
3. It calls `atelier.data.writeFile(path, newText)` **[contract]**. Host-side this is
   `createFileWriter` in `electron/plugin/fileWrite.ts`: **atomic (temp + rename)**,
   **cwd-bounded** (a path escaping the conversation cwd returns `{ error }`, never writes),
   **≤5MB**, and **never throws across the relay** — a failure is `{ error }` the pane renders
   inline **[contract: `fileWrite.ts`]**.
4. On `{ ok: true }` the hunk is marked `reverted` in `storage`; on `{ error }` the pane shows
   the message and leaves the hunk `pending`.

**Concurrency safety.** Before writing, the pane re-reads the current on-disk text (its `file:`
subscription is live-tailed **[contract]**) and re-anchors the hunk against it. If the hunk's
context no longer matches (the agent edited the same region after the observed edit), the revert
is **refused** with "the file changed since this edit — re-review". This is the same
missing/non-unique-anchor failure mode the context `edit_` tool guards against **[contract:
CONTEXT_SYSTEM.md]**, applied to file reverts. This prevents a stale revert from clobbering a
newer edit.

### 4.3 Feeding feedback back to the agent

Two independent channels; use both:

1. **Standing steering (every turn) — the `rejections` context export [contract].** On each
   revert the pane appends a line to the `rejections` doc and writes it via
   `atelier.context.set('rejections', md)` **[contract: runtime `context.set`]**. Because the
   export is declared in the manifest and the plugin is enabled, the host injects the current
   value into the agent's context **every turn**, framed as `<atelier-context>` and stripped from
   the visible transcript **[contract: CONTEXT_SYSTEM.md §"Reads it into context every turn"]**.
   The agent thus always sees the running list of what was rejected and why. Format:

   ```markdown
   # Rejected changes (do not re-apply these)

   - `src/auth.ts` @@ lines 40–48 — reverted: "don't remove the null guard, it's load-bearing"
   - `src/api.ts` (whole file) — reverted: "wrong endpoint, we use /v2 not /v1"
   ```

   The doc is bounded by `maxTokens: 1500`; the host truncates with a marker if it overflows
   **[contract]**. To keep it bounded over a long session, the pane trims to the most recent K
   rejections and/or lets the user clear resolved ones.

2. **Immediate nudge (optional) — `atelier.agent.send(text)` [contract].** For a revert the user
   wants acted on _now_ (not just seen next turn), the pane can send a normal user message
   ("I reverted your change to src/auth.ts — the null guard is required; leave it"). Requires
   `agent:send`. This is a bigger hammer (it consumes a turn); default off, offered as a
   per-revert "tell the agent now" toggle. Adding `agent:send` to `permissions` is optional and
   only if this affordance ships.

The `review_status` tool (§3) is the _pull_ complement: the agent can ask "were my edits
accepted?" mid-work and get the structured per-turn keep/revert state back from the backend.

---

## 5. Interplay with git

change-review is **not** a git tool and must work in a repo _or_ a bare folder. But git, when
present, makes the baseline and the revert dramatically safer, so treat it as an optional
accelerator, not a dependency.

- **Baseline source.** change-review's "before" for a session is the file content _as the agent
  first saw it this session_, captured on first-touch (§4.1). This is deliberately **not** git
  HEAD: the user may have had uncommitted work in the tree before the agent started, and a
  hunk-revert must restore _that_ pre-agent state, not blow away the user's own dirty edits.
- **Revert vs. `git checkout`.** A hunk revert is a **surgical reverse-apply of one hunk**
  (§4.2), never `git checkout -- <file>` (which would discard the whole file including the
  user's own unrelated changes and other kept hunks). change-review deliberately does _not_
  shell out to git for reverts — it writes the computed text via the cwd-bounded `writeFile`
  path **[contract]**. This keeps behavior identical in a non-git folder.
- **Dirty-tree behavior.** In a dirty tree the plugin still works: baselines are per-file
  first-touch snapshots, so the user's pre-existing uncommitted edits are simply part of the
  baseline and are never touched by a revert of an agent hunk. change-review shows a small
  "uncommitted before agent" note on a file whose baseline differed from HEAD (git present), so
  the user knows a hunk sits on top of their own unsaved work.
- **Optional git enrichment [extrapolation].** If a backend git call is available (see HOST-GAP),
  the pane can badge each file with its `git status` (tracked/untracked/ignored) and offer
  "stage kept hunks" — but this is a nice-to-have that overlaps `git-workbench`'s remit and
  should defer to it rather than duplicate a full staging UI.

---

## 6. HOST-GAP — capabilities that do not exist yet

Honest accounting. change-review's _core_ (observe edits via `agent:read`, revert via
`data:write`, steer via a `readonly` context export) is fully expressible on today's contract.
These gaps affect completeness / polish and must be built or worked around:

1. **HOST-GAP — plugin access to conversation history / transcript on mount.** `agent.onEvent`
   only forwards events to a pane _mounted when they fire_ **[contract]**; there is **no**
   plugin-facing API to read the prior `AgentEvent`/`tool_use` history of the conversation (the
   `agent.transcript` IPC exists but is renderer→main only, not on the injected plugin `atelier`
   surface — see `AtelierAPI.plugins` in `events.ts`, which has no `agent` sub-object). **Impact:**
   a pane enabled/opened mid-session, or after a restart, cannot reconstruct the turns it missed;
   it only sees edits from mount-time forward. **Options:** (a) add a plugin `agent.history()` /
   `agent.transcript()` host method gated by `agent:read` [preferred]; or (b) persist observed
   edits incrementally to `storage` so a _reload_ (not a fresh enable) restores — but a plugin
   enabled after the agent already edited still has a blind spot. **Recommendation:** build (a);
   until then, document that change-review is authoritative only for edits made while it was
   enabled+mounted.

2. **HOST-GAP — first-class per-edit file-write observation.** The plugin infers edits from
   `tool_use` events keyed on tool `name` (`Write`/`Edit`/`MultiEdit`) and their `input` shapes.
   There is **no** normalized "a file at PATH changed from X to Y" host event — the plugin
   re-derives it from tool-specific input schemas that can drift with the SDK. **Impact:** a new
   or renamed edit tool (or a plugin-contributed tool that writes files, or a `Bash` `sed`) is
   invisible to change-review. **Option:** a host-emitted normalized `file_edit` observation
   (path, before-hash, after-text/patch) derived in main from PostToolUse hooks — the same place
   the Bash tap already hooks tool responses (`electron/agent/bashTap.ts`, wired into
   Pre/PostToolUse) **[contract that the hook point exists]**. **Recommendation:** add a
   `file:edits` DataBus channel analogous to `BASH_STREAM_CHANNEL`, published from a PostToolUse
   hook, carrying `{ toolUseId, path, before?, after }`. This makes observation robust and
   subscribable via plain `data:subscribe`.

3. **HOST-GAP — "pause the agent" from a plugin.** The budget banner's _Pause agent_ button has
   no plugin-facing lever: the injected `atelier.agent` surface has `info`/`onEvent`/`send`
   only — no `interrupt` **[contract: runtime.ts]** (the `agentInterrupt` IPC is renderer→main,
   not exposed to plugins). **Impact:** the banner can warn but not stop. **Option:** expose
   `agent.interrupt()` gated behind a new permission (e.g. `agent:control`), or route it through
   the `plugin_control` design in PLUGIN_ARCHITECTURE.md §3. **Recommendation:** ship the banner
   as advisory-only in v1; add pause when an interrupt lever lands.

4. **HOST-GAP — reliable pre-edit baseline for `Write`.** For a full-file `Write`, the true
   "before" is the on-disk content _immediately before_ the write. The plugin can read current
   content via a `file:` subscription, but there is a race: by the time the pane processes the
   `tool_use`, the write may already be on disk. A host `file_edit` event carrying the _before_
   snapshot (gap 2) closes this cleanly. Until then the plugin uses HEAD (git) or its last-known
   snapshot as an approximation and flags low-confidence hunks.

---

## 7. Implementation milestones (ordered)

Each milestone builds, launches, and meets a checkable slice — same discipline as the ROADMAP
phases.

1. **M1 — Observe + accumulate (read-only).** Subscribe to `agent.onEvent`; pair
   `tool_use`/`tool_result` by `toolUseId`; group edits into turns on `result`. Render turn
   groups + file cards + `+/−` counts. No hunks, no revert yet. _Check:_ run an agent turn that
   edits 2 files → both appear grouped under one turn with correct counts.
2. **M2 — Hunk view + diff rendering.** Compute hunks from `Edit`/`MultiEdit` inputs and from
   `Write` (baseline vs. new). Render syntax-highlighted per-hunk diffs (Shiki). Persist
   reviewed/kept state per hunk id in `storage`. _Check:_ remount the pane → hunk states restore.
3. **M3 — Revert.** Reverse-apply a single hunk; write via `atelier.data.writeFile` with
   re-anchor safety (§4.2); mark reverted; "revert all in turn". _Check:_ revert one hunk of a
   two-hunk file → only that hunk's change is undone on disk, the other survives.
4. **M4 — Steering feedback.** `rejections` `readonly` context export; append reason on revert
   via `context.set`; confirm host injects it each turn. _Check:_ revert with a reason → next
   agent turn's context contains the `<atelier-context>` rejections block (verify via the
   context-injection path in CONTEXT_SYSTEM.md).
5. **M5 — Budget banner.** Live per-turn file/line totals; amber banner over threshold; settings
   popover persisted to `storage`. _Check:_ a turn editing >N files raises the banner mid-turn.
6. **M6 — `review_status` backend tool.** Child-process backend returns the structured review
   state. _Check:_ agent calls `review_status` and receives per-turn keep/revert counts.
7. **M7 (host-gapped) — history reconstruction + robust observation.** Consume the new
   `file:edits` channel / `agent.history()` once built (§6 gaps 1–2). _Check:_ enable the plugin
   _after_ the agent already edited → prior edits appear.

---

## 8. Risks / edge cases

- **Agent edits during review.** The agent may edit a file the user is mid-reverting. Guarded by
  the re-anchor check (§4.2): a revert whose hunk context no longer matches current disk is
  refused with "the file changed — re-review". Live `file:` tailing keeps the pane's view current
  so the user sees the new edit appear.
- **Overlapping / adjacent hunks.** Reverting hunk A shifts line numbers for hunk B in the same
  file. The plugin must reverse-apply against **text**, not fixed line numbers, and recompute
  remaining hunks after each revert (treat the file as the source of truth, re-diff, re-render).
  Never batch multiple reverts by precomputed line ranges.
- **Binary files.** `atelier.data.writeFile` is **UTF-8 text only** **[contract: `fileWrite.ts`]**,
  so a binary edit cannot be hunk-diffed or reverted through this path. change-review shows a
  binary edit as a non-revertable summary row ("binary changed — revert unsupported"); it never
  attempts to render or reverse-apply binary content.
- **Renames / moves.** A rename (agent moves `a.ts`→`b.ts`) surfaces as a delete + create in tool
  events, or a Bash `git mv`. change-review pairs same-content delete+create into a single
  "renamed" row where detectable **[extrapolation]**; reverting a rename is a whole-unit
  operation (recreate old path, remove new), gated behind a confirmation because it's not a hunk.
  Undetected renames degrade gracefully to a delete card + a create card.
- **Large turns / huge files.** A 5MB write hits the `writeFile` cap **[contract]**; the pane
  surfaces the `{ error }` and marks the hunk non-revertable. Very large diffs are virtualized /
  collapsed by default to keep the pane responsive.
- **Edits outside the cwd.** An agent edit to an absolute path outside the conversation cwd is
  refused by the host writer (`resolvePath` → null → `{ error }`) **[contract]**, so such a hunk
  is observable but non-revertable; the pane says so.
- **`rejections` doc unbounded growth.** Capped by `maxTokens` **[contract]**; the pane trims to
  recent-K and offers "clear resolved" so a long session doesn't silently truncate the newest
  (most relevant) rejections off the tail.
- **Non-`ok` tool results.** A denied or failed edit never reached disk; the plugin must ignore
  any `tool_use` whose paired `tool_result` is `ok:false` (§4.1) or it will show phantom hunks.
- **Bash-driven edits (`sed`, `>` redirects, codegen).** Invisible to `tool_use`-name matching
  (HOST-GAP 2). Documented limitation until the normalized `file:edits` channel exists.

---

## 9. Acceptance criteria

change-review is done (v1) when:

1. After an agent turn edits multiple files, the pane shows one turn group with a file card per
   path, correct `+/−` line counts, and syntax-highlighted per-hunk diffs. **[M1–M2]**
2. Keeping/reverting hunks persists across pane remount, conversation switch, and app restart —
   the pane fully rebuilds review state from `storage` on mount **[contract: §8]**. **[M2–M3]**
3. Reverting a hunk writes the file back **atomically and cwd-bounded**, undoes only that hunk,
   preserves other hunks and the user's pre-existing uncommitted edits, and refuses cleanly if
   the region changed since the edit. **[M3]**
4. A revert reason is appended to the `rejections` `readonly` context export and is present,
   framed, in the agent's context on the next turn (and stripped from the visible transcript).
   The agent has **no** write-tool for it. **[M4]**
5. A turn exceeding the configured file/line budget raises the budget banner while the turn is in
   flight; the threshold is user-configurable and persisted. **[M5]**
6. The agent can call `review_status` and receive the structured per-turn keep/revert state.
   **[M6]**
7. Binary files, renames, out-of-cwd paths, and failed edits are handled per §8 (shown, not
   crashed; non-revertable where noted) — a malformed edit never throws into the host or the
   pane **[contract: fault-containment invariant]**.
8. Every HOST-GAP in §6 is either resolved or explicitly documented as a known limitation in the
   plugin's own description/README, so the user knows change-review is authoritative only for
   edits observed while enabled+mounted (until gap 1 lands).

```

The doc grounds each claim in the contracts and shared schemas, and flags the four host gaps honestly.
```
