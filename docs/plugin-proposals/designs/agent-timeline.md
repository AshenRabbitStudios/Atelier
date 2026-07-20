# agent-timeline — design

A default panel plugin that renders a **live trace of the current conversation**: every tool
call as a timeline block (name, target, duration, outcome), color-coded by tool family, with a
subagent tree, click-to-expand full I/O, filters, and a "current activity" header. It is
fundamentally a _renderer of the agent event stream_ — it adds no capabilities to the agent, it
makes the agent's behavior legible.

Status: **design**. Grounded in PLUGIN_API.md, docs/PLUGIN_ARCHITECTURE.md,
docs/CONTEXT_SYSTEM.md, `electron/shared/events.ts`, and proposal #3 in
docs/plugin-proposals/PROPOSALS.md. Points marked **[extrapolation]** go beyond what those
documents state and are my design proposals, not established fact.

---

## 1. Purpose + user stories

**Purpose.** Atelier sits on the live SDK event stream, so it can render the agent's trace
_first-hand_ rather than reconstructing it forensically from logs (PROPOSALS.md #3). This plugin
turns "is it stuck / what is it doing right now / why did that turn take so long" from vibes into
evidence.

**User stories.**

- _As a user watching a long silent stretch_, I see a "current activity" header — "Editing
  `src/foo.ts` · 2.4s" — so I know it's working, not wedged. This directly treats the
  "chain-of-thought stopped / is it stuck?" anxiety named in the proposal.
- _As a user debugging a slow turn_, I scan the timeline and the slow/failed blocks are visually
  loud; I click the 8-second `Bash` block and read the exact command and its output.
- _As a user who suspects a doom loop_, I filter to one tool and see the same `Read` of the same
  3k-line file fired six times.
- _As a user tracking a subagent-heavy run_, I expand the subagent subtree and watch a `Task`'s
  child tool calls without losing the parent thread.
- _As a user reopening a conversation days later_, the timeline for the loaded transcript is
  rebuilt from persisted history so I can review what happened (subject to the retention rules in
  §6).

**Explicit non-goals.** No cost/token attribution (that's `cost-dashboard`, PROPOSALS.md #4). No
approve/revert of edits (that's `change-review`, #2). No repo state (that's `git-workbench`, #1).
This plugin _observes_; it does not act. It contributes **no agent tools** and **no context
exports** — nothing it renders needs to re-enter the agent's context.

---

## 2. Panel UX

### Layout

A vertically-scrolling **list of timeline rows**, newest at the bottom (chat-aligned), each row
one tool call:

```
┌─ current activity ─────────────────────────────────────────────┐
│ ● Editing src/agent/manager.ts · 2.4s   [running spinner]       │
├─────────────────────────────────────────────────────────────────┤
│ filters:  [errors only] [tool ▾] [turn ▾]         242 events    │
├─────────────────────────────────────────────────────────────────┤
│ ▸ 09:14:02  ▪amber Read    src/foo.ts                 42ms  ok   │
│ ▸ 09:14:02  ▪green Grep    "AgentEvent"              118ms  ok   │
│ ▾ 09:14:05  ▪blue  Task    "audit the schema"        6.2s  ok   │  ← subagent, expandable
│      ▸ 09:14:05  ▪amber Read  events.ts               31ms  ok   │
│      ▸ 09:14:06  ▪red   Bash  npm run typecheck       5.1s  ERR  │  ← failure, loud
│ ▸ 09:14:12  ▪amber Edit    src/agent/manager.ts       —    ...   │  ← in flight
└─────────────────────────────────────────────────────────────────┘
```

Each row shows: a **family color chip**, the **tool name**, a **target** (the most salient field
of `input` — file path for Read/Edit/Write, command for Bash, pattern for Grep/Glob, subagent
description for Task; a generic truncated JSON summary otherwise), a **duration**, and an
**outcome** badge (ok / error / running). Failed rows get a red left border + tinted background;
slow rows (over a configurable threshold, default 3s) get a bold duration. This is the "slow calls
and failures visually loud" requirement.

### Color families **[extrapolation — palette is my proposal]**

Grouped by tool _family_ so the eye reads intent, not individual tool names. Colors are token
references from DESIGN_SYSTEM.md (never hardcoded hex); the mapping below is the intent:

| Family       | Tools                                   | Intent      |
| ------------ | --------------------------------------- | ----------- |
| read         | Read, Grep, Glob, NotebookRead          | inspect     |
| write        | Edit, Write, NotebookEdit               | mutate      |
| exec         | Bash, and any `run`/shell tool          | run         |
| task         | Task (subagent), TaskStop               | orchestrate |
| mcp / plugin | `mcp__*`, plugin-contributed tools      | external    |
| ask          | AskUserQuestion, permission-gated calls | needs-you   |
| other        | anything unmatched                      | neutral     |

Family is derived from the tool `name` by a small classifier table; unknown names fall to
`other`. The table is data, not hardcoded UI, so new tools slot in without a rewrite.

### Density at 500+ events

The proposal implies a busy session. Design targets:

- **Row height ~22px, single line.** A 500-event session is ~11,000px — trivially scrollable.
- **Virtualized list** (windowed rendering): only ~60 visible rows are in the DOM at once
  regardless of total count. This is the load-bearing performance decision (see §6).
- **Collapsed subagent subtrees by default** past a threshold: a `Task` with children renders as a
  single summary row ("Task · 14 calls · 6.2s") that expands on click, so a subagent that made 200
  calls costs one row until you ask for it.
- **Coalescing** of trivial identical adjacent reads is _not_ done (it would hide doom loops — the
  exact thing a user wants to see); instead a subtle "×6" affordance could badge repeats
  **[extrapolation]** without removing rows.

### Expansion (click-to-expand full I/O)

Clicking a row expands an inline detail region under it showing: full `input` (pretty-printed
JSON, or the raw command/diff for Bash/Edit), full `output` (from the matching `tool_result`),
`toolUseId`, start time, and duration. Large I/O is capped in the panel with a "show more" — the
full untruncated value is only as complete as the event stream delivered (the host may itself cap
`tool_result.output`; see §8 risks). Code/diffs render with the app's Shiki/CodeMirror stack via
the plugin's own bundle (the pane is a full sandboxed app, PLUGIN_API §1).

### Filters

- **errors only** — toggle; shows only rows whose outcome is error (and their ancestor Task rows).
- **by tool** — multiselect of tool names seen this session.
- **by turn** — jump/scope to one assistant turn. Turn boundaries are inferred from the event
  stream (a `result` event closes a turn; the next `tool_use`/`text` opens the next).
  **[extrapolation — the stream has no explicit turn-id; see §8.]**

Filters are view-only (they never drop retained data) and their state persists per conversation
via `storage` so a reopened pane restores the user's last view.

### Live-follow vs scrollback

A **"follow" pin** (like a terminal's auto-scroll). While pinned, new rows scroll into view and
the current-activity header is live. Scrolling up **unpins** (classic terminal behavior); a
"jump to live ▾" button re-pins. Follow state is UI-only, not persisted (every mount starts
pinned = following).

### Current-activity header

Always-visible top strip. Its content:

- **Working:** the most recent tool call that has a `tool_use` but no `tool_result` yet, rendered
  as "‹verb› ‹target› · ‹live elapsed›" with a spinner. If several are open (parallel tool use),
  it shows the count ("3 tools running") and the newest.
- **Thinking/streaming text with no open tool:** "Thinking…" / "Writing response…".
- **Idle:** last turn's summary — "Idle · last turn: 14 calls, 22s, 1 error".

The header derives from the same event state as the rows; `status` events (`idle`/`working`/
`error`) gate the spinner so it never spins when the agent is truly idle.

---

## 3. Manifest sketch

Matches the real schema (Zod-validated on discovery; fields confirmed against
`plugins/examples/*/manifest.json` and PLUGIN_API §1). The `permissions` value `agent:read`
gates the live `atelier.agent.info`/`onEvent` surface, which is already implemented for panes
(see §4); only the mount-time history backfill is missing — see **HOST-GAP** (§5).

```jsonc
{
  "id": "agent-timeline",
  "name": "Agent Timeline",
  "version": "0.1.0",
  "description": "A live trace of this conversation: every tool call as a timeline block (name, target, duration, outcome), color-coded by tool family, with a subagent tree and click-to-expand full I/O. Passive observability; no tools, no context — nothing for you to drive or read back.",
  "icon": "M2 2v12h12M4.5 11l2.5-3 2 1.5 3.5-5",
  "kind": "panel",
  "entry": "index.html",
  "permissions": ["agent:read", "storage"],
  "defaultDock": "right"
}
```

- `kind: "panel"` — pure viewer; no `backend`, no `tools`, no `contextExports`.
- `permissions`: `agent:read` for the event stream (§5), `storage` for filter/view persistence.
  Least-privilege — it declares no `data:*`, `net:*`, or `context`.
- `icon` — a rising-timeline glyph distinct from the existing plugins' icons (bash-stream's
  terminal, cartographer's target rings). 16px, single path, `viewBox 0 0 16 16`, stroke
  `currentColor`.

---

## 4. Data flow — how a sandboxed pane gets the event stream

The panel needs the per-conversation `AgentEvent` stream defined in `electron/shared/events.ts`
(`system_init`, `tool_use`, `tool_result`, `status`, `tokens`, `result`, `background`,
`task_activity`, `error`, …). Here is **what the host actually offers a plugin today**, checked
against the code:

**What exists (verified against the code, not just the `AtelierAPI` type):**

- The injected sandbox runtime — `electron/plugin/runtime.ts` — implements the `atelier.agent`
  namespace for panes: `agent.info()` and `agent.onEvent(cb)` (this conversation's `AgentEvent`
  stream) gated by `agent:read`, and `agent.send(text)` gated by `agent:send`. The PluginPane
  relay in the renderer enforces the permission and forwards only the mounted conversation's
  events (Phase 1, docs/roadmap/01-agent-bridge.md).
- Note a trap for readers: the `AtelierAPI` **preload** type in `electron/shared/events.ts` does
  not list an `agent` sub-API under `plugins` — the plugin path runs through the sandbox runtime
  - PluginPane relay (which consumes the renderer's own `agent.onEvent`), not through a
    `plugin:agent-*` IPC channel. The surface is real; it just isn't visible in that type.
- The DataBus (`data.subscribe`) carries _published_ channels (files, `bash:stdout`, plugin
  topics). The agent's structured `AgentEvent` stream is not on the DataBus — it arrives via
  `agent.onEvent`. The bash tap (`BASH_STREAM_CHANNEL`) publishes only raw stdout/stderr.

**Conclusion:** the **live** stream this plugin needs exists today behind `agent:read` — the
timeline can render everything that happens after its pane mounts with no new host capability.
What does **not** exist is a backlog/history read for events that happened before mount (or
while the pane was closed). That is the one genuine gap. See **HOST-GAP**.

### Restore / persistence

Per PLUGIN_API §8 and PLUGIN_ARCHITECTURE, **treat every mount as a restore**:

- The **live** stream is ephemeral push; a pane mounted mid-run only sees events _after_ mount.
- To rebuild the timeline for the transcript that already happened, the pane needs a **history
  read** at mount (the events before it subscribed). This is part of the HOST-GAP: the
  subscription must offer a bounded backlog fetch, sourced from the transcript the host already
  parses (`AtelierAPI.agent.transcript` yields `tool_use` blocks with `input` and
  `result: { ok, output }` — the exact fields the timeline needs).
- **View state** (active filters, follow-threshold, subagent-collapse preference) is the only
  durable state and lives in `storage` under `(conversation, plugin)`. The **event data itself is
  not persisted by the plugin** — it is re-derived from the host's transcript/backlog on each
  mount, so the plugin never becomes a redundant, drift-prone copy of the trace.

---

## 5. HOST-GAP — mount-time history backfill (`agent.history`)

**Gap.** `agent.onEvent` is live-only: a pane mounted mid-session (or re-mounted after being
closed, or opened after an app restart) has no way to reconstruct the trace that already
happened. The runtime offers no backlog read, and the host's parsed transcript
(`AtelierAPI.agent.transcript`, which carries `tool_use` blocks with `input` and
`result: { ok, output }`) is a renderer-only surface not exposed to plugins. Without a backfill,
the timeline violates the "treat every mount as a restore" invariant (PLUGIN_API §8) or is
forced to persist its own drift-prone copy of every event.

**Proposed capability: `agent.history(limit?)` on the existing `agent:read` slice.**

```ts
// permission: "agent:read" (already enforced for info/onEvent — same gate, no new permission).
// Bounded backlog for mount-time restore: the tool-call trace that already happened,
// newest-last, capped host-side. Sourced from the host's parsed transcript so the plugin
// rebuilds the timeline without persisting its own copy.
history(limit?: number): Promise<AgentEvent[]>
```

**Wiring (extends the existing Phase 1 agent-bridge path):**

- **Runtime (`electron/plugin/runtime.ts`):** add `history` to the `agent` namespace beside
  `info`/`onEvent` — same `call('agent', 'history', [limit])` relay shape.
- **Relay (PluginPane):** enforce `agent:read` exactly as `info`/`events` are gated today, then
  resolve via a new preload method.
- **Shared contract (`events.ts`):** one new IPC channel (`plugin:agent-history`) + a Zod schema
  with a bounded optional `limit` (like `PluginDataHistorySchema`, e.g. max 1000).
- **Main:** read the already-parsed transcript for the pane's conversation and project it into
  `tool_use`/`tool_result`/`result` `AgentEvent`s — the same projection the chat's transcript
  restore already performs.

**Scope guard (invariant, PLUGIN_ARCHITECTURE):** conversation-scoped, like everything else on
the pane surface — no cross-conversation reach.

This one addition is reusable: `cost-dashboard` (#4), `attention` (#13), and `change-review` (#2)
all flag the same live-only limitation. Building `agent.history` for the timeline closes the
restore story for the whole observability tier.

---

## 6. Performance strategy

Event volume is the defining constraint (proposal calls out 500+ events; real sessions go higher).

- **Windowed virtualization.** The row list renders only the visible window (~60 rows) plus a
  small overscan, regardless of total. Fixed row height makes offset math O(1). This is what keeps
  a 5,000-event session smooth.
- **Bounded in-memory model.** The pane holds a **retention ring** of the most recent N events
  (default N≈5,000 **[extrapolation]**); older events fall off the _live_ buffer but remain
  fetchable via `agent.history` if the user scrolls to the top and requests "load earlier". A
  timeline is a debugging surface, not an archive — it doesn't need every event of a week-long
  conversation in RAM.
- **Lazy detail.** A row's full I/O (potentially large diffs/outputs) is fetched/expanded only on
  click, never rendered up-front. The collapsed row stores just the _summary target string_ and
  duration, not the whole payload — so the resident-set cost per row is tiny.
- **Coalesced repaints.** Incoming events during a burst are batched into a single frame update
  (requestAnimationFrame / microtask flush) rather than one React render per event, so a parallel
  tool-use storm doesn't thrash.
- **Subagent subtrees collapsed by default** past a size threshold (§2) — a 200-call subagent is
  one row until expanded.
- **Duration is derived, not stored redundantly.** `tool_use.toolUseId` pairs with
  `tool_result.toolUseId`; duration = `result.receivedAt − use.receivedAt`, computed on arrival,
  stored as a number on the row.

---

## 7. Implementation milestones (ordered)

Each milestone builds, launches, and meets a demonstrable check before the next (per CLAUDE.md).

1. **Live-only skeleton on today's API.** A pane that subscribes via the existing
   `agent.onEvent` and `console.log`s live `tool_use` events — proves the permission gate and
   event shapes with zero host changes.
   1b. **HOST-GAP — `agent.history` backfill.** Runtime method + relay gate + IPC channel + Zod
   schema + main-side transcript projection (§5). Prerequisite for the restore contract, not for
   the live view.
2. **Static timeline render.** Mount, `agent.history()` to backfill, render rows (name/target/
   outcome/duration) with family colors. Pairs `tool_use`↔`tool_result` by `toolUseId`. No
   virtualization yet; test on a short session.
3. **Live follow + current-activity header.** Subscribe to `onEvent`, append rows, drive the
   header from open (result-less) `tool_use`s and `status`. Follow-pin + jump-to-live.
4. **Virtualization + retention ring.** Windowed list, batched repaints, bounded buffer,
   load-earlier. Verify smoothness at 500+ synthetic events.
5. **Expansion (click-to-expand full I/O).** Inline detail region; pretty-print input/output;
   Shiki/CodeMirror for code and Bash/diff; capped with "show more".
6. **Subagent tree.** Group `Task` calls; nest their children (via `task_activity` /
   `background`), collapsible; ancestor-aware filtering.
7. **Filters + persistence.** errors-only / by-tool / by-turn; persist view state to `storage`;
   restore on mount. Turn inference from `result` boundaries.
8. **Polish.** Slow/failure emphasis thresholds, repeat "×N" badges, empty/restore states, design
   tokens per DESIGN_SYSTEM.md, accessibility of color (never color-only — outcome also has a text
   badge).

---

## 8. Risks / edge cases

- **The event stream has no explicit turn id.** Turn boundaries and "by turn" filtering are
  _inferred_ from `result` events. If the SDK interleaves oddly (parallel work, resumed sessions,
  branch switches), turn attribution can be fuzzy. Mitigation: treat turn as a best-effort grouping
  label, never as load-bearing state; fall back to timestamp buckets.
- **`tool_result.output` may be host-capped.** The expand view is only as complete as the stream
  delivers; a truncated output must be clearly marked as truncated (not silently shown as the
  whole result).
- **Subagent event fidelity.** Subagent activity arrives as `task_activity` (`TaskItem`: text/
  thinking/tool_use/tool_result) keyed by `taskId`, and `background` gives the running set. These
  are _simplified_ (no `messageId`, no streaming index) — the subtree may be lower-fidelity than
  the top-level trace. Design the tree to tolerate that (fewer fields on child rows).
- **Mount races.** A pane mounted mid-run sees live events plus a `history()` backlog; the two can
  overlap. De-dupe by `toolUseId` (and by a monotonic arrival index for non-tool events) so a
  boundary event isn't double-listed.
- **Restore correctness.** Per §8 of PLUGIN_API, the pane must rebuild fully from `storage` +
  `history` on every mount, with no reliance on retained DOM/runtime. A reopened conversation whose
  history is unavailable must degrade to an empty timeline with a clear "no trace available"
  state, not an error.
- **High-frequency bursts.** Parallel tool use + streamed text deltas can flood; batched repaints
  (§6) and _not_ rendering text deltas as rows (only tool calls are rows) keep it bounded.
- **`agent:read` not yet enforced.** Until the host enforces the permission (§5), a pane that
  forgot to declare it could still receive events; the gap work must include enforcement, not just
  delivery.
- **Color accessibility.** Family color must never be the sole signal (outcome badge is text;
  failures also get a border). Respect DESIGN_SYSTEM tokens and any reduced-motion setting for the
  spinner.

---

## 9. Acceptance criteria

The plugin is done when, on a real session:

1. **Live trace.** Running a turn that calls Read/Grep/Edit/Bash produces one correctly-colored,
   correctly-labeled row per tool call within a frame or two of the call, each showing name,
   target, duration, and ok/error.
2. **Current activity.** During a long single tool call, the header shows the live verb + target +
   ticking elapsed and a spinner; when the agent goes idle the header shows the last-turn summary
   and the spinner stops.
3. **Failures + slow calls are loud.** An erroring Bash renders visually distinct (border/tint +
   ERR badge); a call over the slow threshold shows a bold duration.
4. **Expansion.** Clicking a row reveals the full input and output (or a marked-truncated view),
   with code/diffs syntax-highlighted.
5. **Subagent tree.** A `Task` renders as an expandable subtree of its child calls; collapsed by
   default past the size threshold.
6. **Filters.** errors-only, by-tool, and by-turn each correctly scope the visible rows without
   losing retained data; filter state survives a pane reload.
7. **Density/perf.** A session (or synthetic feed) of 500+ events scrolls smoothly with only a
   windowed subset in the DOM; follow-pin auto-scrolls and unpins on manual scroll-up.
8. **Restore.** Close the conversation and reopen it: the timeline rebuilds from the host backlog
   and the last-used filters; nothing depends on retained DOM/runtime; an unavailable history
   degrades to a clean empty state.
9. **Capability hygiene.** The pane functions with only `agent:read` + `storage`; it declares and
   uses no other permission, contributes no tools, and pins no context. The host rejects an
   `agent`-stream call from a pane that did not declare `agent:read`.
