# mission-control — design

Status: **design** (not built). A proposed default plugin for Atelier.
Source proposal: `docs/plugin-proposals/PROPOSALS.md` §8 (`mission-control`, tier T2).
Normative contracts this doc is bound by: `PLUGIN_API.md`, `docs/PLUGIN_ARCHITECTURE.md`,
`docs/CONTEXT_SYSTEM.md`.

One place that answers "what's in flight, what's blocked, what finished while I was gone."
A read-only board over the conversation's live agent-work state (task list, subagent fleet,
background commands), plus one write lever: chat-injection nudges.

Claims below are grounded in the code cited inline. Anything not yet supported by the host
is called out under **HOST-GAP** and marked _[extrapolation]_ where it goes beyond what the
docs/code establish.

---

## 1. Purpose + user stories

**Purpose.** Power users run parallel work — subagents, background tasks, overnight runs.
In a TUI (and largely in Atelier's chat today) that work is invisible-ish: a running
indicator and a picker, no board, no history of what completed. mission-control is the
single pane that makes the agent's in-flight work legible: a kanban of the task list with
blocked-by edges, a live subagent fleet with elapsed clocks, background commands with exit
status, and an inbox of things that finished while you were away — with a way to nudge the
agent from the board.

**User stories.**

- _As a user running parallel work,_ I open one pane and see every in-flight subagent, what
  each is doing, and how long it's been running — instead of watching the chat scroll.
- _As a user with a multi-step plan,_ I see the task list as a board (pending / in-progress /
  done) with blocked-by edges, so I can tell what's actually gating progress.
- _As a user who stepped away,_ I come back to an inbox strip listing the subagents/tasks
  that completed while I was gone, newest first, so nothing that finished is lost to a
  scrolled-past transcript.
- _As a user watching a background command,_ I see it running and then its exit status
  (0 / non-zero), not just a wall of stdout.
- _As a user who wants to redirect the agent,_ I click "promote this task" (or "check on the
  slow subagent") on a board item and the agent gets a concise, framed nudge as if I typed
  it — without me composing the sentence.

**Non-goals.** mission-control does not _execute_ anything itself — it does not spawn
subagents, kill tasks, or run commands. It observes the agent's work and nudges via chat.
(Killing a subagent is a `TaskStop`-shaped host capability the plugin does not have; see §7.)

---

## 2. Panel UX

`kind: "panel"`, `defaultDock: "bottom"` (a wide board reads better along the bottom than in
a narrow side rail; the user can re-dock/float — dock position is the host's job,
PLUGIN_API §8).

Layout, top to bottom:

1. **Inbox strip** (collapsible header band). Chips for items that _completed_ while the pane
   was unfocused/closed: `✓ subagent "refactor auth" · 4m` / `✗ npm test · exit 1 · 2m ago`.
   Newest first, capped (e.g. 20). Clicking a chip scrolls the board to that item's lane (if
   still shown) or just dismisses it. A "clear" affordance empties the strip. The strip is
   empty and hidden when nothing has finished unseen.

2. **Kanban board** — three columns: **Pending**, **In progress**, **Done**. Cards are task
   items (from the agent's task list). Each card shows the task label/subject, a small
   elapsed clock while in-progress, and **blocked-by edges** rendered as a "⛓ blocked by:
   <task>" line (and, when the blocker is visible, a drawn connector). A blocked card sits in
   Pending with a distinct "blocked" tint. Card overflow menu → nudges (§5).

3. **Fleet view** — a compact live list of running **subagents**: name/label, its current
   activity (one line, derived from `task_activity`), and an **elapsed clock** ticking from
   `startedAt`. Sorted oldest-first (stable — matches `BackgroundRegistry.list()`,
   `electron/agent/backgroundTasks.ts`). When the fleet is large, collapse to a count with a
   "show all" expander (see §7).

4. **Background commands** — running shell commands with a live/`done` state and, when
   available, **exit status** (`exit 0` green / `exit N` red). Derived from the bash tap
   (`BASH_STREAM_CHANNEL`) plus a host gap for exit codes (§4, §7).

Visual language follows `DESIGN_SYSTEM.md` (line-icons, `--accent`/`--faint`, theme vars).
Elapsed clocks tick client-side from `startedAt` (no host polling). Empty states are explicit
("No subagents running", "No tasks yet") so a single-threaded user sees a calm, correct pane
rather than a broken-looking one.

---

## 3. Manifest sketch

Real JSON matching the schema in PLUGIN_API §1/§4 and the permission set in
`electron/shared/plugins.ts` (`agent:read`, `agent:send`, `storage`, `data:subscribe`).
mission-control is view-first with one write lever (nudge), so it needs no `backend` and no
`tools` — everything it consumes flows over `agent.onEvent`, and its one write is
`agent.send`.

```json
{
  "id": "mission-control",
  "name": "Mission Control",
  "version": "0.1.0",
  "icon": "M2 2h5v5H2zM9 2h5v3H9zM2 9h5v5H2zM9 8h5v6H9zM4.5 7.5v1.5",
  "kind": "panel",
  "entry": "index.html",
  "permissions": ["agent:read", "agent:send", "storage", "data:subscribe"],
  "defaultDock": "bottom"
}
```

Rationale per permission:

- `agent:read` — subscribe to this conversation's `AgentEvent` stream (the task/subagent
  feed). Required for the whole board. (`PluginPane.tsx` gates `agent.info`/`agent.onEvent`
  on this.)
- `agent:send` — inject nudges (§5). (`PluginPane.tsx` gates `agent.send` on this.)
- `storage` — persist the inbox and last-seen watermarks so "finished while away" survives
  pane close / conversation switch / restart (§4, PLUGIN_API §8). Scoped
  `(conversation, plugin)`.
- `data:subscribe` — subscribe to `BASH_STREAM_CHANNEL` (`"bash:stdout"`) to detect
  background-command start/output for the commands lane. (Exit status is a gap — §4.)

No `contextExports` in v1: mission-control is a dashboard, not a context document. A future
export ("open work summary" pinned so the agent knows what's still in flight) is a plausible
v2 addition and would reuse the CONTEXT_SYSTEM.md mechanism verbatim — noted, not designed
here _[extrapolation]_.

---

## 4. Data flow — where the state lives and how a sandboxed pane consumes it

### What the host already tracks

Subagent + task state lives in `BackgroundRegistry`
(`electron/agent/backgroundTasks.ts`): a `Map<string, RunningTask>` keyed
`"<kind>:<id>"`. It is populated from:

- **Subagents** — `startSubagent(id, label, detail, now)` / `stopSubagent(id)`, keyed by the
  Task tool call's `toolUseId`, detected from forwarded messages in the pump.
- **Tasks** — `createTask(taskId, subject, detail, now)` / `completeTask(taskId)`, from
  `TaskCreated`/`TaskCompleted` hooks.
- `clearSubagents()` reconciles stale subagents against SDK ground truth; `list()` returns
  everything running, **oldest-first**.

`RunningTask` (`electron/shared/events.ts`) is exactly:

```ts
interface RunningTask {
  id: string
  kind: 'subagent' | 'task'
  label: string
  detail?: string
  startedAt: number
}
```

The Session emits `list()` to the renderer as an `AgentEvent` whenever it changes:

```ts
| { instanceId; kind: 'background'; tasks: RunningTask[] }        // full snapshot
| { instanceId; kind: 'task_activity'; taskId: string; item: TaskItem }  // live subagent activity
```

(`TaskItem` is the simplified forwarded-conversation item: `text` / `thinking` /
`tool_use` / `tool_result{ok, output}`.)

### How a sandboxed plugin consumes it TODAY

The pane never touches the host directly. The host injects `window.atelier` into the sandbox
(`electron/plugin/runtime.ts`); the renderer relay (`src/components/PluginPane.tsx`) enforces
permissions and forwards. mission-control's data path:

- `atelier.agent.onEvent(cb)` → the relay subscribes once to
  `window.atelier.agent.onEvent` and forwards **only this conversation's** events
  (`ev.instanceId === getConversationId()`, checked live so a conversation switch re-scopes
  without re-subscribing — `PluginPane.tsx` lines ~416-431). The pane receives the same
  `AgentEvent` union the chat consumes, including `kind: 'background'` and
  `kind: 'task_activity'`.
- `atelier.agent.info()` → `{ id, title, cwd, status }` for the conversation (label the
  board header).
- `atelier.data.subscribe("bash:stdout", cb)` → `BashStreamMessage` frames
  (`phase: 'start' | 'output' | 'error'`, `command?`, `text?`, `toolUseId`) for the
  background-commands lane.
- `atelier.storage.get/set` → durable inbox + watermarks.

So the board is a **fold over the event stream**, held in pane memory and mirrored to
`storage`:

1. On `load`, read `storage` (persisted inbox + last-known board) and render immediately —
   treat every mount as a restore (PLUGIN_ARCHITECTURE "DO"). Then subscribe to
   `agent.onEvent`.
2. Each `background` snapshot **replaces** the current running set. Diff against the prior
   set: an entry that _left_ the set is a completion → append to the inbox with a computed
   elapsed (`now - startedAt`). Entries still present drive the fleet + in-progress lanes.
3. Each `task_activity` updates the matching fleet row's one-line "current activity".
4. Bash `start`/`output`/`error` frames drive the commands lane.
5. Persist inbox + watermark to `storage` on every change (and defensively on the `unload`
   hook).

### HOST-GAP

The proposal names four data surfaces; the host feed covers some fully, some partially, and
some not at all. What is **missing today**:

1. **Blocked-by edges are not in the feed.** `RunningTask` has `id`, `kind`, `label`,
   `detail?`, `startedAt` — no dependency/blocker field, and the Pending/Done columns
   themselves aren't distinguished (the registry only holds _running_ work; `completeTask`
   _deletes_ the entry). The kanban's "blocked-by" and a durable Done column need richer task
   data than the registry exposes.

2. **No completion metadata.** Because `completeTask`/`stopSubagent` just delete the map
   entry, a `background` snapshot only tells the plugin an item _disappeared_ — not whether a
   task succeeded/failed or what a subagent produced. The inbox can say "finished" and show
   elapsed, but not outcome, purely from the diff. _[extrapolation: inferring completion from
   set-departure is reliable enough for an inbox chip, but conflates "completed" with
   "cancelled/interrupted"; `clearSubagents()` reconciliation would show up as spurious
   completions.]_

3. **No background-command exit status.** The bash tap (`BashStreamMessage`) carries
   `start` / `output` / `error` phases and raw text — **no exit code**. "background commands
   with exit status" cannot be honored precisely from the tap alone; the plugin can only show
   running/stopped and an error-phase heuristic.

4. **No cross-conversation reach.** `agent.onEvent` is deliberately scoped to the pane's own
   conversation (`PluginPane.tsx`; matches PLUGIN_API §3 "no cross-conversation reach"). A
   true fleet view _across_ conversations is out of contract (see §7).

**Proposed fix — a read-only agent-work feed (host addition).** Add an enriched, host-owned
work model surfaced over the existing `agent.onEvent` union (no new plugin permission — still
`agent:read`), so the sandbox contract is unchanged. Concretely _[extrapolation — these are
proposed shapes, to be confirmed against the SDK task-hook payloads and recorded in
`docs/SDK_NOTES.md` before building, per CLAUDE.md]_:

- Extend `RunningTask` (or add a sibling `TaskRecord`) with optional
  `status: 'pending' | 'in_progress' | 'completed' | 'blocked'`, `blockedBy?: string[]`, and
  `endedAt?`/`outcome?: 'ok' | 'error'`. Keep completed records for the conversation's
  lifetime (a bounded ring) instead of deleting on complete, so a Done column and outcome are
  derivable. This is the "read-only agent-work feed" the proposal implies.
- Add an `exitCode?: number` to the terminal bash frame (a new `phase: 'exit'` on
  `BashStreamMessage`, or an `exitCode` on the existing `error`/final `output` frame), fed
  from the Bash tool's PostToolUse result the host already sees.
- Because both ride channels the plugin can already read (`agent:read` events,
  `data:subscribe` on `bash:stdout`), **no new plugin-facing permission or API method is
  required** — the gap is host-side enrichment, and the plugin degrades gracefully to
  running/elapsed-only when the fields are absent (which is exactly how v1 must ship until the
  host lands the enrichment).

Until the host closes the gap, v1 renders: fleet + elapsed (fully supported), inbox by
set-departure with elapsed (supported, outcome-blind), an in-progress/pending split by
`kind`/heuristic, and background commands as running/stopped without a guaranteed exit code.

---

## 5. The nudge / injection mechanism

A nudge is a **user message injected into the conversation** via
`atelier.agent.send(text)` — which the relay routes to `window.atelier.agent.send(conv, text)`
(`PluginPane.tsx`), i.e. "exactly as if typed" (`runtime.ts` comment). It requires
`agent:send`. There is no bespoke channel and none is needed — chat-injection is the whole
mechanism the proposal calls for.

Nudges are **templated, one-click actions** on a board item, so the user never composes the
sentence:

- On a Pending/blocked task card → **"Promote this task"** →
  `send("Please prioritize the task \"<label>\" next.")`
- On a blocked card → **"What's blocking this?"** →
  `send("The task \"<label>\" is blocked by <blocker>. Can you unblock or resequence it?")`
- On a long-running fleet row → **"Check on this subagent"** →
  `send("The subagent \"<label>\" has been running <elapsed>. Is it stuck? Consider stopping or redirecting it.")`
- On a failed command chip → **"Investigate this failure"** →
  `send("The background command \"<command>\" exited non-zero. Please look into it.")`

Design rules:

- **The board is read-only except for send.** A nudge only ever injects text; the plugin
  never claims to have changed task state itself. State on the board updates when the _agent_
  acts and the host emits new `background`/`task_activity` events. This keeps the board an
  honest mirror.
- **Debounce / confirm.** Injecting while the agent is mid-turn could pile up. The pane reads
  `status` from `agent.info()`/the `status` event; if `working`, the nudge button offers
  "send now" vs. a soft warning that a message will queue. (No hard block — the host already
  queues sends.)
- **Quote precisely.** Templates interpolate the exact label/command/elapsed the user sees,
  so the injected message references the same item the user clicked. Labels are truncated in
  the template to keep the injected line short.

---

## 6. Implementation milestones (ordered)

Each milestone builds and is demonstrable before the next (CLAUDE.md working method). v1
targets only what the host supports today; later milestones depend on the HOST-GAP fix.

1. **M1 — Skeleton + restore.** Folder, manifest (§3), `index.html`. `load` reads `storage`
   and renders empty lanes. Subscribe to `agent.onEvent`; log events. Verify permission gating
   (drop `agent:read` → subscribe rejected). _Acceptance: pane mounts, restores an empty
   board, receives events._
2. **M2 — Fleet view.** Render running subagents from `background` snapshots with client-side
   elapsed clocks (oldest-first). Wire `task_activity` → per-row current activity. _Acceptance:
   a running subagent appears with a ticking clock and its latest activity line._
3. **M3 — Inbox strip.** Diff successive `background` snapshots; departed entries become inbox
   chips (label, kind, elapsed). Persist inbox to `storage`; survive pane close/reopen and
   conversation switch. "Clear" empties it. _Acceptance: start then finish a subagent with the
   pane closed → chip present on reopen._
4. **M4 — Kanban (best-effort).** Task-kind entries as cards; in-progress vs pending split by
   available fields/heuristic; elapsed on in-progress. Blocked tint when a `blockedBy` field
   is present (renders nothing when absent). _Acceptance: tasks appear as cards; board is
   stable and non-broken with today's data._
5. **M5 — Background commands.** Subscribe `bash:stdout`; render running commands, mark
   `done` on final frame; show exit status **iff** the host supplies it (else running/stopped).
   _Acceptance: a background command shows running then done._
6. **M6 — Nudges.** Per-item templated `agent.send` actions with the working-state guard (§5).
   _Acceptance: "Promote this task" injects the exact templated message into the chat._
7. **M7 — HOST-GAP consumption.** Once the host lands the enriched agent-work feed (§4): real
   blocked-by edges + connectors, a durable Done column with outcome, and command exit codes.
   Purely additive in the pane — earlier milestones degrade gracefully without it.

M1-M6 are shippable against the current host. M7 is gated on the host-side enrichment and its
`docs/SDK_NOTES.md` confirmation.

---

## 7. Risks / edge cases

- **Stale tasks / spurious completions.** `clearSubagents()` reconciliation (run_in_background
  acks, interrupted turns) deletes subagent entries the Task result never closed — a naive
  set-diff reads those as "completed" inbox chips. Mitigation: tag inbox chips as "finished"
  not "succeeded" in v1 (outcome unknown), and prefer the host `outcome`/`endedAt` fields
  (M7) before claiming success/failure. Consider a short debounce before promoting a
  departure to the inbox, to absorb reconcile churn.
- **Rebind clears everything.** `BackgroundRegistry.clear()` runs on rebind (the owning query
  is gone); a `background` snapshot then goes empty. The pane must treat an empty snapshot as
  "nothing running now," _not_ "everything just completed" — guard the diff so a wholesale
  clear doesn't flood the inbox. _[extrapolation: distinguishing rebind-clear from genuine
  completions cleanly needs a host signal; until then, suppress inbox emission when the set
  goes from many→0 in a single snapshot.]_
