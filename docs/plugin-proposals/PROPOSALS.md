# Atelier Default Plugin Suite — Proposals

**Status:** proposal — 2026-07-19. Research-driven candidates for the plugin set that ships
with Atelier by default, replacing the current grab-bag of experiments. Each proposal below
is a pitch: the need, how it's used in a session, and why it earns a default slot. Detailed
per-plugin design docs live in `designs/` (one file per plugin).

---

## Status after user review 2026-07-20

Decisions from the review session are recorded in full in
[`designs/README.md`](designs/README.md) ("User review 2026-07-20 — decisions"). Summary:

**Build set (tonight):** `whiteboard`, `workspace-explorer`, `notifications`, `agent-flow` —
preceded by the host-API slice in [`HOST-ADDENDUM.md`](HOST-ADDENDUM.md).

**Consolidation:** `git-workbench` + `change-review` + `agent-timeline` are merged into one
plugin — [`agent-flow`](designs/agent-flow.md) — with sub-tabs for the three functions. The
three original docs are superseded by the agent-flow build spec.

**Approved-then-built (2026-07-21 overnight session):**

- `http-workbench` — **BUILT** (`plugins/http-workbench`). Pane (builder / viewer /
  shared history / readonly ctx digest) per the design; the agent's `http_request` tool
  deviates from design §4.4 by fetching in the backend with host-fetcher-identical
  constraints (documented in the backend header + PROGRESS) instead of the
  not-yet-existing host relay.
- `mission-control` — **BUILT** v1 (M1–M6, `plugins/mission-control`): task/fleet/commands
  lanes, completed-while-away inbox, templated nudges, agent-maintained work-summary
  context export. v2 cross-conversation fleet stays gated on `agent:read-all`
  (HOST-ADDENDUM Tier 2, B1).

**Not in the build set:** `db-explorer`, `prompt-library`, `pr-watch`, `test-lens`,
`proc-manager`, `cost-dashboard`. All remain designed and tiered; none were rejected.

---

## Research basis

What people actually do with Claude Code / the CLI, distilled from 2026 workflow guides,
plugin marketplaces, and community pain-point threads:

- **The dominant loop is: plan → agent edits → human reviews the diff.** Reviewing what the
  agent changed is the single most repeated activity, and the terminal is the worst place to
  do it. Marketplace data shows git/PR-review tooling at the top of every install chart.
- **Verification workflows are the second loop**: TDD red/green, running dev servers,
  driving a browser, hitting APIs. The agent needs the feedback; the human needs to _watch_
  the feedback.
- **Observability is the loudest unmet need**: "what is the agent doing / what did it just
  do / what did that cost me" spawned an entire tool category in 2026 (agenttrace,
  agentglass, LangFuse-style trace trees). Users graft dashboards onto a TUI that can't
  show them. Atelier is literally built to show them.
- **Orchestration went mainstream** (background tasks, subagent swarms, overnight runs) —
  and with it, mission-control UIs: task boards, fleet views, notification hooks.
- **Recurring complaints**: opaque token burn, runaway refactors discovered too late,
  "it finished 10 minutes ago and I didn't notice", juggling long-running processes,
  re-typing the same prompt scaffolds.

