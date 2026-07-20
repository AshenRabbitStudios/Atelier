# cost-dashboard — design

Per-conversation cost attribution: cumulative dollars, per-turn stacked token bars
(input / output / cache-read), burn rate, expensive-outlier detection, and a soft budget
line the agent also sees via context. **Status: design** (not built). Tier: **T1**.

This doc is grounded in the current code and contract:

- Pitch: `docs/plugin-proposals/PROPOSALS.md` §4.
- Contract: `PLUGIN_API.md`, `docs/PLUGIN_ARCHITECTURE.md`, `docs/CONTEXT_SYSTEM.md`.
- Host data today: `electron/shared/events.ts` (`AgentEvent` union),
  `electron/agent/AgentManager.ts` (token accounting + `result` emission),
  `electron/agent/usage.ts` (account-window rollover).

Claims that go beyond what the code currently does are marked **[EXTRAPOLATION]**. The one
capability the plugin genuinely cannot get from today's contract is flagged under
**HOST-GAP** with a concrete proposed API.

---

## 1. Purpose + user stories

**Purpose.** Opaque token burn is a top-3 recurring complaint (PROPOSALS.md §Research). The
existing account meter (`UsageInfo` windows, rendered as header bars) answers "how much of my
plan have I used" — an account-wide percentage. It cannot answer the question people actually
ask mid-session: _what in **this** conversation is costing me, and why?_ Attribution, not
totals, is the feature. Where the money went — which turn, which tool loop, cached vs. fresh —
is what lets a human (or the agent) change behavior before the bill, not after.

**User stories.**

1. _As a user watching a long agentic run_, I see cumulative cost tick up live and a per-turn
   bar chart, so a turn that costs 5× the others is immediately visible.
2. _As a user_, I can tell at a glance how much of each turn was **fresh input** vs.
   **cache-read** (cheap) vs. **output**, so I know whether prompt caching is actually working
   or my context is being re-billed every turn.
3. _As a user_, I get an **outliers** list: "Read of `bundle.js` (14k tokens) repeated 3×",
   "Bash retry loop, 11 calls, same command" — the doom-loops that quietly drain the budget.
4. _As a user_, I set a **soft budget** ($ per conversation). When the run approaches it, I get
   a visible warning **and the agent sees it too** (via a pinned context export) so it can
   economize (stop re-reading a 3k-line file) instead of me discovering the overrun later.
5. _As the agent_, on each turn I see my own running cost and remaining budget as a context
   block, framed as prior notes, so "you are at $4.20 of a $5.00 budget" changes my next move.
6. _As a user_, I close the conversation and reopen it days later; the cost history and budget
   are intact (PLUGIN_API §8 restore contract).

---

## 2. Panel UX

A `defaultDock: "bottom"` panel (cost is a footer concern, not a primary workspace). Three
stacked regions, all rendered with the plugin's own charting (Canvas/SVG — the pane is
content-unbounded, PLUGIN_API §1). No external chart lib is required; simple stacked bars and
a running total are hand-drawable, which keeps the bundle small and the sandbox self-contained.

**A. Header strip — the always-visible summary.**

- **Cumulative cost** for the conversation (large, `$X.XX`), plus a small session-so-far
  duration and turn count.
- **Burn rate**: dollars-per-minute over a trailing window (e.g. last 5 turns), shown as a
  small number + sparkline. Rate is derived, see §6.
- **Budget gauge**: a horizontal bar `spent / budget` with a threshold marker. Turns amber at
  the warn threshold, red past budget. Clicking it opens the budget config (region C).

**B. Per-turn stacked bar chart — the attribution core.**

- X axis: turns (most recent on the right; horizontal scroll for long sessions).
- Each bar is a **stack** of three segments, using DESIGN_SYSTEM token colors:
  - **input** (fresh prompt tokens — billed full rate),
  - **cache-read** (re-served context — billed at the cheap rate; visually distinct/muted),
  - **output** (generation — billed the most per token).