- **Many subagents.** A large fleet (overnight swarm) must not blow out the pane or context.
  The fleet list virtualizes / collapses to a count with "show all"; `task_activity` updates
  are throttled per row. No unbounded growth: inbox is capped (ring), stored board state is
  bounded.
- **Cross-conversation scope.** The feed is single-conversation by contract (PLUGIN_API §3;
  `PluginPane.tsx`). A user with parallel _conversations_ sees only the active one's work.
  A cross-conversation fleet is explicitly out of scope for v1 and would require a new,
  deliberately-scoped host capability (a security/scoping decision recorded in
  `docs/DECISIONS.md`) — do not quietly widen `agent.onEvent`. _[extrapolation]_
- **Nudge storms.** Repeated clicks queue multiple sends. Debounce per action; disable a
  nudge button briefly after firing; surface "queued while working."
- **Restore correctness.** Anything not in `storage` is gone on reload (PLUGIN_API §8). The
  live running set is rebuilt from the first post-mount `background` snapshot, not from
  storage — so on restore the fleet may be briefly empty until the next snapshot. Persist only
  the _inbox_ and watermarks; never try to persist "currently running" as truth.
- **No exit code today.** Marking a command failed from the bash `error` phase is a heuristic
  (stderr text ≠ non-zero exit). Label it "had errors" not "exit N" until the host supplies a
  real exit code (M7).

