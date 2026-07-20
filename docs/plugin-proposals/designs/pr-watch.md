# pr-watch — design

A default Atelier plugin that closes the outermost loop of the development cycle — **push →
CI → review → merge** — inside the workbench. It lists the repo's open PRs with live check
status, review state, and mergeability; a failing check expands to the failing job's log
excerpt with an **"ask Claude to fix"** action that injects the failure context into the
conversation; and it exports the **current branch's CI state as a pinned context document**
so both the agent and the user see push outcomes without running a `watch` loop.

Status: **design** (not built). Proposal source: `docs/plugin-proposals/PROPOSALS.md` §12
(`pr-watch`, tier T2). Grounded in `PLUGIN_API.md`, `docs/PLUGIN_ARCHITECTURE.md`,
`docs/CONTEXT_SYSTEM.md`, and the live manifest schema in `electron/shared/plugins.ts`.
Points not backed by those sources are marked **[extrapolation]**.

---

## 1. Purpose + user stories

**Purpose.** The `gh` CLI already does the plumbing (auth, PR data, run logs), but _watching_
— "is CI green yet?", "did that push pass?", "is this mergeable?" — is a human polling loop.
That loop is exactly what a pane should own. pr-watch turns polling into a live surface and,
crucially, wires the "CI failed → here's why → fix it" hand-off directly into the agent's
conversation.

**User stories.**

- _As the user_, I open a conversation on a repo and immediately see its open PRs (mine +
  assigned) with per-PR check status (green/red/pending), review state (approved / changes
  requested / review required), and mergeability — without switching to a browser or running
  `gh pr list`.
- _As the user_, when a check fails I click the red check to expand the **failing job's log
  excerpt** in place, then hit **"ask Claude to fix"** — and the failure (job name, step,
  log tail, PR/branch) lands in the conversation as a message the agent can act on.
- _As the agent_, after I push and CI runs, I see the **branch's CI outcome** in my context
  every turn (a pinned export) — so I know the push passed or failed without the user pasting
  it back and without me shelling out to poll.
- _As the user_, the "morning PR digest" and "overnight CI failure" workflows named in the
  proposal become a glance at a pane instead of a script.

---

## 2. Panel UX

