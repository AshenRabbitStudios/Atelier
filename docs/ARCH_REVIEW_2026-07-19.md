# Architecture Deep-Dive Review — 2026-07-19

Reviewer: Claude (autonomous overnight review, no changes made).
Scope: full main process (`electron/`), renderer shell (`src/`), plugin contract + example
plugins, docs. Gate at time of review: **typecheck ✓, lint ✓, 153/153 tests ✓** on
`feat/browser-embed` (680a999).

## Verdict

The architecture is fundamentally sound and faithful to SPEC/CLAUDE.md: the SDK lives only in
main; every IPC payload is Zod-parsed on the receiving side; plugins reach the app only through
the mediated `postMessage` → IPC path; backends run as isolated `utilityProcess` children with
timeouts; the TurnLedger/deriveStatus design is genuinely good (single-writer facts, derived
status, bounded self-healing). Docs discipline (DECISIONS/PROGRESS/design docs) is excellent.

**Framing (corrected 2026-07-19 after user ruling — see DECISIONS.md):** the plugin sandbox is
**fault containment + a clean coupling contract**, not a security boundary. Plugins are
user/agent-authored and trusted; the sandbox exists so (1) the agent can author and hot-load
plugins at runtime without a broken one taking the app down, (2) a plugin is a standalone app
authorable from the contract alone, and (3) plugins never cross-contaminate each other or the
app. The **only genuinely hostile input is remote web content** — the `browser:embed` guest
surface and `url:` fetches. Findings below are graded against that model: webview hardening and
data-integrity issues stay P0; "permission enforcement" items are contract-robustness, not
security.

Findings are ordered by severity. "Fix" lines are proposals only.

---

## P0 — should fix before the plugin surface grows further

### 1. The coupling contract is enforced only in the renderer

_(Downgraded from "security gap" to "contract robustness" under the corrected framing — kept in
P0 because it is also the cross-contamination guard.)_

`PluginPane.tsx:203-385` is the **only** place plugin permissions (`storage`, `context`,
`data:subscribe`, `net:fetch`, `data:publish`, `browser:embed`) are checked. The main-process
IPC handlers (`main.ts:522-566` — `pluginStorageGet/Set`, `pluginContextGet/Set`,
`pluginDataSubscribe/Publish`, `pluginReadAsset`) accept any `(conversationId, pluginId)` and
perform the action without consulting the registry's manifest or the conversation's enablement
state.

This is not an adversary problem — plugins are trusted. It matters because:

- Permissions exist to keep an **agent-authored plugin from accidentally overreaching** its
  declared coupling surface; if only the renderer relay enforces them, a bug in that ~180-line
  if-chain silently voids the declared contract.
