# Design docs — default plugin suite

## User review 2026-07-20 — decisions

1. **Consolidation:** git-workbench + change-review + agent-timeline merge into ONE
   workspace-flow plugin with sub-tabs → [agent-flow](agent-flow.md) (build spec). Enabled by
   the main proc logging agent activity and exposing it (`agent.history`).
2. **workspace-explorer:** approved as designed ("read-only IDE interface") → build. Its
   HOST-GAPs (fs.list, composer-insert, openPath) are in [../HOST-ADDENDUM.md](../HOST-ADDENDUM.md).
3. **mission-control:** mostly duplicates the main chat; keep as T2 doc-only. See its addendum
   on what a plugin could still add given plugins only see what the host pushes.
4. **http-workbench:** approved in principle IF it integrates cleanly with the plugin
   architecture; stays T2, not in tonight's build set.
5. **attention → [notifications](notifications.md):** rescoped to channels-first (webhooks,
   Telegram, ntfy, Pushover + OS toast) with an agent-callable `notify_user` tool → build.
   Cross-conversation watching stays a stretch tier.
6. **New: [whiteboard](whiteboard.md)** — tabbed visual boards (mermaid diagrams, tables,
   charts, notes), bidirectional via one context export → build.

Build set tonight: **whiteboard, workspace-explorer, notifications, agent-flow**, preceded by
the host-API slice in [../HOST-ADDENDUM.md](../HOST-ADDENDUM.md).

One doc per proposal in [`../PROPOSALS.md`](../PROPOSALS.md), written 2026-07-19 (one Opus
subagent each, grounded in PLUGIN_API.md / PLUGIN_ARCHITECTURE.md / CONTEXT_SYSTEM.md and the
actual schemas in `electron/shared/plugins.ts`). Extrapolations are marked inline; capabilities
the contract doesn't provide yet are flagged under per-doc **HOST-GAP** headings.

Two agent-drafted claims were corrected after cross-checking the code: `atelier.agent`
(info/onEvent/send) **is** implemented for panes in `electron/plugin/runtime.ts` (the
`AtelierAPI` preload type just doesn't show it), and `ContextExportSchema.readonly` **is** a
real field. `agent-timeline.md` and `db-explorer.md` were amended accordingly.

| Doc                                         | Tier | Needs host work before v1?                                 |
| ------------------------------------------- | ---- | ---------------------------------------------------------- |
| [change-review](change-review.md)           | T1   | No (live-only); history feed improves it                   |
| [git-workbench](git-workbench.md)           | T1   | Small (backend cwd, panel→backend call)                    |
| [agent-timeline](agent-timeline.md)         | T1   | No (live-only); `agent.history` for restore                |
| [attention](attention.md)                   | T1   | Yes (cross-conversation + OS notify verbs)                 |
| [test-lens](test-lens.md)                   | T1   | Confirm backend may spawn subprocesses                     |
| [proc-manager](proc-manager.md)             | T1   | Small (backend cwd, conversationId on invoke)              |
| [workspace-explorer](workspace-explorer.md) | T1   | Yes (`fs.list`, composer-insert)                           |
| [cost-dashboard](cost-dashboard.md)         | T1   | Small (cache-token fields on `tokens` event)               |
| [mission-control](mission-control.md)       | T2   | No for v1; task-metadata enrichment for edges              |
| [http-workbench](http-workbench.md)         | T2   | Small (backend→host-fetcher bridge)                        |
| [db-explorer](db-explorer.md)               | T2   | Small (control→backend delivery, path resolution)          |
| [prompt-library](prompt-library.md)         | T2   | Yes (composer-insert; global library needs user-files API) |
| [pr-watch](pr-watch.md)                     | T2   | No (`agent.send` suffices; `agent.attach` nice-to-have)    |

## Consolidated HOST-GAPs (reconcile into one host-API addendum before building)

Recurring across docs — each should land once, generally, not per-plugin:

1. **`agent.history(limit?)`** — bounded mount-time backfill of the `AgentEvent` trace on the
   existing `agent:read` gate. Unblocks the restore story for agent-timeline, change-review,
   cost-dashboard, mission-control, attention.
2. **Backend lifecycle context** — deliver `cwd` in the `hello`/`enable` payload and
   `conversationId` on tool invokes. Needed by git-workbench, proc-manager, db-explorer,
   test-lens.
3. **Panel→own-backend RPC + control→backend delivery** — a first-class call path so a pane can
   drive its service backend without abusing DataBus. Needed by git-workbench, db-explorer,
   http-workbench, proc-manager.
4. **Backend-side `context.update`** — let a service backend refresh a context export while its
   pane is closed (today only the pane can). Needed by git-workbench, proc-manager, test-lens,
   pr-watch.
5. **Normalized file-edit feed** — a `file:edits` channel (PostToolUse-hook sourced, with
   pre-edit snapshot) instead of inferring edits from tool-input shapes. Needed by
   change-review, workspace-explorer.
6. **`fs.list`** — read-only, cwd-scoped directory listing. Needed by workspace-explorer,
   prompt-library.
7. **Composer insert (`agent.compose`)** — stage text in the chat input without sending.
   Needed by workspace-explorer, prompt-library; distinct from `agent.send`.
8. **Cache-token fields** — additive `cacheRead`/`cacheCreation` on the `tokens`/`result`
   events. Needed by cost-dashboard.
9. **Cross-conversation observe + OS notify** (`agent:read-all`, `os.notify`/badge/flash,
   app-scoped storage, `focusConversation`) — the attention plugin's tier; biggest scope
   decision of the set.
10. **Confirmations to record in docs/SDK_NOTES.md or roadmap**: may a utility-process backend
    spawn grandchildren (test-lens, proc-manager — load-bearing); does conversation-close emit
    service `disable` (orphan path); exit codes on the bash tap; task-record enrichment
    (status/blockedBy/outcome) for mission-control.
