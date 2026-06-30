# CLAUDE.md — Atelier

Operating manual for building Atelier. You (Claude Code) are building this app
autonomously, in the phases defined in ROADMAP.md. This file governs _how_ you work.
SPEC.md governs _what_ you build. Read both before starting.

**docs/ENGINEERING.md** is the normative engineering standard — code hygiene, repo/commit
conventions, exception handling, documentation, testing, CI, and review. Follow it; its
"definition of done" and architecture invariants are binding on every change.

## Before you write any session/agent code (do this first, every fresh start)

The Claude Agent SDK's TypeScript surface is in active flux (a V2 preview exists; some
features differ between V1 and V2). Do not trust any code snippet from memory. Verify
against the current reference and write a 10-line `docs/SDK_NOTES.md` capturing what you
confirmed:

- Reference: https://docs.claude.com/en/api/agent-sdk/typescript
- Confirm: the streaming `query({ prompt, options })` shape and the `SDKMessage` union
  (`assistant` / `result` / `system` init carrying `session_id`).
- Confirm: multi-turn / session **resume** and **fork** options. **We require session
  forking — that is V1-only — so build on the V1 `query()` API, not the V2 preview.**
- Confirm: in-process MCP tools via `tool(name, desc, zodSchema, handler)` and the server
  helper; `hooks` (PreToolUse / PostToolUse); **file checkpointing** options.
- Confirm: `settingSources` must include `'project'` for a session to load that project's
  `CLAUDE.md`. Atelier's spawned agent instances must set this.

If a confirmed API contradicts SPEC.md, follow the API and note the deviation in
`docs/SDK_NOTES.md`.

## Stack (do not substitute without recording why in docs/DECISIONS.md)

- Electron + TypeScript. React for the renderer. Vite for bundling.
- Agent: `@anthropic-ai/claude-agent-sdk` in the **main** process only. The renderer never
  imports the SDK; it talks to the main process over a typed IPC bridge.
- Docking: **Dockview** (React, floating groups, serializable layout), behind a thin
  `LayoutService` so it can be swapped.
- Code rendering: **Shiki** (or CodeMirror 6) for highlighted code blocks.
- Terminal/ANSI streams: **xterm.js** — used only for raw terminal output, never for chat.
- Plugin sandboxes: Electron `<webview>` (or sandboxed iframe), one per plugin.
- Validation: **Zod** for all cross-boundary payloads (IPC, plugin manifests, host RPC).

## Architecture invariants (violations are bugs)

1. **No TUI scraping.** Render structured SDK message blocks. The only place ANSI is
   rendered is xterm.js stream panes.
2. **Renderer is sandboxed.** `contextIsolation: true`, `nodeIntegration: false`. All
   privileged work (SDK, fs, process spawn) lives in main, behind a preload `contextBridge`.
3. **Plugins are capability-bounded.** A plugin reaches the app _only_ through the host API
   (PLUGIN_API.md). No direct fs, no direct SDK, no direct IPC. A crashing or malformed
   plugin must never take down the app.
4. **Every boundary payload is Zod-validated** at the receiving side.
5. **Agent instances are isolated.** Each has its own `cwd`, session, and transcript. One
   instance's failure does not affect others.
6. **Layout and plugin state are filesystem/JSON, not hardcoded.** A plugin is a folder; a
   layout is serializable JSON. This is what makes hot-reload and self-hosting possible.

## Working method

- Build the ROADMAP phases in order. **Each phase must run and meet its acceptance criteria
  before you start the next.** Do not scaffold later phases early.
- After each meaningful change: build, launch (`npm run dev`), and verify the phase's
  acceptance criteria. Capture anything you can't verify headlessly in
  `docs/PROGRESS.md` as "needs human spot-check: …".
- Keep a running `docs/PROGRESS.md`: what's done, what's next, open questions, and any
  acceptance check you couldn't automate.
- Keep `docs/DECISIONS.md`: every non-obvious choice and why (one line each).
- Prefer small, typed modules with explicit interfaces over cleverness. The whole point of
  this app is legibility; the codebase should model that.
- When something is genuinely ambiguous and not answered by SPEC.md, write the question in
  `docs/PROGRESS.md`, pick the most reversible option, proceed, and flag it. Don't stall.

## Working in parallel (worktrees & sub-agents)

This repo is often edited by **more than one Claude session at once** (the user runs several
Claude CLI terminals; you may also spawn sub-agents). **docs/MULTI_AGENT.md** is the normative
guide — read it before starting if another session might be active. Non-negotiables:

- **One git worktree + one branch per parallel task.** Never let two sessions edit the same
  directory. Create one with `node scripts/worktree.mjs add <topic>` (own dir, own branch,
  `node_modules` linked). Branch isolation alone is not enough — the shared _filesystem_ is what
  races.
- **Merge back through `main`, then run `npm run ci:status` yourself.**
- **Never hand-merge `plugins/hologram/hologram.bundle.js`** — it is generated; on conflict
  rebuild with `npm run build:hologram` and take the rebuilt version.
- A wrong-looking `git diff HEAD` (near-empty after a big edit, or a commit that "already has"
  your change) usually means a concurrent session moved `main`. Check `git reflog` /
  `git log origin/main..HEAD` before assuming anything exotic.

## Definition of done (per phase)

A phase is done when: it builds with no type errors; `npm run dev` launches; the phase's
acceptance criteria in ROADMAP.md are demonstrably met (or the un-automatable parts are
listed for spot-check); `docs/PROGRESS.md` and `docs/DECISIONS.md` are updated.

## Guardrails / deferrals

- This is a **single-user, local** tool. No auth, no multi-user, no remote hosting. Do not
  build claude.ai-login plumbing; authenticate via `ANTHROPIC_API_KEY` or the user's
  existing local Claude Code session.
- **Defer** true OS-detached-window tear-out (drag a panel into its own OS window and back)
  to its roadmap phase. In-app floating panels (Dockview floating groups) come first.
- Do **not** entangle this with the self-modifying-context-schema research — out of scope.
- Backend plugin logic, if any, runs as a child process/worker — **never** hot-reloaded
  in-process (stale-module hazard). UI plugins hot-reload by reloading their sandbox.

## Repo layout (target)

```
/electron        main process: AgentManager, PluginHost backend, IPC, preload bridge
/src             renderer (React): workspace, panels, chat, plugin sidebar
/src/services    LayoutService, AgentClient (IPC wrapper), PluginClient
/plugins         user/agent-authored plugins (watched, hot-loaded) — see PLUGIN_API.md
/plugins/examples a sample panel plugin and a sample tool plugin (you create these)
/docs            SDK_NOTES.md, PROGRESS.md, DECISIONS.md
```
