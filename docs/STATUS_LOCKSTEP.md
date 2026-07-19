# Status lockstep — why the busy indicator lies, and the design that makes it unable to

Written 2026-07-18 after live forensics on a wedged conversation ("Ouija": activity row
showed `Running Write…` + a 284-minute elapsed clock, ~4.7 h after the turn finished).
This is the third iteration on this bug; the first two (a0681f7 `hasPending()`, aaf5a5d
`turnsInFlight`) failed for the same structural reason, so this doc first states why the
current shape cannot be made truthful by patching, then the replacement design.

## 1. Live evidence (Ouija, 2026-07-18)

- Session `d62d98f1…` (cwd `G:\…\Knobs\Ouija`): exactly ONE user prompt (20:05:00Z).
  Transcript ends cleanly: tool_use → tool_result → thinking → final text at 20:14:20Z.
  The turn completed normally. No queued sends, no interrupt, no fork.
- Conversation manifest `updatedAt` = 3:14:20 PM local — the same second as the final
  text. The only plausible `onChange` at that instant is the `result` handler
  (AgentManager.ts:1172), so a `result` was almost certainly processed.
- 4.7 hours later the UI still shows working (`Running Write…` = last block is a Write
  tool_use whose result never reached the view — ChatPanel.tsx:870), elapsed anchored
  ~3:05–3:10 PM.

Two hypotheses fit, and **we cannot discriminate them from disk because the system has no
status introspection** (itself a finding):

- H1 (main-side): `turnsInFlight` was leaked ≥ +1 before the result, so the decrement at
  AgentManager.ts:1170 left it > 0 → `setStatus('working')` at 1171. The leak survives
  forever; every later turn also ends "working".
- H2 (renderer-side): main went idle correctly, but the view store missed the one `status`
  push — and a missed push is now PERMANENT, see B2.

Discriminating experiment (also the unstick recipe): send a trivial message into the
wedged conversation. If the header goes idle after the reply → H2 (any fresh status event
heals a missed push). If it stays working → H1; then toggle any plugin (rebind →
counter := 0, session resumes) and send once more → idle.

## 2. Why the current design cannot be truthful

Status is **edge-triggered inference**: a stored field (`status`) plus a hand-maintained
counter (`turnsInFlight`, AgentManager.ts:211) mutated at scattered sites — increment at
send (903) and fork (596), compensations at result (1169–1170), rate-limit (1184), and
rebind (521). There is no invariant anyone can check, no way to observe the facts behind
the answer, and no reconciliation: **one missed or double-counted transition is a
permanent lie**. `Math.max(0, …)` (1170) silently eats under-counts, so even the errors
are invisible. Each iteration patched one path; the next unknown path wedges it again.

Concrete defects found (each sufficient to produce the symptom class):

- **B1 — rebind paths never re-derive status.** `setEffort` (798), `setPluginEnabled`
  (325), `switchBranch` (605), `saveEdit` (580), `setPermissionMode` fallback (738) all
  `rebind()` — which kills a live turn (its result will never come) and zeroes the
  counter, but **never touches `status`**. Any of these mid-turn ⇒ `working` forever.
  (This is the previously-carried "P2 rebind-path inconsistency", now confirmed live.)
- **B2 — renderer hydrate is once-per-store-lifetime.** aaf5a5d's fix hydrated on every
  panel (re)mount; the view-store refactor moved hydration to store CREATION only
  (conversationViewStore.ts:143–152). Panels are now disposable views over a store that
  is never re-synced, so any missed `status` push is permanent — tab switches no longer
  heal it. A regression of the exact aaf5a5d guarantee.
- **B3 — instruction-change rebind inside `send()`** (913) kills a running turn silently
  (no error, no result) when a message is queued behind an active turn.
- **B4 — sends↔results 1:1 is an unverified assumption.** The CLI drains the input queue
  eagerly; a message queued mid-turn may be consumed as an interjection into the RUNNING
  turn (one result for two sends → +1 leak). Not Ouija's case, but the counter's
  correctness must not depend on an unverified CLI contract.
- **B5 — `emit()` inside state transitions.** `setStatus` emits; `rebind` emits
  background BEFORE zeroing the counter. A throwing emit (destroyed webContents) aborts a
  transition halfway, leaving the machine inconsistent.
- **B6 — no introspection.** Nothing can dump `turnsInFlight`/status facts at runtime, so
  every wedge is undiagnosable after the fact (this investigation had to be done from
  manifest timestamps and session JSONL).

## 3. The lockstep design

Principle: **level-triggered derivation, not edge-triggered inference.** Status is never
stored or assigned; it is a pure function of facts that each have exactly one writer.
Every consumer can re-derive it at any time; versioning removes ordering races;
reconciliation bounds the lifetime of any missed signal.

