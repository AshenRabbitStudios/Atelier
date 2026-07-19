# 01 — Agent bridge: implement the spec'd-but-missing plugin contract

**Goal:** `PLUGIN_API.md` §3 promises `atelier.agent.{list,onEvent,send}`, `data.history`,
and `layout.onResize`; the manifest schema already carries the `agent:read` / `agent:send`
permissions. None of it is implemented (`runtime.ts` has no `agent` namespace; the
`PluginPane` relay has no `agent` branch; `DataBus` keeps only a last-value, no history).
This phase closes the spec↔implementation gap and unlocks the most valuable plugin class:
panes that _participate_ in the conversation (task boards that dispatch prompts, transcript
visualizers, cartographer observing block-events live).

## Current state (verified 2026-07-19)

- `electron/plugin/runtime.ts` — namespaces: `storage`, `layout` (dock/float/setTitle only),
  `context`, `data` (subscribe/unsubscribe/publish/readAsset), `browser`, `on`.
- `src/components/PluginPane.tsx:203-385` — relay handles the same set; no `agent`.
- `electron/plugin/DataBus.ts:50` — `last` map holds one value per channel.
- `electron/shared/plugins.ts:9-22` — `agent:read`, `agent:send` already in
  `PLUGIN_PERMISSIONS`.

## Design

### Scoping rule (record in DECISIONS.md)

A plugin observes and drives **only the conversation it is mounted in** — the one
`getConversationId()` returns. No cross-conversation reach (coupling-cleanliness intent #3;
also matches how storage/context/data are already scoped). `agent.list` therefore returns
only the current conversation's instance info (id, title, cwd, status), not all
conversations. If a legitimate multi-conversation dashboard need appears later, that is a
new permission, not a widening of this one.

### `atelier.agent` (runtime)

```js
agent: {
  // { id, title, cwd, status } for THIS pane's conversation. Needs "agent:read".
  info: function () { return call('agent', 'info', []) },
  // Subscribe to this conversation's AgentEvent stream (status, text deltas, tool_use,
  // tool_result, result, error — the same union the ChatPanel consumes). Needs "agent:read".
  onEvent: function (cb) { agentListeners.push(cb); return call('agent', 'events', [true]) },
  // Send a user message into this conversation, exactly as if typed. Needs "agent:send".
  send: function (text) { return call('agent', 'send', [text]) }
}
```

Note the rename `list` → `info` (single-conversation scope makes "list" a lie); update
PLUGIN_API.md §3 accordingly and note the deviation there.

### Relay (`PluginPane.tsx`)

- `agent`/`info` → gate `agent:read` → `window.atelier.agent.list()` filtered to
  `getConversationId()` (or add a dedicated preload method; filtering client-side is fine —
  the data is not sensitive, the scope rule is about coupling).
- `agent`/`events` → gate `agent:read` → set a flag; the pane already has an app-level way
  to observe events? It does not — add `window.atelier.agent.onEvent` (exists in preload,
  `preload.ts:55-61`) subscription inside the relay effect, filtered to
  `e.instanceId === getConversationId()`, forwarded into the frame as
  `{ __atelierEvent: true, event: 'agent', payload: e }`. **Only when the flag is set** —
  do not firehose every pane. Throttle nothing; the frame gets what the ChatPanel gets.
  Register `'agent'` in the runtime's `listeners` map.
- `agent`/`send` → gate `agent:send` → `window.atelier.agent.send(conv, text)` (existing
  preload method; existing `IPC.agentSend` handler — **no new IPC needed for send**).
- Main-side contract check: `agentSend` is a shared channel also used by the app itself, so
  the per-plugin permission cannot be checked in main for it without tagging the caller.
  Acceptable for now (renderer gate only) — note it in the phase's DECISIONS entry and in
  the ARCH_REVIEW P0 #1 retrofit as a known exception.

### `data.history`

- `DataBus`: replace `last: Map<string, unknown>` with a bounded ring buffer per channel
  (`history: Map<string, unknown[]>`, cap **200 entries per channel**, newest last; `last`
  behavior = last element). Replay-to-late-joiner (`DataBus.ts:83-86`) sends the last
  element as today.
- New IPC `pluginDataHistory` (`{ conversationId, pluginId, channel, limit? }` →
  `unknown[]`), permission `data:subscribe` (+ `net:fetch` for `url:` channels, same rule
  as subscribe). Runtime: `data.history(channel, limit)`.
- Memory note: 200 × (channels in use) values held in main. Bash-stream chunks are the
  worst case; acceptable. Do NOT persist history (SPEC leaves it ephemeral; a plugin
  needing durable history uses `storage` — PLUGIN_API §8 already says so).

### `layout.onResize`

Pure renderer: a `ResizeObserver` on `.plugin-pane-wrap` in the relay effect pushes
`{ __atelierEvent: true, event: 'resize', payload: { w, h } }` into the frame (debounce
~50 ms). Runtime: register `'resize'` in `listeners`; `layout.onResize(cb)` appends to it
and returns an unsubscribe. No IPC, no permission (a pane may always know its own size).

## Containment invariants

- A plugin's event callback throwing stays inside the frame (runtime already try/catches
  listener dispatch — keep that pattern for the new events).
- `agent.send` while the agent is working simply enqueues (TurnLedger semantics) — no new
  failure mode; do not add plugin-side special-casing.
- Event forwarding must not retain frames after unmount: subscription lives in the relay
  effect and is torn down in its cleanup (this is why Phase 0's PluginPane effect-stability
  fix is a prerequisite — otherwise every re-render duplicates/drops subscriptions).

## Acceptance criteria

1. A test plugin with `agent:read` renders the live status + streaming text of its
   conversation (event forwarding verified end-to-end).
2. The same plugin without the permission gets a rejected promise with the standard
   `permission "agent:read" not granted` message.
3. A plugin with `agent:send` sends a prompt; it appears in the transcript and runs
   normally; queueing while busy works.
4. `data.history('file:…', 50)` returns up to 50 prior values after several file edits;
   unit test on the DataBus ring buffer (cap, ordering, per-channel isolation,
   drop-on-close).
5. `layout.onResize` fires on pane resize/dock changes.
6. `pluginAuthoringGuide` documents all three additions; guide-sync test extended; gate
   green.
