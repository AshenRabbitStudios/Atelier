# `attention` — design doc

Status: **design / proposal** (not built). Proposal source: `docs/plugin-proposals/PROPOSALS.md`
§13 (T1 default slot). Normative contracts referenced: `PLUGIN_API.md`,
`docs/PLUGIN_ARCHITECTURE.md`, `docs/CONTEXT_SYSTEM.md`, and the agent-event union in
`electron/shared/events.ts`.

> **The honest headline.** The single most valuable behaviour this plugin promises —
> "get tapped on the shoulder when _any_ conversation finishes or blocks" — cannot be built
> on today's plugin contract. Plugins are strictly **per-conversation** (see §4), and a
> sandboxed pane has **no OS-notification / taskbar-flash reach** (also §4). Every one of
> those is flagged under **HOST-GAP** with a precise proposed API. A same-conversation-only
> subset is buildable today and is called out as the **v0 fallback**. Anything asserting
> behaviour beyond what the current code supports is marked _(extrapolation)_.

---

## 1. Purpose + user stories

**Purpose.** Convert the multi-conversation / background-run workflow from "check
compulsively" to "get tapped on the shoulder." A near-invisible status strip plus OS-level
notifications for four event classes — **turn finished**, **blocked on a permission prompt**,
**error**, and **long-silence watchdog** — with per-event toggles, quiet hours, optional
sound, taskbar flash/badge when Atelier is unfocused, and an **attention log** of missed
events that you can click to jump back to the originating conversation.

### User stories

- **US-1 (multi-conversation).** I have five conversations open across three repos. Two are
  churning on long refactors. I want a desktop notification the moment either finishes _or_
  stops to ask for a permission, naming _which_ conversation — without me tabbing through all
  five. Clicking the notification focuses Atelier and switches to that conversation.
- **US-2 (background run, app unfocused).** I kicked off a big build-and-test loop and
  switched to my browser. Atelier is not the foreground window. When the run finishes (or errors),
  Atelier's taskbar button flashes and shows a badge count; the attention log accumulates what I
  missed while away.