- The known coupling signature is the thing that makes plugins composable and
  cross-contamination-free (intent #3); main is the natural owner of that signature, and today
  it doesn't check it at all — e.g. any pane could write another plugin's storage by relay bug.
- Invariant #4 ("every boundary payload is Zod-validated at the receiving side") is honored for
  _shape_ but not for the contract's _authority_ at the renderer→main boundary.

**Fix:** in each plugin IPC handler in main, resolve `plugins.get(pluginId)` and reject when the
plugin is invalid, not enabled for that conversation, or lacks the declared permission (incl.
`net:fetch` for `url:` channels, which today is renderer-only — `PluginPane.tsx:282` vs.
nothing in `main.ts:548`). The registry and `agents.pluginStateFor()` are already available in
`registerIpc`; ~30 lines, and the renderer check becomes a fast-fail UX nicety instead of the
contract's only enforcement point.

### 2. Webview guest navigation is unguarded after attach

`main.ts:236-253` (`installWebviewGuard`) hardens the _attach_ (no preload, no node, sandbox,
http(s)-only initial `src`) and converts popups to in-place navigations. But nothing constrains
where the guest navigates **after** attach: page JS (`location.href = 'file:///...'`), meta
refresh, or a server redirect can take the guest to `file://` or any other scheme. The guest
stays sandboxed/node-free, so this is not RCE — but it can display local files inside the pane
and enlarges the attack surface for free.

**Fix:** in `did-attach-webview`, also hook `guest.on('will-navigate')` (and
`will-redirect`) and `event.preventDefault()` anything that isn't http(s).

### 3. Browser webview can visually escape its pane

`.plugin-pane-wrap` (`styles.css:542`) is `position: relative` but has **no `overflow:
hidden`**, and `browser.setBounds` (`PluginPane.tsx:334-343`) only clamps values to ≥ 0 with no
upper bound. A plugin (or a confused agent driving one) can set `w/h` of 10000 and composite a
live remote page over the entire app window — chat, approval cards, everything. That is a
spoofing primitive: a remote page could paint a fake "Allow" permission card.

**Fix:** `overflow: hidden` on `.plugin-pane-wrap` (one line), and optionally clamp bounds to
the wrap's client rect.

### 4. `PluginPane` effect churn silently kills DataBus subscriptions and the browser surface

`PluginPane.tsx:401` — the single big `useEffect` depends on
`[pluginId, permissions, getConversationId, onDock, onSetTitle]`. All but `pluginId` are
**fresh identities on every render** of the panel body (`App.tsx:80-93` builds a new
`permissions` array and three new closures each time). Whenever Dockview re-renders the panel
tree (parent re-renders propagate; `App` re-renders every 10 s from the usage poll), the effect
re-runs:

- cleanup **unsubscribes every DataBus channel** the pane held (`PluginPane.tsx:394-396`) — and
  the new effect run _cannot_ resubscribe, because only the plugin's iframe runtime knows its
  channels and it is never told. bash-stream / living-doc go permanently silent until the pane
  is manually remounted;
- cleanup **destroys the webview** (`webview?.remove()`) — the browser surface resets
  (navigation history, session state in-flight loads).

Even if Dockview's memoization happens to shield this today, the design is one memo-break away
from breakage, and the asymmetry (teardown drops state the setup can't restore) is a bug
regardless of trigger frequency.

**Fix:** (a) key the effect on `pluginId` alone and read the other props through refs; (b) make
the teardown/re-setup symmetric — either notify the frame (`reload` event) when the host relay
restarts, or keep the subscription map outside the effect so re-runs don't drop it.

### 5. Non-atomic plugin-storage writes can destroy all context documents

`pluginStorage.ts:43-53` writes `storage.json` in place with `writeFileSync`; `load()` returns
`{}` on _any_ parse failure. A crash/power-cut mid-write corrupts the file and silently erases
every context document for that (conversation, plugin) — the cognition mental model, the
cartographer map, plans, standing instructions. This is the app's most valuable per-conversation
state, and the failure mode is silent total loss. (`conversationStore.ts` `saveState`/
`saveConversation` have the same pattern; lower stakes but same fix.)

**Fix:** write-to-temp + `renameSync` (atomic on the same volume), and consider keeping one
`.bak` generation. ~10 lines, testable.

---

## P1 — real issues, not urgent

### 6. Per-turn context injection is permanently baked into session history

`maybeRelease` (`AgentManager.ts:1068-1069`) prepends the full `<atelier-context>` block to the
user message, which the SDK persists into the session JSONL. `stripInjectedContext`
(`sessionStore.ts:91-93`) hides it from the _displayed_ transcript, but every turn's full
snapshot of every pinned export remains in the **model-visible history for the life of the
session** (and of every fork). With cognition + cartographer pinned (~10k tokens of exports), a
50-turn conversation carries hundreds of thousands of stale-context tokens in history — paid on
every cache-miss and pushing the context window toward compaction. The design doc's cache
argument holds per-turn, but the cumulative cost is unbounded.

**Fix (design change, worth a DECISIONS entry either way):** none is free, but options include
injecting context as an ephemeral system-role attachment if the SDK grows one, trimming the
block to a delta ("changed since last turn"), or accepting it and documenting "clear chat often"
as the intended mitigation (which the cognition plugin already preaches — but the app should
own the invariant, not the user's habits).

### 7. Backend path and plugin-id containment gaps

- `manifest.backend` is any non-empty string; `pluginTools.ts:77` does `join(dir,
manifest.backend)` with no check, so `"backend": "../../outside.js"` runs code from outside
  the plugin folder. Today all plugins are user-installed so this changes little, but the
  deferred F4b (agent-authored plugins) makes folder containment the _only_ meaningful boundary.
  **Fix:** resolve and require the result stays under `dir` (same guard as `protocol.ts:61-66`).
- `resolveWithinCwd` (`main.ts:176-183`) and the protocol guard don't resolve **symlinks**; a
  link inside the cwd pointing outside escapes the scope. Low risk locally; `realpathSync`
  before the prefix check closes it.

### 8. Renderer window: `sandbox: false` + no CSP + `webviewTag: true`

Individually documented and reasonable (`DECISIONS.md` 2026-06-27: ESM preload needs
`sandbox: false`; `index.html` has a TODO for CSP). Under the corrected framing this matters
only insofar as it faces the one hostile input: the process compositing remote-JS webviews is
itself unsandboxed with no CSP. **Fix:** do the CSP TODO (it also mitigates #3-style spoofing
by constraining what the renderer itself can load); bundling the preload to CJS to restore
`sandbox: true` is optional hardening, not urgent.

### 9. `TurnLedger.clear()`'s contract is not honored by its callers

The docstring promises "returns what was dropped so callers can report it instead of losing
messages silently" (`turnLedger.ts:80-88`) — but all three call sites (`interrupt`,
`rate_limit_event`, `clearChat` in AgentManager) discard the return value. On a rate-limit
rejection, queued user messages evaporate with only a generic error event. **Fix:** surface the
dropped turns in the error message (or re-queue them for auto-resume — they're right there).

### 10. `decide()`/`answer()` never emit `permission_resolved`/`question_resolved`

`AgentManager.ts:751-775` resolves the pending promise but doesn't emit the resolved event (the
abort path does, lines 735-739). The acting panel clears its card locally and `uiState()` resync
heals other views eventually, but the push contract is asymmetric for no stated reason. One
`this.emit(...)` per method makes push and pull agree.

### 11. `pluginsReload` for one plugin nukes every plugin's backend

`main.ts:515-520`: the payload's `pluginId` is parsed and then ignored — `backends.stopAll()` +
full rescan. Reloading a UI-only plugin kills unrelated tool backends mid-call (pending invokes
reject). **Fix:** `backends.stop(pluginId)` for the named plugin; keep `stopAll` for the
registry-wide rescan path only.

### 12. Backend children have no crash-loop or resource bounds

`PluginBackendManager` respawns lazily per invoke with no restart budget (contrast: `Session`
caps restarts at 3), and `utilityProcess.fork` is called without `resourceLimits`
(`main.ts:122-136`). A crash-looping or memory-hungry backend can't take main down, but it can
burn CPU/RAM indefinitely while every tool call eats a 30 s timeout. **Fix:** small restart
budget per plugin (reset on success) + `resourceLimits` on the fork.

### 13. Session-file search and transcript parse costs grow with history

- `sessionFilePath` (`sessionStore.ts:10-43`) recursively scans all of `~/.claude/projects` per
  _miss_, and misses are re-scanned on every `transcript()` call (cache is hit-only).
- `readTranscript` re-reads and re-parses the entire JSONL on every turn result
  (`conversationViewStore.ts:80-83` schedules it 150 ms after each result), and the renderer
  then rebuilds the full message array. Fine at 100 messages; noticeable at 5,000.

**Fix (when it hurts):** cache misses with a short TTL; incremental JSONL tail-parse keyed on
file size/mtime.

---

## P2 — hygiene, drift risks, and nits

14. **`AgentManager.ts` is 1,740 lines** with a ~1,200-line `Session` class mixing queueing,
    SDK pump, branch/fork bookkeeping, permission brokering, usage polling, watchdogs, bash
    hooks, and background-task tracking. `ChatPanel.tsx` (920) and `App.tsx` (725) are similar.
    All are internally well-commented, but they contradict the repo's own "small, typed modules"
    standard and are the files a future regression will hide in. Natural seams already exist
    (branches/forks; the permission broker; the hooks builders; App's ConversationBar).
15. **Hardcoded model tables** in two places: `ADAPTIVE_THINKING_MODELS`
    (`AgentManager.ts:128-135`) and `KNOWN_MODELS` (`events.ts:31-46`). Known drift risk —
    worth a single module with one comment pointing at the claude-api reference, so the next
    model release is a one-file change.
16. **Plugin runtime doesn't verify message sender**: `runtime.ts:24` accepts any `message`
    event without checking `e.source === window.parent`. No same-document attacker exists
    today; it's a one-line hardening consistent with the host side's `e.source` check.
17. **`DataBus.publish` has no channel-namespace ownership**: a `data:publish` plugin can
    publish onto `file:*`/`bash-stream` channels and poison the last-value cache other panes
    replay. Scoped to one conversation, so impact is self-inflicted UI confusion — but cheap to
    reserve source-owned prefixes for sources.
18. **`ensureNodeOnPath` shadows the imported `sep`** (`main.ts:65` vs. the `node:path` import
    used at line 181) — works, but is exactly the kind of trap the file doesn't need.
19. **`setModel` lacks the dead-query fallback `setPermissionMode` has**
    (`AgentManager.ts:838-842` vs. 777-788): on a dead query it just rejects; a `catch {
this.rebind() }` would make the two consistent.
20. **`capValue` double-budget**: guide and value are each capped at the _same_ per-export
    budget (`contextTools.ts:129-139`), so a section can cost ~2× its declared `maxTokens`.
21. **Main→renderer events are typed but never runtime-validated** (`preload.ts:55-61`) —
    acceptable for a trusted direction, but it's the one boundary where "every payload is
    Zod-validated at the receiving side" is not literally true; worth a line in ENGINEERING.md
    acknowledging the asymmetry so it reads as a decision, not an oversight.
22. **`clearChat` → `send` race**: a message sent in the same tick as clear-chat's deferred
    `setImmediate` rebind (`AgentManager.ts:618-621`) is settled away silently. Obscure; a
    guard flag ("rebind pending — queue, don't release") closes it.

## What's notably good (keep doing this)

- **Status lockstep** (TurnLedger + derived status + seq-gated resync + watchdog) is a textbook
  cure for the class of "the spinner lies" bugs, and it's fully unit-tested.
- **The context-document system** (`set_`/`edit_` pairs, push-only vs. read-only exports,
  author guides in separate storage keys the agent can't overwrite) is a thoughtful, coherent
  contract — the `edit_` literal find-and-replace with occurrence counting is exactly right.
- **Billing safety** (stripping `ANTHROPIC_API_KEY`, surfacing key source) shows the right
  instincts about user-hostile failure modes.
- **DECISIONS.md/PROGRESS.md** are genuinely useful — several of this review's questions were
  answered by them (webview trust model, sandbox:false rationale, F4b deferral). The F4b
  writeup in PROGRESS is the right way to defer a scope decision.

## Suggested order of attack

1. #3 (`overflow: hidden`) and #2 (`will-navigate` guard) — minutes each, and they close the
   only genuinely hostile-input gaps (remote web content) the new browser feature opened.
2. #5 (atomic storage writes) — protects the highest-value state against silent loss.
3. #4 (PluginPane effect stability) — fault-containment correctness; fix before more plugins
   depend on DataBus subscriptions.
4. #1 (main-side contract enforcement) — makes the coupling signature enforceable where it
   lives, so agent-authored plugins can't accidentally overreach via a relay bug.
5. #6 (context-in-history cost) — needs a design decision from you, not just code.