`kind: "both"` — a `panel` (the PR list surface) plus a `context` export (branch CI state).
Default dock `right` (a tall status column, matching the proposal's "classic thing a pane
should do"). All text/color obey `DESIGN_SYSTEM.md`; the pane is a normal Dockview panel that
docks/floats/tabs like any other.

**Layout (top → bottom):**

1. **Header strip** — repo `owner/name` (resolved from the cwd's git remote), the current
   branch and its CI badge (green/red/pending/none), a manual **Refresh** button, and a
   compact "last updated Ns ago" / rate-budget indicator.
2. **Current-branch CI card** — pinned to the top: branch name, aggregate conclusion, and a
   per-check list (name, status, duration). This is the same data mirrored into the context
   export (§6), shown here for the human. If the branch has an open PR, this card links to it.
3. **Open-PR list** — one row per open PR (yours + assigned). Each row shows: number + title,
   author, head→base branches, an aggregate **check badge**, a **review badge**
   (approved / changes-requested / review-required), and a **mergeable badge**
   (mergeable / conflicting / blocked / unknown).
4. **Expanded PR** — clicking a row expands it to the per-check breakdown. A **failing check**
   expands further to a **log excerpt** (the tail of the failing job's log, capped — see §4),
   with two actions:
   - **ask Claude to fix** — injects the failure context into the conversation (§5).
   - **open in browser** — opens the run/PR URL (host `net`/external open; **[extrapolation]**
     — via a plain link the user's OS handles, since the plugin sandbox has no external-open
     verb of its own).

**States.** Loading skeleton on first mount; an empty state ("no open PRs" / "no git remote"
/ "not signed in to gh"); an error banner (rate-limited, auth-missing, offline) that never
throws into the host. Each mount is treated as a **restore** (PLUGIN_API §8): the pane rebuilds
its last-known snapshot from `storage` immediately, then refreshes in the background — so a
reopened conversation shows stale-but-labeled data instantly rather than a blank pane.

---

## 3. Manifest sketch

Real JSON, validated against `ManifestSchema` in `electron/shared/plugins.ts` (fields, enums,
and defaults all match that schema — `kind`, `permissions`, `defaultDock`, `tools[]`,
`contextExports[]`, `service`, `backend`).

```jsonc
{
  "id": "pr-watch",
  "name": "PR Watch",
  "version": "0.1.0",
  "description": "Live GitHub PR + CI status for this repo: open PRs (checks, review, mergeability), failing-job log excerpts with an 'ask Claude to fix' hand-off, and the current branch's CI outcome as a pinned context export so the agent sees push results without polling.",
  "icon": "M4 2.5v11M4 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4 15a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 4v3a3 3 0 01-3 3H4",
  "kind": "both",
  "entry": "index.html",
  "backend": "plugin.js",
  "service": true,
  "permissions": ["data:subscribe", "data:publish", "storage", "tools", "context", "agent:send"],
  "defaultDock": "right",
  "tools": [
    {
      "name": "pr_watch_refresh",
      "description": "Re-fetch open PRs and CI status for the current repo/branch now (bypass the poll interval). Returns a summary of open PRs and the current branch's check conclusion.",
      "inputSchema": {},
      "timeoutMs": 60000
    },
    {
      "name": "pr_watch_failure_detail",
      "description": "Fetch the failing-job log excerpt for a given PR number or the current branch's latest run. Use to pull the exact CI error before proposing a fix.",
      "inputSchema": {
        "pr": "number?",
        "job": "string?"
      },
      "timeoutMs": 60000
    }
  ],
  "contextExports": [
    {
      "key": "branch-ci",
      "label": "Branch CI",
      "format": "markdown",
      "maxTokens": 1200,
      "readonly": true
    }
  ]
}
```

Notes on choices:

- **`service: true` + `backend`.** CI-watching is a long-running poll (a poller re-fetches;
  `net`/`gh` have no streaming — PLUGIN_API §3). A service backend is spawned when the plugin is
  first enabled in a conversation and pushes fresh data onto DataBus channels
  (PLUGIN_API §5). An on-demand backend would idle-die between tool calls and couldn't poll.
- **`readonly: true` on the export.** The branch-CI document is authored by the plugin from
  real CI state; the agent must **read** it (injected each turn) but must **not** be handed a
  `set_`/`edit_` write-tool for it (`electron/shared/plugins.ts` `ContextExportSchema.readonly`).
  The plugin writes the value via `storage`/`context` (§6); the agent only consumes it.
- **`agent:send`.** Powers the "ask Claude to fix" injection (§5) — see the HOST-GAP note.
- **No `net:fetch` in the sketch above.** The default data source is `gh` via the backend
  (§4). If the REST-via-`net:fetch` fallback is adopted, add `"net:fetch"` to `permissions`.

---

## 4. Architecture — data source, auth, cadence

### 4.1 Data source: `gh` CLI (backend child process) vs GitHub REST (`net:fetch`)

Two viable sources; pr-watch's **primary is the `gh` CLI run from the service backend**, with
REST-via-`net:fetch` as a documented fallback.

|               | `gh` CLI (via backend child process)                                                   | GitHub REST (`net:fetch`)                                           |
| ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Auth          | **Reuses the user's existing `gh auth login`** — zero token handling                   | Needs a token the plugin would have to source and send              |
| Permission    | `backend` + `tools`/`data:publish` (no network capability class)                       | `net:fetch` (network reach declared)                                |
| Data shape    | High-level, stable JSON via `gh pr list --json …`, `gh pr checks`, `gh run view --log` | Raw REST; several calls to assemble checks + reviews + mergeability |
| Rate limits   | Same underlying GitHub limits, but `gh` handles auth/pagination                        | Manual pagination + rate-header handling                            |
| Private repos | Works if the user's `gh` session can see them                                          | Works only with a scoped token the plugin must obtain               |

**Decision: `gh` CLI primary.** It satisfies the auth requirement cleanly — _reuse the user's
`gh` login, never store a token_ — because `gh` owns the credential and pr-watch never touches
it. The backend shells `gh` (privileged work the sandbox can't do directly — PLUGIN_API §3/§11)
and publishes structured results to DataBus channels the pane subscribes to.

Concretely the backend runs (in the conversation cwd, so the repo/remote is correct):

- `gh pr list --json number,title,author,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup --search "…"` — open PRs (yours + assigned).
- `gh pr checks <n> --json name,state,link,bucket` (or the rollup already in `pr list`) — per-PR checks.
- For the current branch: `gh run list --branch <branch> --json …` + `gh run view <id> --json jobs` for the latest run.
- On failure-expand: `gh run view <id> --log-failed` (or `--job <id> --log`), tailed to a cap.

**REST fallback [extrapolation].** If `gh` is absent, the backend _could_ call the REST API via
the host `net.fetch` verb (PLUGIN_API §3 `net` — capped, cookie-isolated, no streaming). But
that requires a token, which collides with "never store tokens." So the fallback is **degrade,
not switch**: if `gh` is not installed or not logged in, the pane shows an actionable empty
state ("install `gh` and run `gh auth login`") rather than prompting for a token. REST is kept
only as a note for a future opt-in.

### 4.2 Auth handling

- **Reuse the user's `gh` login.** The backend invokes `gh`, which reads its own stored
  credentials. pr-watch **never reads, stores, or transmits a token** — no token in `storage`,
  no token in the manifest, no token over IPC.
- If `gh auth status` fails, the plugin reports "not signed in" in the pane and stops polling;
  it does not attempt any login flow (out of scope; Atelier is single-user/local — CLAUDE.md
  guardrails).
- The plugin sandbox never sees credentials; only the privileged backend touches `gh`, matching
  the invariant that plugins reach the outside world only through the host / their backend.

### 4.3 Polling cadence + rate limits

- **Adaptive poll from the service backend.** Base interval ~**30s** while a run is in progress
  (`in_progress`/`queued` checks present), backing off to ~**2–5 min** when everything is
  settled (all green / no active runs), and pausing entirely when the pane is not enabled in any
  conversation (a service dies when disabled in the last one — PLUGIN_API §5). **[extrapolation]**
  — exact numbers are a starting point to tune.
- **Manual refresh** (header button and the `pr_watch_refresh` tool) bypasses the interval.
- **Rate-limit safety.** `gh`/GitHub allows 5000 authenticated REST req/hr; the adaptive backoff
  keeps steady-state well under that. The backend reads the rate-limit headers `gh` surfaces and,
  on approaching the limit, widens the interval and shows a "rate-limited, slowing polling"
  banner rather than hammering. Log fetches (`--log-failed`) happen **only on user expand or the
  `pr_watch_failure_detail` tool**, never on the poll loop, since they are the expensive calls.
- **No polling when idle/offline.** On network error the backend backs off exponentially and the
  pane shows an offline banner; it resumes on the next successful call.

### 4.4 Flow

```
service backend (child proc)          DataBus channels            pane (sandbox)
   gh pr list / checks / runs  ──▶  publish "pr-watch:prs"    ──▶ subscribe → render list
   gh run view --log-failed    ──▶  publish "pr-watch:log:<n>" ─▶ subscribe → render excerpt
   branch CI digest            ──▶  context.update("branch-ci") ─▶ injected each turn (§6)
```

---

## 5. Failure → chat injection

**The action:** in an expanded failing check, **"ask Claude to fix"** puts the failure context
into the conversation so the agent can act on it in its next turn.

**Does a host verb allow a plugin to send text into the conversation?** **Yes.**
`PLUGIN_API.md` §3 defines `agent.send(text): Promise<void>` under the `agent:send` permission,
scoped to the conversation the pane is mounted in. That is the injection path — no host gap for
the basic case.

**Mechanism (primary — `agent.send`).** On click, the pane composes a compact, structured
message and calls `atelier.agent.send(text)`:

```
CI failed on PR #<n> "<title>" (branch <head> → <base>).
Failing job: <job name> / step "<step>".
Conclusion: failure. Run: <run-url>

--- log excerpt (tail, <N> lines) ---
<capped log excerpt>
--- end excerpt ---

Please diagnose and propose a fix.
```

The log excerpt is the already-fetched, capped tail (never the whole log). This is a normal user
message: it appears in the transcript and the agent responds on its next turn.

**HOST-GAP (framing/attachment).** `agent.send` injects **plain user text only**. There is no
host verb to:

1. inject a message with a **distinct role/frame** (e.g. a "system observation" or a labeled
   attachment) that is visually and semantically separated from the user's own prose, nor
2. attach the failure as **structured data** (job id, run url, log blob) rather than inlined
   text.

For pr-watch, `agent.send` with a well-framed text block is sufficient and is the chosen path —
**no new host verb is required to ship.** If, later, a first-class "attach an observation"
frame is wanted (so CI dumps don't look like the user typed them and don't pollute editable
history), the minimal addition would be:

> **Proposed host verb (HOST-GAP, not yet in the contract):**
> `agent.attach(text: string, meta?: { source: string; kind?: string }): Promise<void>`
> — injects a host-framed, clearly-labeled `<atelier-observation source="pr-watch">…</…>`
> block into the next turn (analogous to the pinned-context framing in
> `PLUGIN_ARCHITECTURE.md` §2 / `CONTEXT_SYSTEM.md`), separate from user-authored transcript
> content. Gated by a new `agent:attach` permission.

This is recorded here as an extrapolation; pr-watch **v1 uses `agent.send`** and does not depend
on the proposed verb.

**Alternative considered — the tool route.** The agent could instead call
`pr_watch_failure_detail` itself to pull the log on demand (§3). That's the _pull_ path (agent
initiates); "ask Claude to fix" is the _push_ path (user initiates, agent reacts). Both ship;
they complement each other.

---

## 6. Branch-CI context export format

The `branch-ci` context export (§3 manifest, `readonly: true`, `format: "markdown"`,
`maxTokens: 1200`) is the "push outcome without polling" mechanism. It follows the
`CONTEXT_SYSTEM.md` primitive exactly: the host injects the current value into a framed
`<atelier-context>…</atelier-context>` block **every turn** (stripped from the displayed
transcript), so the agent always sees the latest CI state of the branch it's working on.

**Who writes it.** The service backend recomputes the digest each poll and pushes it via the
host `context` API (`atelier.context.update("branch-ci", md)` — the freshness mechanism named in
`PLUGIN_ARCHITECTURE.md` §2). Because the export is `readonly`, the agent gets **no** write-tool
for it — it can only read. The value also lands in `storage` (`ctx:branch-ci`), so it survives
Clear-chat, restart, and pane open/close (`CONTEXT_SYSTEM.md` persistence). Auto-pinned on enable
(context-document plugins auto-pin their exports — `CONTEXT_SYSTEM.md`).

**Format (markdown, compact, bounded to `maxTokens`):**

```markdown
# Branch CI — `<branch>`

Repo: owner/name · Updated: 2026-07-19T14:02Z · Latest run: <run-url>

**Conclusion: FAILURE** (3 checks · 2 passed · 1 failed · 0 pending)

| Check | Status  | Duration |
| ----- | ------- | -------- |
| build | ✅ pass | 1m12s    |
| lint  | ✅ pass | 34s      |
| test  | ❌ fail | 2m03s    |

Failing: **test** — job "unit (node 20)", step "npm test".
Ask the user to run pr-watch's "ask Claude to fix" for the log excerpt,
or call `pr_watch_failure_detail` to pull it.
```

Design points:

- **Aggregate conclusion first** — the one bit the agent needs ("did my push pass?") is on line
  4, before the per-check table, so a truncated inject still conveys the outcome.
- **No raw logs in the export.** The export names the failing check but does **not** inline the
  log (that would blow `maxTokens` and re-inject a large blob every turn). The log lives behind
  the `pr_watch_failure_detail` tool / the pane's expand action.
- **Truncation-safe.** The host truncates at `maxTokens` with a marker (`CONTEXT_SYSTEM.md`);
  because the summary line and failing-check name come first, truncation loses only the tail of
  the table.
- **`updated` timestamp** so the agent can tell fresh state from stale.

---

## 7. Implementation milestones (ordered)

1. **Repo/branch resolution + `gh` probe.** Backend resolves `owner/name` from the cwd git
   remote and the current branch; runs `gh auth status` / `gh --version`. Pane shows the header
   strip and the "install/login `gh`" empty state. _No polling yet._
2. **Open-PR list (static fetch).** Backend runs `gh pr list --json …` once on enable and on
   manual refresh; publishes to `pr-watch:prs`; pane renders rows with check/review/mergeable
   badges. `pr_watch_refresh` tool wired.
3. **Service poll loop + adaptive cadence.** Turn the backend into a `service`; add the adaptive
   interval, rate-limit backoff, and idle/offline handling (§4.3). Pane shows "updated Ns ago".
4. **Failing-check expand + log excerpt.** Row → per-check breakdown; failing check → capped log
   excerpt via `gh run view --log-failed` on demand (published to `pr-watch:log:<n>`).
   `pr_watch_failure_detail` tool wired.
5. **"ask Claude to fix" injection.** Compose the framed failure message and call
   `atelier.agent.send` (§5). Verify it lands in the transcript and the agent responds.
6. **Branch-CI context export.** Backend computes the digest each poll and calls
   `context.update("branch-ci", md)`; export declared `readonly`, auto-pinned; verify the block
   injects each turn and survives Clear-chat/restart (§6).
7. **Restore + polish.** Persist last snapshot to `storage`; rebuild the pane from it on mount
   (treat every mount as restore — PLUGIN_API §8); empty/error states; rate-budget indicator;
   token-cost display for the pinned export.

Milestones 1–5 deliver the PR-watching surface + the fix hand-off; 6 delivers the agentic
"push → context → fix" loop the proposal calls the earned feature.

---

## 8. Risks

- **Private repos.** Work only if the user's `gh` session can see them. Since pr-watch reuses
  `gh` auth (never a token), private-repo access is exactly the user's own access — correct by
  construction. No extra handling; if `gh` returns 404/permission it surfaces as an empty/error
  state, not a crash.
- **No remote / not a GitHub repo.** A repo with no `origin`, a non-GitHub remote, or no repo at
  all: the backend's repo-resolution step fails cleanly and the pane shows "no GitHub remote for
  this workspace." The plugin never polls in that case (saves rate budget) and never throws into
  the host (PLUGIN_API §2 isolation).
- **`gh` not installed / not logged in.** Actionable empty state (install/login); no token
  prompt, no REST fallback in v1 (§4.1). This is the most common first-run failure and must be a
  clear message, not a silent blank pane.
- **API / rate limits.** Log fetches gated behind explicit user/agent action; adaptive backoff on
  the poll; rate-header-aware slowdown with a visible banner (§4.3). The expensive call
  (`--log-failed`) never runs on the timer.
- **Large logs.** Log excerpts are the **tail**, hard-capped (both for the pane and for the
  `agent.send` injection) so a giant failing job can't blow the pane or the context window.
- **Stale data on restore.** The pane shows the last persisted snapshot labeled with its
  timestamp until the first fresh poll returns — stale-but-honest beats blank.
- **`gh` output-schema drift [extrapolation].** `gh --json` fields are stable but versioned; the
  backend validates the parsed JSON (Zod at the boundary — PLUGIN_ARCHITECTURE.md invariants) and
  degrades a field it can't read rather than crashing.

---

## 9. Acceptance criteria

- **Discovery/enablement.** The plugin appears in the rail from its folder; enabling it in a
  conversation mounts the pane on the right dock; disabling unmounts it and stops its service
  poll. Manifest passes `ManifestSchema` validation.
- **PR list.** With `gh` logged in and the cwd on a GitHub repo, the pane lists the repo's open
  PRs (yours + assigned) with correct check / review / mergeable badges, matching `gh pr list`.
- **Live update.** A check transitioning pending→pass/fail updates the pane within one poll
  interval without a manual refresh; an in-progress run polls faster than a settled one.
- **Failure expand.** Clicking a failing check shows the failing job's **log excerpt** (a capped
  tail), fetched on demand (not on the poll loop).
- **Fix hand-off.** "ask Claude to fix" injects a framed failure message (PR#, job, step, log
  excerpt, run url) into the conversation via `agent.send`; the message appears in the transcript
  and the agent responds to it.
- **Branch-CI export.** The `branch-ci` export is auto-pinned on enable; its markdown digest
  (conclusion-first, per-check table, failing check named, no raw log) is injected each turn; the
  agent can state the branch's CI outcome without running any command; the value survives
  Clear-chat and app restart; the agent is **not** given a write-tool for it (`readonly`).
- **Rate/limit safety.** Steady-state polling stays well under GitHub's authenticated rate limit;
  approaching the limit slows polling and shows a banner; log fetches occur only on
  user/agent action.
- **Failure isolation.** No git remote, `gh` missing, `gh` logged out, offline, or malformed
  `gh` output each produce a clear pane state and **never** throw into the host or another plugin.
- **No token storage.** No GitHub token is ever read, written to `storage`, sent over IPC, or
  persisted; auth is entirely delegated to the user's `gh` session (verifiable by inspecting
  `storage.json` and the backend — it only ever shells `gh`).

---

## Open items to record in docs/DECISIONS.md when built

- Final poll intervals and backoff curve (§4.3 numbers are provisional).
- Whether to add the `agent.attach` host verb + `agent:attach` permission for framed CI
  observations (§5 HOST-GAP), or stay on `agent.send` indefinitely.
- Whether an opt-in REST-via-`net:fetch` mode is ever worth the token-handling cost (§4.1); v1
  says no.