- **US-3 (blocked-and-idle).** An agent hit a permission prompt 4 minutes ago and is silently
  waiting. The long-silence watchdog fires ("Conversation 'api-refactor' has been waiting on you
  for 4m"), so a stalled run never sits unnoticed.
- **US-4 (quiet hours / focus).** It's late, or I'm actively typing in the conversation that
  just finished. I don't want a sound or a popup for the pane I'm already looking at. Quiet
  hours suppress sound+popup (still logged); focus detection suppresses notifications for the
  _currently-active, focused_ conversation (§5).
- **US-5 (triage after being away).** I come back after lunch. The attention log shows, newest
  first, every finish/block/error I missed, each with a timestamp and conversation name; one
  click jumps me there. Read items collapse; the rail badge clears.

---

## 2. UX

### 2.1 The status strip (pane)

A deliberately slim, low-chrome pane (proposal: "near-invisible"). Default dock **`bottom`**
(a one-line strip reads well full-width). Contents, left→right:

- **Global state dot** — aggregate of all watched conversations: green (all idle), amber
  (one or more blocked/waiting), blue (one or more working), red (an error is unacknowledged).
- **Live counts** — e.g. `3 working · 1 blocked · 0 errors`.
- **Last event** — "`api-refactor` finished · 12s ago", click → jump (§6).
- **Unread badge** — count of unacknowledged log entries; click opens the log.
- **Mute-for toggles** — a quick "mute 30m / mute until I return" chip (temporary global
  suppression without editing settings).

The strip must fully rebuild from `storage` on mount (`PLUGIN_API.md` §8 restore contract):
its only durable state is the log + settings, both in `storage`.

### 2.2 The attention log

Opened from the strip (or as an expanded mode of the same pane). A reverse-chronological
list; each row:

```
● [icon]  api-refactor        blocked on permission (Write src/db.ts)   4m ago   [jump]
○ [icon]  docs-site           turn finished                            22m ago  [jump]
○ [icon]  scraper             error: fetch timed out                   1h ago   [jump]
```

- `●` unread / `○` read. Clicking a row (or its `[jump]`) triggers the jump-to-conversation
  flow (§6) and marks it read.
- Filter chips per event class; "clear all / mark all read."
- Bounded ring (e.g. last 200 entries) persisted in `storage` so it survives restart.

### 2.3 Settings (in-pane `<details>` panel)

- **Per-event toggles**: turn-finished, blocked-on-permission (also fires on the agent's
  `AskUserQuestion`), error, long-silence watchdog — each independently on/off, and each with
  its own **notify / sound / flash** sub-toggles.
- **Long-silence watchdog**: enable + threshold (default 120s of no SDK activity while a run is
  in flight or a prompt is pending).
- **Quiet hours**: start/end time; during quiet hours, suppress popup+sound+flash but still log.
- **Optional sound**: on/off + a small built-in set (bundled as plugin assets — the pane can
  `fetch()` its own folder, `PLUGIN_API.md` §1). Sound plays **in the pane** (an `<audio>`
  element) — no host verb needed for audio, unlike OS notifications.
- **Focus suppression**: "don't notify me about the conversation I'm currently looking at"
  (default on).
- **Scope**: "watch all conversations" vs "watch only this one" — the former depends on the
  HOST-GAP in §4.2; when that gap is unfilled the toggle is disabled with an explanatory note.

Settings live under a `settings` key in `storage`; the standing usage guide pattern
(`CONTEXT_SYSTEM.md`) is not needed here since this plugin declares no context exports.

---

## 3. Manifest sketch (matches the real schema)

Validated against `PLUGIN_API.md` §1 (manifest fields), the `permissions` list in §4, and the
`contextExports` extension in `PLUGIN_ARCHITECTURE.md` §2. This plugin declares **no**
`contextExports` and **no** `tools` — it is a pure observer pane. `permissions` here reflect
what is grantable **today**; the capabilities it actually needs but cannot yet declare are in §4.

```json
{
  "id": "attention",
  "name": "Attention",
  "version": "0.1.0",
  "description": "Taps you on the shoulder: OS notifications + a slim status strip for turn-finished, permission-blocked, error, and long-silence events across your conversations. Per-event toggles, quiet hours, optional sound, taskbar flash when unfocused, and a click-to-jump log of what you missed.",
  "icon": "M8 1.8c-2 0-3.4 1.5-3.4 3.6 0 3-1.2 4-1.9 4.8h10.6c-0.7-0.8-1.9-1.8-1.9-4.8 0-2.1-1.4-3.6-3.4-3.6M6.6 12.4a1.4 1.4 0 0 0 2.8 0",
  "kind": "panel",
  "entry": "index.html",
  "permissions": ["agent:read", "storage"],
  "defaultDock": "bottom"
}
```

Notes:

- `"kind": "panel"` — no backend, no contributed tools (nothing privileged to run out-of-process).
- `permissions`: `agent:read` (observe agent events for _this_ conversation via `agent.onEvent`,
  `PLUGIN_API.md` §3) and `storage` (the log + settings). Both exist in the schema today.
- `icon` is a single-path 16px bell glyph (`viewBox 0 0 16 16`, stroke `currentColor`), per
  `PLUGIN_API.md` §1 / DESIGN_SYSTEM.md §6. _(icon path is illustrative; verify it renders
  distinctly against sibling plugins before shipping.)_
- **Two permissions in this manifest do not yet exist** and are proposed in §4:
  `agent:read-all` (or an equivalent cross-conversation event feed) and `os:notify`. They are
  intentionally **omitted** from the JSON above because the Zod manifest validator would reject
  unknown permission strings — adding them is part of the host work, not this doc's fiction.

---

## 4. Architecture: events, cross-conversation reach, and OS surfaces

### 4.1 Which agent events already exist

From `electron/shared/events.ts`, the normalized `AgentEvent` union (emitted per instance,
main → renderer) already carries everything the four event classes need:

| attention event       | driven by `AgentEvent` kind(s)                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| turn finished         | `result` (`isError:false`) and/or `status` transition → `idle`                                                          |
| blocked on permission | `permission_request` (also `question_request` for `AskUserQuestion`)                                                    |
| error                 | `error`, and `result` with `isError:true`, and `status` → `error`                                                       |
| long-silence watchdog | derived: no events for N seconds while `status` is `working` OR a `permission_request`/`question_request` is unresolved |

Supporting facts also present: `status` events are **`seq`-versioned** (monotonic; ignore stale
payloads), `permission_resolved` / `question_resolved` tell us when a block clears, and the
`UiStateSnapshot` (fetched via `agent.info`-adjacent `uiState`, main is source of truth) exposes
`status`, `pending`, `questions`, `turnStartedAt`, and `facts.lastSdkEventAt` — the last of which
is the ideal anchor for the watchdog (extrapolation: the pane would need this exposed to it; see
§4.2 gap). The strip subscribes with `atelier.agent.onEvent(cb)` (`PLUGIN_API.md` §3).

### 4.2 The cross-conversation problem — being honest

**The contract is explicitly per-conversation.** `PLUGIN_API.md` §3 says the `agent` API is
"Scoped to the conversation the pane is mounted in — no cross-conversation reach ... `onEvent`
forwards **only this conversation's events**." `PLUGIN_ARCHITECTURE.md` reinforces that storage,
data, and enablement are all `(conversation, plugin)`-scoped, and enabling a plugin **mounts one
sandbox into the active conversation**. So:

- A single mounted `attention` pane sees **only its own conversation's** events. It cannot today
  learn that a _different_ conversation finished or blocked.
- Even the DataBus (`data.subscribe`) is conversation-scoped — publishing on `bash:stdout` in
  conversation A does not reach a subscriber in conversation B (`events.ts` DataBus channels carry
  a `conversationId` and the relay routes to the matching mounted pane only).
- Enablement is per-conversation, so "watch all conversations" would, absent a host change,
  require the plugin to be enabled+mounted in _every_ conversation, and even then each instance is
  blind to the others.

**Conclusion:** the flagship multi-conversation behaviour (US-1, US-2, US-3, US-5) is **not
possible on the current contract.** It needs a host-provided global event feed. This is the
central HOST-GAP.

#### HOST-GAP A — cross-conversation agent-event feed

The main process already has every conversation's `AgentEvent` stream and `UiStateSnapshot`
(`AgentManager` is the source of truth — `events.ts`). What's missing is a **permissioned,
sandbox-facing broadcast** of those events tagged by conversation.

Proposed host API (new permission `agent:read-all`, a strict superset of `agent:read`, shown in
the rail as a broad capability):

```ts
// on window.atelier.agent — gated by "agent:read-all"
agent.onAnyEvent(cb: (e: AgentEvent & { conversationId: string }) => void): () => void
// AgentEvent already carries instanceId; conversationId is added so the plugin can label + jump.
agent.listConversations(): Promise<ConversationSummary[]>  // id, title, cwd, updatedAt, open
agent.uiStateOf(conversationId: string): Promise<UiStateSnapshot>  // for watchdog anchoring
```

- Main-side implementation: a fan-out subscription over all live `AgentManager` instances,
  Zod-validated at the boundary like every other push (the payload is the existing `AgentEvent`
  plus `conversationId`; `ConversationSummary` and `UiStateSnapshot` already exist in `events.ts`).
- New IPC channels (mirroring the existing `agentEvent` push): e.g. `agent:any-event`,
  `agent:list-all` (already present! `IPC.agentListAll` → `plugins`/`agent.listAll`), and a
  per-conversation `uiState` fetch (`IPC.agentUiState` already present, but currently keyed to the
  pane's own instance — needs to accept an explicit id under the new permission).
- Permission model: `agent:read-all` is a genuinely broad grant (it exposes _every_ conversation's
  activity to one pane). It is a **capability declaration** per §4's framing, not a security wall,
  but it should be shown prominently in the rail so the user/agent knows this plugin sees
  everything. Recommend it be grantable only to a plugin that declares it up front.

**Design decision:** the strip should be usable with just `agent:read` (v0 fallback: watches only
the conversation it's mounted in — still useful for the single-long-run case, US-3 for one
conversation). It "lights up" to full multi-conversation mode when `agent:read-all` is present.
This keeps the plugin shippable before Host-Gap A lands.

### 4.3 OS notifications, taskbar flash, badge — from a sandbox

A sandboxed pane runs at `atelier-plugin://<id>` with `contextIsolation:true` /
`nodeIntegration:false`. The browser `Notification` API is technically present in a renderer, but:

- It cannot reliably request/hold notification permission inside a custom-scheme sandboxed frame,
  it cannot control the **app** taskbar button (flash/badge/overlay icon — those are `BrowserWindow`
  / `app` operations that only main can perform), and clicking a browser `Notification` gives the
  pane focus, not the ability to **focus the Atelier window and switch conversation**.
- Per invariant §2 / `PLUGIN_API.md` §3 "Not exposed", privileged OS work must go through the host,
  not be reached directly from the sandbox.

So the pane must **not** raise notifications itself. It asks the host.

#### HOST-GAP B — an `os` notification/attention verb

Proposed host API (new permission `os:notify`):

```ts
// on window.atelier.os — gated by "os:notify"
os: {
  // Raise a native desktop notification. Returns an id so the plugin can correlate a click.
  notify(n: {
    title: string
    body: string
    sound?: boolean            // host maps to Electron Notification `silent:false`
    conversationId?: string    // if set, a click routes through the jump flow (§6)
    tag?: string               // coalesce/replace an earlier notification with the same tag
  }): Promise<{ id: string }>
  // Fired when the user clicks a notification this plugin raised.
  onNotificationClick(cb: (e: { id: string; conversationId?: string }) => void): () => void
  // Taskbar attention when Atelier is not the foreground window.
  flashFrame(on: boolean): Promise<void>        // main: BrowserWindow.flashFrame
  setBadgeCount(n: number): Promise<void>        // main: app.setBadgeCount / overlay icon on Windows
  // Focus + raise the Atelier window (used by the jump flow).
  focusWindow(): Promise<void>                   // main: win.show(); win.focus()
  // So the plugin can implement focus-suppression (§5) without guessing.
  isWindowFocused(): Promise<boolean>
  onWindowFocusChange(cb: (focused: boolean) => void): () => void
}
```

Main-side mapping (all standard Electron, all main-only):

- `notify` → `new Notification({ title, body, silent: !sound })`; keep a map `id → conversationId`
  so its `click` handler emits `onNotificationClick`.
- `flashFrame` → `win.flashFrame(on)` (on Windows this flashes the taskbar button).
- `setBadgeCount` → `app.setBadgeCount(n)`; on Windows a numeric badge needs a taskbar **overlay
  icon** (`win.setOverlayIcon`) — the host renders a small count glyph. _(extrapolation: exact
  Windows overlay-icon rendering to be confirmed at build time.)_
- `focusWindow` → `win.show(); win.focus()` (plus `win.setAlwaysOnTop` momentarily if needed to
  beat Windows foreground-lock, see §8).
- Focus events → forwarded `blur`/`focus` of the `BrowserWindow`.

All payloads Zod-validated at the main boundary (invariant §4). Notifications are inherently a
host capability; there is no correct sandbox-only implementation.

#### HOST-GAP C — a persistent, global attention store (nice-to-have)

The attention log lives in `(conversation, plugin)` storage today, which means the log for events
about conversation B is stored under whichever conversation's pane happened to be mounted. For a
coherent single log across all conversations, the plugin needs an **app-scoped (not
conversation-scoped) storage** namespace, or the host should host the log itself.

Proposed minimal form: a per-plugin **global** storage bucket,
`atelier.storage.global.{get,set,keys}` (permission `storage`, but app-scoped rather than
conversation-scoped), persisted at `<userData>/atelier/plugins/<pluginId>/global.json`. Without
it, the v0 fallback keeps a per-conversation log (only records events about its own conversation),
which is acceptable for the single-conversation mode but does not satisfy US-5 across
conversations. **Flagged, not assumed.**

---

## 5. Event → notification rules engine

A pure function over the incoming (tagged) `AgentEvent` stream plus settings and focus state.
Runs **in the pane** (it's just logic; the pane already receives the events and holds settings).

### 5.1 Classification

For each incoming `AgentEvent & {conversationId}`:

1. Map to an event class (§4.1 table). `status`/`result`/`permission_request`/`question_request`/
   `error` drive the four classes. `permission_resolved`/`question_resolved` clear a pending block
   (and cancel any scheduled watchdog for it).
2. Respect `seq` on `status` events (ignore stale — matches `events.ts` guidance).

### 5.2 Debounce / coalescing

- **Per-conversation, per-class debounce.** A conversation that flaps `working ↔ idle` (tool
  bursts) must not fire a "finished" notification on every micro-idle. Only fire **turn-finished**
  when a `result` event arrives, or when `status` has been `idle` continuously for a short settle
  window (e.g. 1.5s) after a `working` run — whichever the implementation anchors on. Prefer
  `result` as the authoritative turn boundary; use the idle-settle only as a fallback.
- **Coalesce by `tag`.** Notifications use `tag = "<conversationId>:<class>"` so a re-fire replaces
  rather than stacks (HOST-GAP B `tag`). Two permission prompts in a row update one notification.
- **Rate cap.** No more than one notification per conversation per class per (e.g.) 10s.

### 5.3 Focus detection

- If Atelier is **focused** _and_ the event's conversation is the **currently active** one, and
  "focus suppression" is on (default), then **do not** notify/sound/flash — the user is already
  looking at it. Still write to the log (silently, marked read).
- Focus state comes from HOST-GAP B (`isWindowFocused` / `onWindowFocusChange`). Active
  conversation is known to the pane in `agent:read-all` mode via the conversation list + the
  `activeId` concept (`IPC.agentActiveId` exists). _(extrapolation: exposing "which conversation is
  active" to the pane may need a small addition to the cross-conversation feed — call it out.)_
- **Taskbar flash/badge only when unfocused.** `flashFrame(true)` and `setBadgeCount(n)` are called
  only while `isWindowFocused()` is false; on regaining focus the pane calls `flashFrame(false)` and
  recomputes the badge from unread log entries.

### 5.4 Quiet hours

- A `[start, end]` local-time window (handles wrap past midnight). During quiet hours: suppress
  popup + sound + flash; **still log** (so US-5 triage still works). A per-class "override quiet
  hours for errors" toggle is offered (errors are the one class a user often still wants at night).

### 5.5 Long-silence watchdog

- Maintain, per watched conversation, a timer reset on every inbound event. If the conversation is
  in a "should-be-progressing-or-waiting-on-me" state — `status==='working'` with no event for N
  seconds, **or** an unresolved `permission_request`/`question_request` older than N seconds — fire
  the watchdog once (debounced; one fire per stall, re-armed only after the stall clears).
- Anchor on `facts.lastSdkEventAt` / `turnStartedAt` from `UiStateSnapshot` when available
  (`uiStateOf`, HOST-GAP A) for accuracy across pane remounts; fall back to the pane's own
  last-seen timestamp.

### 5.6 Output actions

Given a fired event that survives suppression: (a) `os.notify(...)`, (b) play sound in-pane if
enabled, (c) `flashFrame(true)` + bump `setBadgeCount` if unfocused, (d) append an unread entry to
the log, (e) update the strip's aggregate dot/counts.

---

## 6. "Jump to conversation" mechanism

Two triggers: clicking a log row / strip "last event", and clicking a native notification.

1. **Notification click** arrives via `os.onNotificationClick({ id, conversationId })`
   (HOST-GAP B); the plugin maps `id → conversationId` (or reads it directly from the payload).
2. **In-pane click** already knows the `conversationId` of the row.
3. The plugin calls, in order: `os.focusWindow()` (HOST-GAP B — raise/focus Atelier), then a
   **switch-conversation** request.

#### HOST-GAP D — a plugin-initiated conversation switch

There is no host verb today for a plugin to make the app switch the active conversation. Main
_has_ the capability (`IPC.agentSetActive` / `agent.setActive(instanceId)` and
`IPC.agentOpen` / `agent.open(conversationId)` exist in `events.ts` — the latter reopens a closed
conversation). But those are app-shell IPC channels, **not** exposed on the sandbox `window.atelier`
surface. Proposed host verb (reuse `agent:read-all` or a new `agent:navigate` permission):

```ts
// on window.atelier.agent — gated appropriately
agent.focusConversation(conversationId: string): Promise<void>
// main: if closed, agent.open(id); then agent.setActive(id); the renderer shell selects it +
// scrolls the workspace to that conversation's ChatPanel. Reuses existing IPC under the hood.
```

- If the target conversation is **closed**, `focusConversation` reopens it first
  (`agent.open` returns the instance id) — important for US-5 (an event you missed may be from a
  conversation you since closed).
- The renderer shell (not the plugin) performs the actual view switch — the plugin only expresses
  intent, keeping the sandbox boundary intact (invariant §2).

Without HOST-GAP D, "jump" degrades to focusing the window and showing the log with the target
highlighted, leaving the user to switch manually — a real but lesser experience. Flag it.

---

## 7. Implementation milestones (ordered)

Each milestone builds, launches (`npm run dev`), and meets its own acceptance slice before the
next — per CLAUDE.md's phase discipline.

- **M0 — v0 single-conversation strip (no host changes).** `kind:panel`, `permissions:
["agent:read","storage"]`. Subscribe `agent.onEvent`; classify (§5.1); render the strip;
  persist the log + settings in `storage`; in-pane sound; settings UI. Watches only its own
  conversation. **Ships today.** Notifications/flash are stubbed (log-only) with a visible "OS
  notifications require host support" note.
- **M1 — HOST-GAP B (os verbs).** Add `atelier.os.{notify,onNotificationClick,flashFrame,
setBadgeCount,focusWindow,isWindowFocused,onWindowFocusChange}` + `os:notify` permission +
  main-side Electron mapping + Zod at the boundary. Wire the rules engine's output actions. Now
  real desktop notifications, sound, taskbar flash/badge — for the mounted conversation.
- **M2 — HOST-GAP A (cross-conversation feed).** Add `agent:read-all` + `agent.onAnyEvent` /
  `listConversations` / `uiStateOf`. The strip becomes a true multi-conversation watcher; enable
  the "watch all" scope toggle. This is the milestone that delivers US-1/US-2/US-5.
- **M3 — HOST-GAP D (jump) + HOST-GAP C (global log).** `agent.focusConversation` for real
  click-to-jump (reopen-if-closed); app-scoped global storage so one coherent log spans all
  conversations. Full proposal behaviour.
- **M4 — polish.** Quiet-hours overrides per class, mute-for chips, watchdog tuning, Windows
  foreground-lock handling (§8), sound pack, badge-count reconciliation on focus.

---

## 8. Risks

- **Notification fatigue.** The proposal's whole value collapses if it cries wolf. Mitigations:
  focus-suppression on by default, per-class debounce + coalescing (§5.2), rate caps, quiet hours,
  and turn-finished defaulting to `result`-anchored (not micro-idle). Ship conservative defaults
  (turn-finished + blocked ON; watchdog OFF until the user opts in).
- **Windows focus edge cases.** `flashFrame` behaviour varies with taskbar settings; a numeric
  badge on Windows requires an **overlay icon**, not `app.setBadgeCount` (which is macOS/Linux
  dock-style). And **foreground lock**: Windows often refuses `win.focus()` from a background app,
  so `focusConversation`'s window-raise may only flash the taskbar rather than steal focus — this
  is OS policy, not a bug. Design the jump flow to degrade gracefully (flash + highlight) when the
  raise is denied. _(extrapolation: exact overlay-icon + foreground-lock behaviour to be verified
  on the target Windows 11 build.)_
- **Cross-conversation permission breadth.** `agent:read-all` exposes every conversation's activity
  to one pane. Consistent with the "capability declaration, not security wall" framing
  (`PLUGIN_API.md` §4), but must be surfaced clearly in the rail.
- **Watchdog false positives.** A genuinely long tool call (a 5-minute test run) looks like
  silence. Anchor on `status==='working'` + `lastSdkEventAt`, and let the threshold be generous and
  user-set; never fire the watchdog for an `idle` conversation.
- **Log/storage scope confusion.** Until HOST-GAP C, the log is per-conversation; be explicit in
  the UI that a per-conversation-mounted v0 only records its own conversation's events, so users
  don't expect a global log prematurely.
- **Duplicate notifications with multiple mounts.** If the plugin is enabled in several
  conversations _and_ later gains `agent:read-all`, naive code could fire N copies. The
  cross-conversation feed must be consumed by exactly one authority — recommend the rules engine
  key on a single "primary" mount, or (cleaner) let `agent:read-all` mode collapse to one logical
  watcher.

---

## 9. Acceptance criteria

**v0 (M0, buildable today):**

- Manifest validates; plugin appears in the rail; enabling mounts the strip at `bottom`.
- A turn finishing in the mounted conversation appends a "turn finished" entry to the log within
  ~2s; a `permission_request` appends a "blocked" entry immediately; an `error`/`result.isError`
  appends an "error" entry.
- Settings (per-event toggles, quiet hours, sound, watchdog threshold) persist across pane
  close/reopen and app restart (rebuilt from `storage` on mount — restore contract §8).
- In-pane sound plays when enabled and not in quiet hours.
- With no host support, the pane clearly states OS notifications/flash are unavailable and still
  logs everything.

**Full (M1–M3, host gaps filled):**

- Finishing/blocking/erroring in **any** conversation raises a native notification naming that
  conversation (subject to toggles/quiet hours/focus suppression).
- When Atelier is unfocused, the taskbar button flashes and shows an unread badge; both clear on
  focus.
- Focus suppression: no notification/sound/flash for the currently-active, focused conversation;
  the event is still logged (marked read).
- Long-silence watchdog fires exactly once per stall for a working-or-blocked conversation past
  the threshold, and re-arms only after the stall clears.
- Clicking a notification or a log row focuses Atelier and switches to (reopening if needed) the
  originating conversation.
- Quiet hours suppress popup/sound/flash but not the log; the per-class "errors override quiet
  hours" toggle works.
- No duplicate notifications when the plugin is enabled in multiple conversations.

---

## Appendix — HOST-GAP summary (the asks, precise)

| Gap   | What's missing                                                        | Proposed API                                                                                                       | Permission                               |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **A** | Cross-conversation event feed (plugins are per-conversation)          | `agent.onAnyEvent`, `agent.listConversations`, `agent.uiStateOf` (events tagged with `conversationId`)             | new `agent:read-all`                     |
| **B** | OS notification / taskbar flash / badge / window-focus from a sandbox | `atelier.os.{notify,onNotificationClick,flashFrame,setBadgeCount,focusWindow,isWindowFocused,onWindowFocusChange}` | new `os:notify`                          |
| **C** | App-scoped (not conversation-scoped) storage for one coherent log     | `atelier.storage.global.{get,set,keys}` at `<userData>/atelier/plugins/<id>/global.json`                           | existing `storage` (widened scope)       |
| **D** | Plugin-initiated conversation switch (reopen-if-closed)               | `atelier.agent.focusConversation(conversationId)` (reuses `agent.open`/`agent.setActive` under the hood)           | `agent:read-all` or new `agent:navigate` |

Everything above rests on facts in `electron/shared/events.ts` (the `AgentEvent` union,
`UiStateSnapshot`, `ConversationSummary`, and the already-present `IPC.agentListAll` /
`agentActiveId` / `agentSetActive` / `agentOpen` / `agentUiState` channels), `PLUGIN_API.md`
(per-conversation `agent`/`storage` scoping, the "Not exposed" line, the manifest+permission
schema), and `PLUGIN_ARCHITECTURE.md` (registry-vs-enablement, one-sandbox-per-conversation).
Claims that go beyond what those files establish are marked _(extrapolation)_.
