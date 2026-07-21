# agent-flow — modification plan / rework (user review 2026-07-21)

**Verdict from review:** "nearly useless" as shipped. The review inverts the design:

> "The primary pillar should be git. It should let me fully explore the git history in
> detail, see diffs, which branch is being worked on and by which agent, subtrees, CI
> status, all that shit, in a pretty user friendly way. So you should have a repo tab with
> all the git and ci shit, and an agent tab with all the agent information with tiered
> verbosity slider" — with the agent log showing "the exact order every single small
> interaction both in the agent and in atelier happened."

## New shape: TWO top-level tabs

### 1. Repo (primary)

One tab, three-region layout: left = navigator, right = detail, top strip = repo health.

- **Health strip (always visible):** current branch + ahead/behind, dirty-file count,
  last commit relative time, **CI status badge** for the current branch (latest run:
  ✓/✗/● in-progress/– none), worktree count. Click any segment → jumps to that view.
- **Navigator sections (collapsible accordion, persisted):**
  - **Working tree** — staged/unstaged/untracked/conflicted files (the old Changes list),
    click → diff in detail pane.
  - **History** — commit list with a **graph gutter** (lane-drawn from parent hashes,
    already captured in `parseLog`), decorations (branch/tag refs — add `%D` to the log
    format), author, relative date, "this session" badge. Search box filters by
    subject/author/hash. Click → commit detail: header, full message body (`%b` — add to
    format), file list with per-file diffs, parent links.
  - **Branches & worktrees** — branches (current, ahead/behind, last commit) and
    worktrees, each worktree annotated with **which agent/session is on it**: match
    worktree paths against Atelier conversation cwds (pane calls `agent.info` for its own;
    a `worktrees.txt`-style match of branch names to `docs/MULTI_AGENT.md` scheme:
    `wt/<topic>` + branch `feat/<topic>` → "worktree agent"; the current cwd's worktree
    is "this conversation"). Read-only stays.
  - **Stashes** — `git stash list` (new backend op), click → stash diff.
  - **Submodules** — listed if `.gitmodules` exists (new backend op), with status.
- **CI (new backend op `ci`):** `gh run list --branch <br> --limit 10 --json ...` via the
  existing runGit-style runner (spawn `gh`); graceful `{ error: 'gh not found' | 'not a
github repo' | ... }` → the badge shows "CI: –" with a tooltip. Detail view lists recent
  runs (status, workflow name, event, elapsed, url) with an "open in browser" that uses
  `navigator.clipboard` fallback (no shell.open on URLs — openPath is for files; copy URL).
  Poll only while the Repo tab is visible, 60s.

### 2. Agent (secondary) — the debug log with tiered verbosity

Replace the turn-card Timeline with a **flat, exactly-ordered event log** (every
AgentEvent in arrival order, backfilled via `agent.history(1000)` + live `onEvent`),
rendered per the **verbosity slider** (persisted):

- **L1 Turns** — one row per user message + per result (tokens/cost/duration/error).
- **L2 + Tools** — tool_use/tool_result rows with one-line summaries + durations + ok/✗.
- **L3 + Text/thinking/permissions** — assistant text chunks (truncated), thinking
  markers, permission/question request+resolution rows, plugin/context events —
  everything the host relays, in exact order, each with a monotonic seq + timestamp.
- **L4 Raw** — every row expandable to the raw JSON payload (pretty-printed, capped).

Extras: filter chips (tools/files/errors/atelier) still apply on top of the level; free-
text search; auto-scroll pinned-to-bottom toggle; "copy row as JSON". The Atelier-side
events (permission cards, plugin enable/disable, context updates) appear interleaved —
that is the "both in the agent and in atelier" ask; anything the host does not relay as an
AgentEvent is out of pane reach and gets a documented note (host gap, candidate B-tier
verb: `agent:read` event feed already carries most).

## Backend additions (backend.js + gitParse.cjs, all read-only)

- `log` gains `%D` (refs) + `%b` (body) fields and an optional `search` param (client-side
  filter is fine at 200 cap — skip backend search).
- New ops: `stashes` (`stash list` + `stash show -p stash@{n}` on demand), `submodules`
  (`submodule status`), `ci` (`gh run list/view` JSON, spawn `gh`, absent-tolerant),
  `commitBody` folded into `commit` op.
- Parsers extended + unit tests for: refs/decorations, body, stash list, submodule status,
  `gh` JSON pass-through validation. Keep the never-throw discipline.

## What survives from the current pane

The diff renderer (unified, line numbers, add/del backgrounds), the file→turn cross-link
index (now Repo↔Agent), backend RPC plumbing, flow:status push refresh, empty states,
storage persistence. The four-tab chrome, the turn-card timeline, and the separate
History/Branches/Changes tabs are replaced.

## Acceptance

- Repo tab: health strip correct on this repo; history graph renders with refs + session
  badges; commit click shows message body + file diffs; branches/worktrees show agent
  annotation; stashes/submodules listed (or hidden when none); CI badge shows real `gh`
  data or a graceful dash.
- Agent tab: slider L1–L4 changes row density live without losing scroll anchor; L3 shows
  permission/question + context/plugin events in exact arrival order; L4 exposes raw JSON.
- Parser tests still green + new fixtures; gate green.