- Bar **height** is dollars (so an expensive turn is literally tall), with a toggle to switch
  the axis to raw tokens. Because output and cache-read have very different per-token prices,
  a token-height view and a dollar-height view tell different stories — both are useful, so
  offer the toggle rather than pick one.
- Hover a bar → tooltip: turn index, `$` cost, the three token counts, top tool by token cost
  in that turn, duration.
- Click a bar → filters the outlier list (region below) to that turn.

**C. Outliers list — the "why".**

A ranked list (most expensive first) of flagged events for the conversation:

- **Doom-looped tool retries**: the same tool + near-identical input invoked N times in a
  short window (e.g. a Bash command retried 5×, an Edit that keeps failing its match).
- **Giant reads**: a single `Read`/file-load tool result whose size (tokens, estimated)
  exceeds a threshold, especially if repeated.
- **Runaway turn**: a turn whose cost exceeds K× the session median.

Each row: icon (tool family), one-line description, count, estimated token/$ cost, and a
"jump" affordance (scrolls the bar chart to the owning turn). Rows are advisory — this panel
never mutates the run; it only observes and reports.

**D. Budget config (inline, collapsible).**

- **Budget ($)** number input — the soft cap for this conversation.
- **Warn at (%)** — threshold for the amber state and the first context nudge (default 80%).
- **Inject budget into agent context** toggle (on by default) — controls whether the budget
  export is pinned (§5). When off, the panel is purely a viewer.
- A **"Usage instructions"** `<details>` footer (the author-guide mechanism from
  CONTEXT_SYSTEM.md §Per-section author guide) lets the user write a fixed instruction for how
  the agent should treat the budget ("hard-stop and ask me before exceeding", "just be frugal").

All of B/C/D rebuild from `storage` on mount (treat every mount as a restore, §8).

---

## 3. Manifest sketch

Matches the schema in `PLUGIN_API.md` §1 (fields, permission names) and the
`contextExports` shape from `PLUGIN_ARCHITECTURE.md` §2 / `CONTEXT_SYSTEM.md`. `permissions`
are least-privilege: `agent:read` to observe the event stream, `storage` to persist history,
`context` to push the budget export.

```jsonc
{
  "id": "cost-dashboard",
  "name": "Cost Dashboard",
  "version": "0.1.0",
  // wallet/receipt line-icon, viewBox 0 0 16 16, single path, stroke currentColor
  "icon": "M2 4.5h12v7H2zM2 4.5 8 8l6-3.5M11 8.5h2",
  "kind": "panel",
  "entry": "index.html",
  "permissions": ["agent:read", "storage", "context"],
  "defaultDock": "bottom",
  "contextExports": [
    {
      "key": "budget",
      "label": "Conversation cost & budget",
      "format": "markdown",
      "maxTokens": 200
    }
  ]
}
```

Notes on the manifest:

- **No `backend`, no `tools`.** The panel needs no privileged child process and contributes no
  agent tools — everything it needs is observation (`agent:read`) plus the generic context
  export mechanism. This keeps it fully hot-reloadable with zero child-process lifecycle.