### Main process

1. **Turn ledger replaces the counter.** AgentManager holds its own pending queue and at
   most ONE `released` turn: the next message is handed to the SDK's InputQueue only
   after the previous turn SETTLES. Settlement points: `result`, pump error, stream end,
   interrupt (with a bounded grace timer — if the aborted result never arrives, force
   settle + rebind), rate-limit rejection, and `rebind()` itself (it owns the ledger
   swap, so rebinding without settling is structurally impossible → kills B1/B3).
   Sends↔turns become 1:1 BY CONSTRUCTION (kills B4), queued messages survive a rebind
   (carried over, not dropped with the old InputQueue), and the queue becomes visible to
   the UI (queued-message chips / cancel become possible later).
2. **Derived status, single writer.**
   `derive() = closed → 'closed' | wedged → 'error' | (released ∨ queue.length) →
'working' | 'idle'`. All `setStatus` call sites are deleted; mutators change facts,
   then call `sync()` = derive + emit-if-changed. Emission is stamped with a
   **monotonic `seq`**; `uiState()` carries the same `seq` plus the facts themselves
   (released turn id, queue depth, lastSdkEventAt).
3. **Watchdog (bounded staleness for unknown-unknowns).** While a turn is released:
   if `now − lastSdkEventAt > T_stall` AND no pending permission/question card, surface
   a distinct "stalled" state; after `T_kill`, settle-as-killed + rebind. T_stall must
   exceed the longest legitimate silent tool (Bash 10-min timeout) or key off hook
   activity (Pre/PostToolUse count as events).
4. **Emit isolation.** `emit` is wrapped (try/catch, never throws into a transition);
   fact mutation completes before any emission (fixes B5).

### Renderer

5. **Seq-gated application.** The store keeps the highest `seq` seen and ignores stale
   status/hydrate payloads — hydrate-vs-push ordering races become impossible.
6. **Repeatable resync (restores + strengthens aaf5a5d).** `hydrate()` runs: on store
   creation, on every ChatPanel mount, on window focus, and on a slow interval (~30 s)
   while status is `working`. Every path converges to main's derived truth; a missed
   push now has a bounded lifetime (fixes B2).

### Verification (what makes it "always")

7. Ledger + derive extracted as a pure module. Unit tests permute event orders
   (send / send-while-working / result / missing result / error / interrupt-no-result /
   rebind mid-turn / rate-limit) and assert the invariant:
   **status = 'working' ⟺ (released turn exists ∨ queue non-empty)** after every step.
8. A `result` arriving with no released turn logs a loud invariant breach (replaces the
   silent `Math.max` clamp) — future unknown paths announce themselves.
9. Debug IPC: dump the facts (seq, released, queue, lastSdkEventAt, status) per
   conversation — the introspection missing today (fixes B6).

### Migration order (small PRs, each green on its own)

1. Extract pure `TurnLedger` + `derive()` with the test matrix (no behavior change yet).
2. Swap AgentManager onto it; delete `turnsInFlight` + all `setStatus` sites; seq-stamp
   status + uiState; settlement in rebind/interrupt/rate-limit/pump paths.
3. Renderer: seq gating + repeatable resync (mount / focus / interval-while-working).
4. Watchdog + debug dump + invariant logging.

## 4. Concurrency & isolation (multiple conversations, tab switching)

- All new state (ledger, seq, facts, watchdog) lives per AgentManager instance — same
  scope as today's counter. No registry-level shared state enters the status path; each
  conversation keeps its own SDK query/process (architecture invariant 5). The ledger
  gates only its own input queue: one conversation's released turn never delays another.
- `seq` is per-instance monotonic; each renderer store compares only its own instance's
  seq, and resync pulls `uiState(instanceId)` into the store keyed by that id — A's
  status and B's status never meet, so cross-contamination is structurally impossible.
- Tab switching becomes a healing event: panel remount resyncs that instance; hidden
  conversations converge via focus/interval resyncs. Resync is idempotent (seq-gated),
  so a late/stale snapshot is ignored rather than applied.
- Implementation requirements: (a) watchdog timers cancelled on `close()` and guarded by
  `this.closed` (same pattern as `resumeTimer`) so a closed instance can't be rebound by
  a stray timer; (b) window-focus resync covers ALL open conversations' stores, not just
  the visible one, so a hidden wedged tab heals without being visited.

## 5. Deferred / explicitly out of scope

- Interjection-into-running-turn as a FEATURE (deliberate release into a live turn,
  marked as not expecting its own result) — possible later on top of the ledger.
- Queued-message UI (chips, cancel) — enabled by the ledger, not required for truth.
