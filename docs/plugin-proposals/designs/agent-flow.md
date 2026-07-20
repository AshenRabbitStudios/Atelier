# agent-flow — design

Status: **build spec** (user review 2026-07-20). Consolidates three earlier proposals into ONE
workspace-flow-monitoring plugin with sub-tabs, per the user's direction: "Current git view with
visual diff and all the other git stuff, agent timeline, etc. — one workspace flow monitoring
plugin", enabled by the main process logging agent activity and exposing it
(`agent.history`, ../HOST-ADDENDUM.md A5).

Parents (keep for detail; this doc governs scope + integration):
- [agent-timeline](agent-timeline.md) → **Timeline** tab
- [change-review](change-review.md) → **Changes** tab
- [git-workbench](git-workbench.md) → **History** + **Branches** tabs

## 1. Purpose

One pane that answers "what has this agent been doing to my repo, and what state is the repo
in?" — the agent trace and the version-control view of the same events, side by side, cross-
linked: click a Write in the timeline → see that file's diff; look at a dirty file in Changes →
see which turns touched it.

## 2. Tabs

**Timeline.** Turn-structured feed of this conversation's `AgentEvent` trace: turns as
collapsible groups; inside, tool calls (name, one-line input summary, duration, ok/error),
text snippets, permission/question blocks, result + token/cost line per turn. Sources:
`agent.history()` on mount (backfill) + `agent.onEvent` live. Filter chips (tools / files-only /
errors). File-touching entries carry a "view diff" affordance → jumps to Changes tab focused on
that file.

**Changes.** The working-tree view: staged/unstaged/untracked file list (status letters, +/-
counts) and a **visual diff** for the selected file — unified or side-by-side toggle,
syntax-highlighted, intra-line highlights are a stretch. Per-file overlay: which recent turns
touched this file (from the timeline's file index). Refresh triggers: file-write agent events,
tab focus, manual button, backend timer (≥5s debounce).

**History.** `git log` graph (compact lane rendering, capped ~200 commits), commit details on
click (message, files, stat), diff view for a clicked commit reusing the Changes renderer.
Marks commits made during this conversation's session (by time window) so "what did the agent
commit" pops.

**Branches.** Branch list (current highlighted, ahead/behind vs upstream when cheap), worktree
list (`git worktree list` — this repo's multi-session convention makes that genuinely useful).
v1 is READ-ONLY (no checkout/branch/delete buttons — destructive git actions stay with the
agent/user in chat; record in DECISIONS.md).

## 3. Architecture

`kind: "panel"` + `service: true` backend. The backend is the git reader; the pane never parses
`.git` itself.

- **Backend** (`backend.js`, service): learns `cwd` from `hello`/`enable` (A6). Runs git via
  `child_process` (`git status --porcelain=v2`, `git diff [--staged] -- <file>`, `git log
  --format=... --graph-ish data`, `git branch -vv`, `git worktree list --porcelain`). Answers
  pane RPC (A7): `status()`, `diff(file, staged)`, `log(limit)`, `commit(hash)`, `branches()`.
  Publishes `flow:status` on DataBus (needs `data:publish`) on its own debounce timer so the
  pane gets pushed refreshes. All output parsed backend-side into typed JSON; caps (diff ≤ 500KB,
  truncation-marked). Repo-less cwd → every RPC returns `{ error: 'not a git repository' }` and
  the pane shows a friendly empty state.
- **Pane**: tabs above; Timeline from `agent.history`/`onEvent` (`agent:read`); Changes/History/
  Branches from backend RPC + `flow:status` subscription. Diff rendering with a small
  hand-rolled unified/side-by-side renderer + Shiki-style token coloring is OPTIONAL — plain
  mono with add/del line backgrounds is acceptable v1 (match theme tokens). Persist active tab,
  filters, diff mode in `storage`.

### Manifest sketch

```jsonc
{
  "id": "agent-flow",
  "name": "Agent Flow",
  "version": "0.1.0",
  "description": "One pane for the whole flow: agent timeline (turns, tools, costs), working-tree changes with visual diffs, commit history, and branches/worktrees — cross-linked so you can see what the agent did and what it changed.",
  "icon": "<single-path 16px branching-flow glyph>",
  "kind": "panel",
  "entry": "index.html",
  "backend": "backend.js",
  "service": true,
  "permissions": ["agent:read", "storage", "data:subscribe", "data:publish"],
  "defaultDock": "right"
}
```

(Note: `kind: "panel"` with a `backend` used purely for service/RPC is intended per A7; if the
manifest schema requires `kind: "both"` when `backend` is present, use `"both"` with an empty
`tools` list and note it.)

## 4. Cross-linking (the reason this is one plugin)

- Timeline keeps a `file → [turn refs]` index from Write/Edit tool events.
- Changes rows show a small "n turns" chip from that index; click → Timeline filtered to that
  file.
- Timeline file events show "view diff" → Changes tab, file selected, diff loaded.
- History marks session-window commits; clicking one shows its diff.

## 5. Milestones

1. Backend git reader + RPC + `flow:status` push; pane shell with tabs; Changes file list.
2. Diff renderer (unified first) + staged/unstaged + refresh triggers.
3. Timeline tab (history backfill + live), turn grouping, filters.
4. Cross-links (file index both directions).
5. History tab (log + commit diff), Branches/worktrees tab, side-by-side diff, polish.

## 6. Acceptance criteria

1. Open on a dirty repo → Changes lists exactly what `git status` says; clicking a file shows a
   correct, readable diff; staged vs unstaged distinguished.
2. Agent edits a file → Changes refreshes within ~5s without user action; Timeline shows the
   Edit with a working "view diff" link.
3. Timeline restores past events after pane close/reopen (agent.history), and streams live ones.
4. History renders recent commits with details + per-commit diff; Branches lists branches and
   worktrees read-only.
5. Non-git cwd → clean empty states, no errors thrown; huge diffs truncate with a marker.
6. Backend crash does not take the pane down; pane shows "backend unavailable" and recovers on
   respawn.