- **`context` permission.** `PLUGIN_ARCHITECTURE.md` §2 introduces `context.update` behind a
  `"context"` permission. `CONTEXT_SYSTEM.md` describes the built path as `atelier.context.get/
set(key, value)` on the same storage. This plugin only ever _writes_ the `budget` export
  (it's a host-computed summary, not user-edited prose), so it uses the set/update path. See §5.
- **`contextExports.maxTokens` is tiny (200)** — the budget block is two or three lines; it must
  never bloat context (`PLUGIN_ARCHITECTURE.md` "Don't let pinned context be unbounded").

---

## 4. Data flow — where cost/token data lives and how it reaches the pane

### What the host produces today (confirmed in code)

Per-turn, `AgentManager` emits `AgentEvent`s (`electron/shared/events.ts`):

- **`kind: 'result'`** — `{ costUsd?, durationMs?, isError }`. `costUsd` is the SDK's
  `total_cost_usd` (`AgentManager.ts` ~L1270). Per the SDK this is the **cumulative** cost of
  the session/turn as the SDK reports it, in USD. This is the authoritative dollar figure.
- **`kind: 'tokens'`** — `{ output, input? }`, emitted live during the turn
  (`emitTokens`, `AgentManager.ts` ~L1336). `turnInputTokens` sums `message.usage.input_tokens`
  across the turn's assistant messages; `output` is the rolling `output_tokens` from
  `message_delta`. This is the live token counter.
- **`kind: 'tool_use'`** — `{ toolUseId, name, input }` and **`kind: 'tool_result'`** —
  `{ toolUseId, ok, output }`. These are the raw material for outlier detection (retry loops,
  giant reads).
- **`kind: 'system_init'`** — `{ model, ... }`, so the panel knows the model in play.

### How a sandboxed pane reaches it today

A plugin with `agent:read` calls `atelier.agent.onEvent(cb)` (PLUGIN_API §3;
`electron/plugin/runtime.ts` L91). The host forwards **this conversation's** `AgentEvent`
stream — the same union the chat consumes, explicitly including `tool_use`/`tool_result`/
`result`/`error` (confirmed in `pluginAuthoringGuide.ts` L93–95 and `runtime.ts` L89–90). So
the panel can observe `result` (dollars) and `tokens` (input/output) and the tool events live,
with **no new host wiring for those**. It persists a rolling per-turn ledger to `storage`
(scoped `(conversation, plugin)`), so it survives reload/close/reopen.

Flow:

```
SDK stream ──▶ AgentManager (token accounting, total_cost_usd)
                   │  emits AgentEvent (result / tokens / tool_use / tool_result)
                   ▼
             agent.onEvent  ── postMessage RPC ──▶  cost-dashboard pane (agent:read)
                                                        │  aggregate per turn
                                                        ├─▶ storage.set  (durable ledger)
                                                        └─▶ context.update('budget', md)  (§5)
```

### HOST-GAP: the cache-read / cache-creation token breakdown

**The gap.** The pitch requires a **stacked** input / output / **cache-read** bar, and honest
cost attribution needs to separate cheap cache-read tokens from full-price fresh input. But the
host today captures only `input_tokens` and `output_tokens`:

- `AgentManager.ts` L154/156 types the stream `usage` as `{ input_tokens?, output_tokens? }`
  and reads only those two fields.
- The `tokens` `AgentEvent` (`events.ts`) carries only `{ output, input? }`.

The Anthropic message `usage` object also reports `cache_read_input_tokens` and
`cache_creation_input_tokens` **[EXTRAPOLATION — standard fields on the Anthropic
`Usage`/`message_start` payload; must be confirmed against the live SDK reference per CLAUDE.md
"Before you write any session/agent code" and recorded in `docs/SDK_NOTES.md`]**. The SDK is
almost certainly already surfacing them on the same `message.usage` the code reads for
`input_tokens`; the host just discards them. Without them the cache-read segment cannot be
drawn and the cost split is dishonest.

**Proposed API (minimal, additive — no new permission).** Extend the existing `tokens` event
with two optional fields, and populate them in the same place `input_tokens` is read:

```ts
// electron/shared/events.ts — extend the existing 'tokens' AgentEvent variant
| {
    instanceId: string
    kind: 'tokens'
    output: number
    input?: number
    cacheRead?: number      // NEW — cumulative cache_read_input_tokens for the turn
    cacheCreation?: number   // NEW — cumulative cache_creation_input_tokens for the turn
  }
```

```ts
// electron/agent/AgentManager.ts — StreamEvent.message.usage gains the two fields;
// message_start accumulates them alongside turnInputTokens; emitTokens() forwards them.
```

Optional (nice-to-have, still additive): also thread `cacheRead`/`cacheCreation` onto the
`result` event so a turn's _final_ cache split is authoritative rather than reconstructed from
the last live `tokens` frame. Both are backward-compatible (optional fields; existing consumers
ignore them). This is the only host change the plugin needs; everything else is already exposed.

**Fallback if the fields are unavailable.** If the SDK does not surface cache tokens on the V1
`query()` stream, the panel degrades gracefully: it draws a two-segment bar (input / output)
and labels cache-read "unavailable" rather than faking a split — honesty over completeness (§8).

### A note on `costUsd` precision vs. token estimation

Dollars come from the SDK's `total_cost_usd` (authoritative, includes the vendor's own cache
pricing). Per-**tool** and per-**outlier** dollar figures, however, are **estimates** the
plugin computes from token counts × per-model rates (the SDK gives a turn total, not a
per-tool split). The panel must label estimated figures as such (see §6, §8). Model unit prices
would live in a small table in the plugin **[EXTRAPOLATION — the plugin ships its own price
table; it is not in the host today. The `claude-api` skill is the reference source of truth for
current model pricing.]**.

