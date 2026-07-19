# Plugin Capability Roadmap — from viewers to tools

Origin: the 2026-07-19 architecture review + the user's ruling that the plugin sandbox is
**fault containment + a clean coupling contract, not a security boundary** (DECISIONS.md
2026-07-19, PLUGIN_API.md "Why the sandbox exists"). Under that framing, several
security-shaped restrictions block real tool-building. This folder specifies the seven
changes that lift them, one design doc each, in recommended execution order
(value-per-effort, dependencies respected).

## Phases

| #   | Doc                                                | Change                                                                                           | Effort | Depends on                                    |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------- |
| 0   | (ARCH_REVIEW_2026-07-19.md P0 #2, #3, #5, #4)      | Prerequisite fixes: webview nav guard, pane clipping, atomic writes, PluginPane effect stability | S      | —                                             |
| 1   | [01-agent-bridge.md](01-agent-bridge.md)           | Implement the spec'd-but-missing contract: `agent.*`, `data.history`, `layout.onResize`          | M      | 0 (#4)                                        |
| 2   | [02-same-origin-panes.md](02-same-origin-panes.md) | `allow-same-origin` pane sandbox → ES modules, fetch, IndexedDB                                  | S      | —                                             |
| 3   | [03-pane-file-write.md](03-pane-file-write.md)     | cwd-scoped file writes from panes (`data:write`)                                                 | S      | 0 (#5 atomic writes)                          |
| 4   | [04-backend-services.md](04-backend-services.md)   | Long-running backend services + DataBus publish + rich tool schemas + resource limits            | L      | —                                             |
| 5   | [05-net-fetch.md](05-net-fetch.md)                 | Real fetch proxy (method/headers/body/binary) + any-mime `readAsset`                             | M      | —                                             |
| 6   | [06-browser-drive.md](06-browser-drive.md)         | Drive the browser surface: `exec`/`click`/`fill`                                                 | M      | 0 (#2, #3)                                    |
| 7   | [07-workspace-plugins.md](07-workspace-plugins.md) | Workspace-local plugins (`<cwd>/.atelier/plugins`) — the F4b re-open                             | XL     | 1–4 useful first; **user decisions required** |

Phase 0 is the review's P0 list — do it first; several later phases build on those fixes
(atomic storage writes, the stabilized PluginPane effect, the hardened webview).

## Rules for the implementing session (read before starting)

1. Read `CLAUDE.md`, `docs/ENGINEERING.md`, `PLUGIN_API.md` (esp. "Why the sandbox exists"),
   and `docs/PLUGIN_ARCHITECTURE.md` first. The framing matters: you are widening a
   _coupling contract_, not weakening a security boundary — but every widening must keep the
   three intents intact: (a) a broken plugin can never take down or wedge Atelier, (b) the
   contract stays authorable from PLUGIN_API.md alone, (c) no cross-contamination between
   plugins or with the app.
2. **One phase per branch/worktree** (`node scripts/worktree.mjs add <topic>`), phases in
   order, gate green (`npm run typecheck && npm run lint && npm run format:check && npm test`)
   before the next. Update `docs/PROGRESS.md` + `docs/DECISIONS.md` per phase.
3. **The verb checklist.** Adding or changing any plugin-facing capability touches, in order:
   - `electron/plugin/runtime.ts` — the `window.atelier` surface (RUNTIME_JS string)
   - `src/components/PluginPane.tsx` — the relay (permission check + forward)
   - `electron/preload.ts` — the bridge method
   - `electron/shared/events.ts` — IPC channel id + Zod schema + `AtelierAPI` type
   - `electron/main.ts` — the handler (Zod-parse, **then re-check the plugin's declared
     permission + enablement against the registry** — main-side contract enforcement per
     ARCH_REVIEW P0 #1; build it into every new handler even before the retrofit lands)
   - `electron/shared/plugins.ts` — `PLUGIN_PERMISSIONS` if a new permission is added
   - `electron/plugin/pluginAuthoringGuide.ts` — the agent-facing guide (a test asserts
     enum sync — extend it)
   - `PLUGIN_API.md` — the human/agent contract
   - unit tests for the main-side logic (transport/registry-injected, no Electron needed —
     follow `PluginBackendManager.test.ts` / `contextTools.test.ts` patterns)
4. **Never trust remembered SDK shapes** — verify against `docs/SDK_NOTES.md` and the live
   reference before touching AgentManager.
5. Where a doc says **"DECISION"**, stop and ask the user; do not pick silently.

## Can Opus do this?

Yes. Phases 0–6 are bounded, pattern-following work with explicit acceptance criteria — the
riskiest parts (SDK behavior, Electron webview quirks) are already solved elsewhere in the
codebase and referenced from each doc. Phase 7 is genuinely architectural; its doc narrows it
to one recommended design plus explicit user decisions, and it should be attempted last, after
the patterns from 1–4 are muscle memory.
