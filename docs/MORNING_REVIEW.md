# MORNING_REVIEW.md — autonomous decisions to vet (2026-06-29 overnight)

Built the agent context-document system (mental-model / working-memory / plan plugins + the
shared P4 infrastructure) autonomously overnight. Everything is gate-green and CI-verified, but
the **runtime behavior is GUI-unverifiable headlessly** — the items below are real judgment calls
I made without you. Skim, keep or revamp.

## Decisions I made for you (vet these)

1. **Context injection = prepend-and-strip.** Each turn, the pinned exports are prepended to the
   user message sent to the SDK as a `<atelier-context>…</atelier-context>` block, and stripped
   from the displayed transcript on reload. Chosen over system-prompt injection (the `claude_code`
   preset prompt isn't cleanly appendable per-turn without a rebind) and over a separate synthetic
   turn. **Trade-off:** the block is re-sent every turn (token cost within a session) and lands in
   the on-disk JSONL (hidden from the UI). The whole design assumes you clear often, which bounds
   it. _If you'd rather it be a system prompt or only injected once per session, say so._

2. **Auto-pin + auto-tool from `contextExports`.** Enabling a context-document plugin
   automatically pins all its exports (injects them) and registers one `set_<plugin>__<key>` MCP
   tool per export. No manual "pin" step. _Alternative: explicit per-export pin toggles in the rail._

3. **One `set` tool per export (full replace), no `append`.** The agent resends the whole document
   (it has the current value in context). Keeps the tool surface tiny. _Working memory's 10 slots
   are one export the agent rewrites wholesale; if you want slot-level tools, that's a change._

4. **Panes poll `context.get` (~1.5s) to reflect agent updates.** I skipped a push-event channel
   to keep the wiring small and robust for an overnight build. Agent edits appear within ~1.5s.
   _If the latency bugs you, I'll add a push._

5. **Enabling/disabling a context plugin rebinds the SDK query** (to register/unregister its
   tools). Same `rebind` primitive used for effort changes; resumes the session so history is kept.

6. **Tool handler writes storage in the main process** (not the iframe), so the agent can update a
   doc even when its pane is closed.

7. **Extra plugins I added** (you said "be intelligent"): a **diagram** plugin (agent maintains
   Mermaid source as a context export; the pane renders it) and a **data-table** plugin (agent
   maintains CSV/JSON the pane renders as a sortable table). Both reuse the same primitive. _Drop
   either if unwanted._

8. **maxTokens defaults** per export: mental-model 1800, plan 1500, working-memory 1200, diagram
   1200, table 1500. Host truncates with a `…[truncated]` marker. _Tune to taste._

## What I could NOT verify (please spot-check in the app)

- Launch `npm run dev`, open a conversation, enable the three plugins from the rail.
- Ask the agent to "update your mental model / plan / working memory" — confirm the panes reflect
  it within ~2s, and that on the **next turn** the agent can recall what it wrote (injection works).
- Edit a pane yourself; confirm the agent sees your edit next turn.
- **Clear chat**; confirm the three panes keep their content and the agent still has it next turn.
- Quit + relaunch; confirm content persists. Toggle a plugin off/on; confirm content persists.
- Switch themes; confirm the panes reskin.

## Known limitations / follow-ups

- Token injection is per-turn (see #1). A "max-tokens" indicator in the rail isn't built yet.
- No manual pin/unpin UI (auto-pin only, see #2).
- The parallel sub-agents authored the plugin frontends to a fixed contract; if any pane looks off,
  it's a frontend-only fix.
- If `mcpServers` tool-name prefixing differs at runtime (`mcp__atelier_context__…`), the agent
  still calls them by description; confirm the tools appear.