Sources: [ayautomate workflows](https://www.ayautomate.com/blog/best-claude-code-workflows),
[skakarh 20 workflows](https://www.skakarh.com/blog/claude-code-workflows),
[composio plugin roundup](https://composio.dev/content/top-claude-code-plugins),
[buildtolaunch plugin tests](https://buildtolaunch.substack.com/p/best-claude-code-plugins-tested-review),
[claudefa.st MCP survey](https://claudefa.st/blog/tools/mcp-extensions/best-addons),
[Augment on agent observability](https://www.augmentcode.com/guides/agent-observability-for-ai-coding),
[agentglass](https://github.com/SirAllap/agentglass),
[agenttrace](https://luoyuctl.github.io/agenttrace/),
[HN pain-point threads](https://news.ycombinator.com/item?id=46730671).

## How to read these

Every proposal fits the existing plugin contract (PLUGIN_API.md): a sandboxed panel, and/or
context documents the agent maintains via generated `set_*` tools, and/or backend tools in a
child process. Nothing here needs new host capabilities unless its design doc says so
explicitly (those callouts are flagged **HOST-GAP**).

Tiering: **T1** = ships enabled-by-default sensible for almost everyone. **T2** = ships
installed but off by default. Suggested tiers are in each pitch.

---

## 1. `git-workbench` — repo state, staged/unstaged, commit — T1

**The need.** The core Claude-workflow loop ends in git every single time, and today the
user either trusts the agent to commit blind or alt-tabs to a terminal/lazygit. Every
"agent cockpit" tool that gained traction in 2026 (agentglass et al.) ships a source-control
panel; it's table stakes for a workbench.

**How it's used.** A docked pane shows branch, ahead/behind, and the working tree as two
lists (staged/unstaged) with per-file syntax-highlighted diffs. The user stages hunks and
writes/edits a commit message the agent pre-drafts into a context document. The agent sees
the same repo state via that context doc, so "commit what we discussed, not the debug
cruft" becomes a shared, visible operation instead of a leap of faith.

**Why it earns a default slot.** It converts Atelier from "chat next to a folder" into a
workbench with a real end-of-loop. It's also the plugin users will keep open 100% of the
time, which anchors the whole docking UX.

## 2. `change-review` — approve/revert the agent's edits, hunk by hunk — T1

**The need.** Distinct from git-workbench: this is _review of the agent's work product_,
not repo plumbing. The #1 community complaint about agentic coding is discovering a runaway
refactor after the fact — 40 files changed, requirements missed, duplicate code. People
want a bounded, reviewable changeset per turn ("diff stays within bounds" is a named
observability pattern now).

**How it's used.** The pane accumulates every file the agent touched this session, grouped
by turn, with per-hunk ✓ keep / ↩ revert. A "review budget" banner flags when a turn
exceeded N files / M lines. Reverting a hunk writes the file back and posts a note into the
agent's context so it knows its change was rejected and why (the user can attach a one-line
reason — which doubles as steering feedback).

**Why it earns a default slot.** This is the trust interface. It answers the exact fear
that keeps people supervising the TUI line-by-line, and it's uniquely possible in Atelier
because the host already observes file writes and can inject context back at the agent.

## 3. `agent-timeline` — the trace: every tool call, duration, outcome — T1

**The need.** "Agent engineers read traces" became a truism this year; a whole tool
category exists to reconstruct what an agent did from logs. Atelier sits on the live SDK
event stream — it can render the trace first-hand, not forensically.

**How it's used.** A horizontal timeline (or collapsible tree for subagents) of the
session: each tool call as a block — name, target file/command, duration, ok/error —
color-coded by tool family, with slow calls and failures visually loud. Clicking a block
shows the full input/output. Filters: errors only, by tool, by turn. A "current activity"
header answers "what is it doing _right now_" during long silent stretches.

**Why it earns a default slot.** It is the observability story, and it directly treats the
"chain of thought stopped / is it stuck?" anxiety that even Atelier's own bug reports show.
Debugging a wedged turn goes from vibes to evidence.

## 4. `cost-dashboard` — tokens, cache hits, and dollars, attributed — T1

**The need.** Opaque token burn is a top-3 complaint in every Claude Code thread (people
canceling over "token issues"). Existing meters show account-level percent-used; nobody
shows _what in this session_ is expensive — which turn, which tool loop, cached vs not.

**How it's used.** Per-conversation dashboard: cumulative cost, per-turn bar chart
(input/output/cache-read stacked), burn rate, and "expensive outliers" (a doom-looped tool
retry, a giant file read). A budget line per conversation triggers a soft warning the agent
also sees via context, so it can economize (stop re-reading a 3k-line file) instead of the
user discovering it on the bill.

**Why it earns a default slot.** Cost anxiety is universal, continuous, and currently
serviced by squinting at a percent meter. Attribution — not totals — is the feature.

## 5. `test-lens` — the red/green loop as a first-class pane — T1

**The need.** TDD red/green is the canonical "agent does it best" workflow in every 2026
guide, and test output is the agent's primary verification signal — yet it lives in scrolled-
away terminal spam. Users re-run tests just to see the state again.

**How it's used.** Auto-detects the runner (vitest/jest/pytest/cargo/go), parses results
into a persistent tree: suites → tests, red/green, failure messages inline, history
sparkline per test (flaky detection falls out for free). One-click re-run of a file/test
writes the command through the agent or a backend runner. The current red set is exported
as a context document, so the agent always knows exactly what's failing without re-running.

**Why it earns a default slot.** It closes the verification loop visually for the single
most-recommended workflow, and the context export makes the agent measurably cheaper
(no "run tests again to see" turns).

## 6. `proc-manager` — dev servers and long-running processes — T1

**The need.** Real sessions juggle a dev server, a watcher, maybe docker — the agent
starts them, loses them, restarts them on the wrong port; the user can't see any of it.
The lazydocker-style panel in agent cockpits exists because this hurts everywhere.

**How it's used.** A pane listing managed processes (npm scripts auto-discovered from
package.json, plus arbitrary commands): start/stop/restart, live log tail per process
(xterm pane), port + health badge. Backend tools let the agent start/stop/query the same
processes, and process state (running/exited/port) is a context export — so "is the dev
server up?" is a lookup, not a `netstat` expedition.

**Why it earns a default slot.** It removes the whole class of "two zombie vite instances
fighting over port 5173" incidents, for the human _and_ the agent, and it makes bash-stream
feel curated rather than raw.

## 7. `workspace-explorer` — file tree with agent-activity heat — T1

**The need.** Atelier has no file browser; the user's mental model of "what is this repo /
what has the agent been touching" lives in a separate editor. Every IDE-adjacent agent tool
grew a tree view because orientation precedes trust.

**How it's used.** A standard collapsible tree of the conversation's cwd with two twists:
(1) an activity heat overlay — files the agent read/edited recently glow, with read vs
write distinguished, decaying over time; (2) click → syntax-highlighted read-only preview
(Shiki), double-click → open in the user's editor. Right-click → "mention in chat" inserts
the path into the composer.

**Why it earns a default slot.** Orientation is a constant need, the heatmap is the trace
made spatial ("it's been circling these four files"), and "mention in chat" quietly fixes
the most annoying part of talking to a CLI about files.

## 8. `mission-control` — tasks, subagents, background work — T2

**The need.** Orchestration is the 2026 headline (dynamic workflows, agent swarms,
overnight runs). Claude Code grew task lists, background tasks, and subagents — all
invisible-ish in a TUI. Users running parallel work need one place that answers "what's
in flight, what's blocked, what finished while I was gone."

**How it's used.** A board: task list as kanban (pending/in-progress/completed, with
blocked-by edges), live subagent fleet (name, what it's doing, elapsed), background
commands with exit status. Finished-while-away items accumulate in an inbox strip. The
board is read from the SDK's task/background events; the user can nudge ("promote this
task") via chat-injection.

**Why it earns a default slot (T2).** For power users this _is_ the app. It's T2 only
because single-threaded users won't see data in it on day one.

## 9. `http-workbench` — request/response console the agent and user share — T2

**The need.** API development is a top Claude use case (endpoint migration, API validation,
"generate the client"), and the verify step is curl-spam whose output the user never sees
structured. Postman exists precisely because raw HTTP is miserable to read.

**How it's used.** A request builder (method/URL/headers/body) with a pretty response
viewer (status, timing, JSON tree). Every request lands in a history list; the history is
also a context export, and a backend tool lets the agent fire requests through the same
pipe. So: agent writes an endpoint → agent hits it → response appears in the pane → user
tweaks one header and replays — one shared console instead of two disjoint curl streams.

**Why it earns a default slot (T2).** Huge for the API-dev cohort, dead weight for others —
but when it's relevant it replaces an entire external app.

## 10. `db-explorer` — schema + query results next to the chat — T2

**The need.** Database MCP servers (Postgres, SQLite, Supabase) rank high in every survey,
which proves demand — but they return tables _as prose into the transcript_. Tabular data
in a chat bubble is the worst rendering imaginable.

**How it's used.** Connect to SQLite file / Postgres URL (read-only by default). Pane
shows schema tree and a query editor; results render as a real grid (sortable, pageable).
The agent gets `db_query` / `db_schema` backend tools whose results ALSO land in the pane —
so "why is this migration wrong" is investigated with both parties looking at the same
result set. Current schema summary is a context export, killing the perpetual
"let me re-inspect the schema" turn.

**Why it earns a default slot (T2).** When a project has a database, this is instantly the
second-most-used pane; schema-in-context also measurably reduces token spend.

## 11. `prompt-library` — reusable prompts, runbooks, and slash-style macros — T2

**The need.** The skills/commands ecosystem (superpowers at 750k installs) proves people
codify repeatable workflows. But personal prompt scaffolds ("my review checklist", "my
release runbook", "the way I like commit messages") live in text files and get re-pasted.

**How it's used.** A pane of user-curated entries (title, description, template with
`{placeholders}`), one click → filled template lands in the chat composer. Entries are
plain markdown files in a folder (portable, git-syncable). The agent can be granted a tool
to _propose_ new entries when it notices the user repeating a pattern — the user approves
into the library.

**Why it earns a default slot (T2).** Cheap to build, compounds forever, and it's the
on-ramp for users to discover that Atelier workflows are programmable at all.

## 12. `pr-watch` — GitHub PRs and CI status without leaving — T2

**The need.** "Morning PR-review digest" and "overnight CI failure analysis" are named
workflows now. The gh CLI does the plumbing but the _watching_ (is CI green yet?) is a
human polling loop — the classic thing a pane should do.

**How it's used.** Lists the repo's open PRs (yours + assigned): checks status live,
review state, mergeable. A failing check expands to the failing job's log excerpt with
"ask Claude to fix" — which injects the failure context into chat. CI state for the
current branch is a context export, so after the agent pushes, it (and you) see the
outcome without anyone running watch loops.

**Why it earns a default slot (T2).** It closes the outermost loop (push → CI → merge)
inside the workbench, and the "CI failed → context → fix" hand-off is a genuinely agentic
feature no terminal gives you.

## 13. `attention` — "it finished / it needs you" done properly — T1

**The need.** The most common minor-but-universal complaint: the agent finished (or hit a
permission prompt) minutes ago and nobody noticed. Anthropic added terminal-bell hooks;
people build whole notification rigs (sounds, phone pushes) around long runs.

**How it's used.** Near-invisible pane (a status strip) + OS-level notifications: turn
finished, agent blocked on permission, error, long-silence watchdog — each with per-event
toggles, quiet hours, and optional sound. Taskbar-flash/badge when Atelier is unfocused.
An "attention log" lists the events you missed, newest first, click → jump to that
conversation.

**Why it earns a default slot (T1).** Tiny surface, disproportionate quality-of-life. It
converts the multi-conversation, background-task story from "check compulsively" to
"get tapped on the shoulder", which is precisely the promise of running agents in a
workbench instead of a terminal.

---

## Explicitly not proposed

- **Docs lookup (Context7-style)** — better served by the existing MCP ecosystem the user
  can attach; wrapping it adds nothing pane-shaped.
- **Browser/screenshot verify** — the existing `browser` plugin already owns this.
- **Notes/scratchpad/plan docs** — `living-doc` + `cognition` already own this.
- **Security scanning** — valuable but belongs to CI/skills (semgrep etc.), not a pane.

## Suggested build order

Trust loop first, then verification, then orchestration:
`change-review` → `git-workbench` → `agent-timeline` → `attention` → `test-lens` →
`proc-manager` → `workspace-explorer` → `cost-dashboard` → then the T2s by user demand.