---

## 5. Budget → agent-context feedback loop

This is the "agent sees the budget too" half of the pitch, and it rides the existing context
primitive exactly (`CONTEXT_SYSTEM.md`; `PLUGIN_ARCHITECTURE.md` §2) — no bespoke plumbing.

1. The panel declares one `contextExports` entry, `budget` (§3). Because it's a context export
   of an enabled plugin, enabling the plugin **auto-pins** it (CONTEXT_SYSTEM.md §How they come
   together) and disabling un-pins it.
2. Whenever the running cost changes (each `result` event) the panel recomputes a compact
   markdown block and pushes it with `atelier.context.set('budget', md)` (the write path from
   CONTEXT_SYSTEM.md §3.3; `PluginContextSetSchema` in `events.ts`). Example value:

   ```
   Conversation cost so far: $4.18 of a $5.00 soft budget (84% — approaching limit).
   Burn rate ~ $0.31/min. Cache is serving 71% of input tokens.
   Note: you are near budget — prefer edits over full re-reads; avoid re-reading large files.
   ```

3. The host injects the latest value of every pinned export into a framed
   `<atelier-context>…</atelier-context>` block **on every turn**, stripped from the displayed
   transcript (CONTEXT_SYSTEM.md §1). So the agent always sees the **current** budget state,
   refreshed each turn — not a stale paste.
4. The optional **usage guide** (`guide:budget`, written via the generic `storage` API,
   CONTEXT_SYSTEM.md §Per-section author guide) lets the user fix the _policy_ the agent applies
   to the number ("hard-stop and ask before exceeding" vs. "just be frugal"). It's injected in
   the same block, framed as author instructions the agent cannot edit.

