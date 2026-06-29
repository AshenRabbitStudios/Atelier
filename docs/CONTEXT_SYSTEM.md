# CONTEXT_SYSTEM.md — agent working-memory plugins

How the **mental-model**, **working-memory**, and **plan** plugins (and any future
context-document plugin) work, and how they come together. High-level; the normative plugin
contract is PLUGIN_API.md / PLUGIN_ARCHITECTURE.md, the visual rules are DESIGN_SYSTEM.md.

## The idea

Three (or more) docked panes hold the agent's persistent working state for a conversation:

- **Mental model** — a freeform canvas of how the agent understands the system it's working on.
- **Working memory** — 10 slots of things to keep recursing on / pick back up later.
- **Plan** — the high-level A→B path, updated as the work moves.

The point: **clear the chat often** to cut drift and tokens, and these three carry your state
across the reset. After a clear, the next turn re-injects them, so the agent resumes with its
model/memory/plan intact but without the bulky prior transcript.

## The one primitive that powers all three: a "context document"

A plugin declares **context exports** in its manifest. Each export is one named, themeable
document the system treats specially:

```jsonc
"contextExports": [
  { "key": "model", "label": "Mental model", "format": "markdown", "maxTokens": 1800 }
]
```

For every export of an **enabled** plugin, the host does three things automatically — no
per-plugin backend code:

1. **Reads it into context every turn.** On each user turn the host prepends the current value
   of every pinned export as a framed `<atelier-context>…</atelier-context>` block to the
   message sent to the model (stripped from the displayed transcript, so editable history stays
   clean). The agent always sees its latest model/memory/plan, labeled as its own prior notes.
2. **Gives the agent a tool to update it.** The host auto-registers an in-process MCP tool per
   export (`set_<plugin>__<key>`, content = the full new value). When the agent calls it, the
   host writes the value to the conversation's plugin storage. The agent "pushes changes" this
   way; the handler runs in the **main process on storage**, so it works whether the pane is
   open or closed.
3. **Lets you edit it.** The pane reads the value via `atelier.context.get(key)` and writes your
   edits via `atelier.context.set(key, value)`. Same storage the agent's tool writes, so you and
   the agent share one document.

## Persistence (meets all the stated requirements)

The value lives in the conversation's plugin storage: `…/conversations/<id>/plugins/<plugin>/
storage.json` under a `ctx:<key>` key. Therefore it is:

- **Not cleared by "Clear chat"** — that only resets the SDK session/transcript, never plugin
  storage.
- **Persisted across app restarts** and across the **plugin being opened/closed** — storage is
  on disk; the pane rebuilds from it on every mount (treat each mount as a restore).
- **Per-conversation** — conversation A's model is invisible to B.

There is a separate **"Clear plugins"** action if you ever want to wipe them deliberately.

## How they come together

```
   you edit ─┐                          ┌─ injected every turn ─▶ the agent
             ▼                          │
        [ plugin pane ] ◀── get/set ──▶ [ context storage (ctx:<key>) ] ◀── set tool ── the agent
             ▲                          │
   poll to refresh ◀───────────────────┘  (agent updates show up in the pane)
```

- The agent **reads** all three each turn (context injection) and **writes** any of them via
  their tools — it manages all three when they're open (and can still update closed ones).
- You **read** them in their panes and **edit** them directly when the agent's wrong.
- Enabling a context-document plugin **auto-pins** its exports (no separate pin step); disabling
  un-pins. Token use is bounded per export by `maxTokens` (host truncates with a marker).

## Token budget & the workflow it enables

Each export caps its injected size (`maxTokens`, default ~1500). The intended loop:

> work a while → update mental model / plan / memory via tools → **clear chat** → next turn
> re-injects the compact state → keep going with low tokens and no accumulated drift.

## Beyond the three (same primitive)

Anything the agent should "see and maintain" is another context-document plugin: a **diagram**
plugin (the export is Mermaid source the agent edits; the pane renders it for you), a **decision
log**, a **data table** the agent reads/writes. They all reuse the exact mechanism above —
declare `contextExports`, get injection + an update tool + a pane for free.

## Build status

The shared infrastructure (context store, host `context` API, per-export tool generation,
per-turn injection + display-stripping, auto-pin) is built in the main process; the panes are
small token-only frontends. See docs/MORNING_REVIEW.md for autonomous decisions to vet.