---

## 8. Acceptance criteria

The plugin is acceptable when, against the **current** host (M1-M6):

1. Manifest is Zod-valid; the pane mounts in a sandbox with only the four declared
   permissions; dropping `agent:read` demonstrably rejects the event subscription.
2. A running subagent appears in the fleet view within one snapshot, with a ticking elapsed
   clock (from `startedAt`) and its latest `task_activity` line; multiple subagents list
   oldest-first and stay stable.
3. Task-kind entries render as kanban cards without breaking the board when blocked-by /
   done-outcome data is absent (graceful empty/pending rendering).
4. A subagent/task that leaves the running set produces exactly one inbox chip (label, kind,
   elapsed); a wholesale set→empty snapshot (rebind/clear) produces **no** flood of chips.
5. The inbox and its watermark persist across pane close/reopen and conversation switch, and
   are correctly re-scoped per conversation (conversation A's inbox invisible to B).
6. A background command from `bash:stdout` shows running then done.
7. A per-item nudge injects the exact templated message via `agent.send` (verified in the
   chat transcript), with the working-state guard behaving.
8. No path lets a plugin error throw into the host; a malformed event is tolerated and the
   pane keeps rendering (PLUGIN_ARCHITECTURE "don't let a bad plugin throw into the host").

And, gated on the HOST-GAP fix (M7 — separately acceptable):

9. Blocked-by edges render from a real `blockedBy` field; the Done column shows outcome from
   `endedAt`/`outcome`; background commands show a true `exitCode`.

Un-automatable checks to spot-check by a human (per CLAUDE.md): the elapsed clocks tick
smoothly under a real overnight run, and the inbox correctly captures completions that happen
while the app window is unfocused.