Because the budget block is a host-framed, ephemeral, per-turn injection (never editable
transcript content — `PLUGIN_ARCHITECTURE.md` "Don't put pinned context into the editable
transcript"), it stays fresh and never pollutes history. The **set of pins** persists in the
conversation manifest; the **snapshot** is re-pushed by the plugin on `load` from its `storage`
ledger (rebuild-on-mount).

Deliberately **soft**: the plugin has no way to halt the agent, and this design does not add
one. It informs; the agent (and the user's guide policy) decide. A hard stop would need a
permission/enforcement path this contract intentionally does not give plugins.

---

## 6. Attribution methodology (honest mapping)

The governing principle: **dollars are authoritative, splits are estimates, and the UI must not
blur the two.**

- **Per-turn dollars — authoritative.** Use the SDK `total_cost_usd` delta between consecutive
  `result` events as the turn's true cost. (If `total_cost_usd` is cumulative, turn cost =
  current − previous; if per-turn, use it directly — **confirm which against the SDK and record
  in `docs/SDK_NOTES.md`** before building, per CLAUDE.md.)
- **Per-turn token split — from `tokens`/`result`.** input / cache-read / output come from the
  usage fields (§4 HOST-GAP). The stacked bar uses these directly; no estimation needed for the
  _token_ view.
- **Per-turn dollar split across segments — estimated.** To draw the bar in _dollars_, multiply
  each segment's tokens by that model's per-token rate (fresh-input, cache-read, cache-write,
  output rates differ). Rates from the plugin's price table (§4). The sum of segment estimates
  is then **rescaled to match the authoritative `total_cost_usd`** for the turn, so the bar's
  total is always the true dollar figure and only the _internal proportions_ are estimated. This
  keeps the headline number honest while still showing where it went.
- **Per-tool attribution — estimated, and honestly bounded.** The SDK does not report tokens
  per tool call. The panel approximates a tool's cost by the **token size of its result**
  (a `tool_result` output's estimated token count × input/cache rate) plus a share of the
  turn's output. Every per-tool figure is labeled "≈". This is enough to rank outliers
  truthfully without pretending to a precision the data doesn't support.
- **Cache accounting.** Cache-**read** tokens are counted as cheap input (correct — they're
  billed at the reduced read rate). Cache-**creation** (write) tokens are billed _above_ normal
  input for one turn, then pay off on later reads; the panel shows cache-creation as its own
  (small) segment or folds it into input with a note, but never double-counts a token as both
  fresh input and cache-read — the usage fields are already mutually exclusive buckets.
- **Burn rate.** Dollars over wall-clock across a trailing window of turns, using each
  `result`'s `durationMs` (or the gap between `result` timestamps) as the time base. Idle time
  between turns is excluded (rate is cost-per-active-minute) to avoid a rate that decays to zero
  while the user thinks.
- **Session total.** Sum of authoritative per-turn dollars, persisted in `storage`, so it is
  stable across reload and does not depend on replaying the event stream.

Token→size estimation for tool results uses a cheap heuristic (≈4 chars/token) **[EXTRAPOLATION
— rough constant; acceptable for ranking outliers, not for billing]**; the `claude-api` skill's
token-counting guidance is the reference if a precise count is ever wanted.

---

## 7. Implementation milestones (ordered)

Depends on the plugin host + `agent:read` + `context` machinery from Phases P3/P4
(`PLUGIN_ARCHITECTURE.md` build order). Assuming those exist:

1. **M1 — Ledger + cumulative cost (viewer only).** Manifest (`agent:read`, `storage`), pane
   subscribes `agent.onEvent`, aggregates `result.costUsd` per turn into a `storage` ledger,
   renders the header strip (cumulative $, turn count, duration). Rebuilds from `storage` on
   mount. _Acceptance: run a few turns, close/reopen — cumulative cost is correct and survives._
2. **M2 — Per-turn bar chart (token view).** Render stacked bars from `tokens`/`result` input +
   output (two segments; cache-read pending M3). Hover tooltip, click-to-select. Token/$ axis
   toggle (dollar view lands with M3's rescale).
3. **M3 — Cache-read segment (needs HOST-GAP).** Land the `tokens`/`result` `cacheRead`/
   `cacheCreation` fields in the host (§4), confirm against SDK in `docs/SDK_NOTES.md`, draw the
   third segment, implement the dollar-rescale attribution (§6). Graceful degrade if unavailable.
4. **M4 — Burn rate + sparkline.** Trailing-window cost/active-minute, header sparkline.
5. **M5 — Outlier detection.** Consume `tool_use`/`tool_result`; detect retry loops (same
   tool+input N×), giant reads (result size threshold), runaway turns (K× median). Ranked list
   with jump-to-turn. All figures labeled "≈".
6. **M6 — Budget config + context feedback loop.** Budget/warn inputs persisted to `storage`;
   `contextExports.budget` + `context.set` on each `result`; gauge amber/red states; the
   `guide:budget` author-instruction footer. _Acceptance: agent's transcript-stripped context
   shows the live budget block; crossing the threshold flips the gauge and updates the export._

M1–M2, M4–M5 need **no host change**. Only **M3** requires the HOST-GAP field; the plugin is
useful and shippable without it (two-segment bars), so it need not block the rest.

---

## 8. Risks

- **Cost-data accuracy.** `total_cost_usd` semantics (cumulative vs. per-turn; whether it
  reflects subscription/OAuth billing at all) must be pinned down against the SDK — if a user is
  on a subscription rather than API-key billing, `total_cost_usd` may be zero or notional. The
  panel must detect that (via `system_init` `apiKeySource` / `AuthStatus.usingSubscription`) and
  switch to a **tokens-only** presentation with a clear "no dollar figure on this plan" note,
  rather than showing `$0.00` as if the session were free. **[EXTRAPOLATION — subscription
  billing behavior of `total_cost_usd` must be verified.]**
- **Double counting.** Two hazards: (a) replaying the event stream on reload would double the
  ledger — avoided by persisting aggregated per-turn rows keyed by `messageId`, and treating
  `onEvent` as _append-if-new_, never _re-sum-from-scratch_. (b) Counting a token as both fresh
  input and cache-read — avoided because the usage buckets are mutually exclusive (§6).
- **Subagents.** A `Task`/subagent's tokens and cost may or may not roll into the parent's
  `total_cost_usd`. If they roll in, per-turn attribution to the _parent_ turn is correct but
  the outlier list may mis-locate the spend (it happened inside a subagent, invisible to
  `tool_use` on the main stream). The panel should attribute subagent cost to the spawning
  `Task` tool_use block and label it "(includes subagent work)" rather than pretend it was the
  parent turn's own reads. If subagent cost is _not_ in the parent total, the panel undercounts —
  it must state that limitation rather than silently drop it. **[EXTRAPOLATION — subagent cost
  rollup behavior must be confirmed against the SDK; record in `docs/SDK_NOTES.md`.]**
- **Estimated per-tool/per-outlier figures** could be mistaken for exact billing. Mitigation:
  every estimated figure carries "≈"; the authoritative total is the only unqualified dollar
  number.
- **Context bloat from the budget export.** Bounded by `maxTokens: 200` and the host's truncate
  marker; the export is two/three lines by construction.
- **Event-stream gaps.** `onEvent` only delivers events for turns that ran while the pane was
  mounted; if the pane was closed for some turns, the ledger has holes. Mitigation: the ledger
  is the persisted source of truth and the header total is derived from it; a closed-pane turn
  simply isn't itemized (the account total is unaffected). Document this as a known limitation
  rather than trying to backfill from a transcript re-parse in v1.

## 9. Acceptance criteria

1. Enabling the plugin on a conversation mounts a bottom pane showing cumulative conversation
   cost that updates live as turns complete.
2. The per-turn bar chart renders one stacked bar per turn with input / output segments (and a
   cache-read segment once the HOST-GAP field lands), hover tooltips, and click-to-select.
3. Closing and reopening the conversation restores the full cost history and budget config from
   `storage` alone (no re-run needed) — the restore contract (PLUGIN_API §8).
4. The outliers list flags a deliberately-induced doom loop (e.g. a Bash command retried 5×) and
   a repeated giant file read, ranked by estimated cost, each jumping to its turn.
5. Setting a budget and crossing the warn threshold turns the gauge amber and updates the
   `budget` context export; the agent's per-turn injected context shows the current spend/budget
   line (verifiable via the transcript-stripped context block).
6. On a subscription/no-dollar plan the panel shows a tokens-only view with an explicit note,
   never a misleading `$0.00`.
7. Every estimated figure (per-tool, per-outlier) is visibly marked "≈"; the authoritative
   cumulative dollar total is not.
8. No host change is required for criteria 1–5's token/dollar totals except the additive
   `cacheRead`/`cacheCreation` fields (§4 HOST-GAP), and the plugin degrades gracefully without
   them.
9. A malformed budget input or a burst of events never throws into the host; the pane isolates
   its own errors (PLUGIN_API §2 fault-containment).
