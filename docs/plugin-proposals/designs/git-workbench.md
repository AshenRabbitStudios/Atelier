# git-workbench — design doc

**Status:** design (proposed T1 default plugin). Source pitch: `docs/plugin-proposals/PROPOSALS.md` §1.
Normative contracts this doc is grounded in: `PLUGIN_API.md` (host API, manifest, permissions,
backend protocol), `docs/PLUGIN_ARCHITECTURE.md` (registry vs. enablement, context pinning,
`plugin_control`), `docs/CONTEXT_SYSTEM.md` (context-document primitive, `set_/edit_` tools,
per-turn injection). Where this doc goes beyond what those files actually say, it is flagged
inline as **(extrapolation)** or under **HOST-GAP**.

`git-workbench` is a `kind: "both"` plugin: a **panel** that renders live repo state and diffs,
plus a **service backend** that runs `git` in a child process and exposes tools to the agent. It
also declares **one context export** — the commit message — so the human and the agent edit the
same draft, and the agent sees the current staged surface every turn.

---

## 1. Purpose + user stories

**Purpose.** The Claude-workflow loop ends in `git` every time. Today the user either trusts the
agent to `git commit` blind through Bash, or alt-tabs to a terminal / lazygit. `git-workbench`
makes the end-of-loop a **shared, visible operation**: a docked pane shows branch, ahead/behind,
and the working tree as staged/unstaged lists with per-file syntax-highlighted diffs; the user
stages hunks; the agent pre-drafts the commit message into a context document both parties edit;
committing is one button the agent can also reach as a tool.

**User stories**

1. _As a user_, after the agent finishes a change, I open the pane and immediately see which files
   changed, staged vs. unstaged, without typing `git status`.
2. _As a user_, I click a file and read a **syntax-highlighted diff**; I stage or unstage
   **individual hunks** so the commit contains the real change, not the debug cruft next to it.
3. _As a user_, I read the commit message the agent drafted, tweak the wording, and commit — or I
   tell the agent "commit what we discussed, not the scratch edits" and watch it stage the right
   hunks and rewrite the message, because it can see the same staged surface I can.
4. _As the agent_, I can read repo status, stage/unstage paths or hunks, draft the commit message
   into the shared context document, and (on the user's go-ahead) commit — every step visible in
   the pane, nothing done behind the user's back in an opaque Bash call.
5. _As a user_, when the cwd is not a git repo, the pane tells me so and offers `git init` rather
   than erroring.

**Why T1 default.** It converts Atelier from "chat next to a folder" into a workbench with a real
end-of-loop, and it is the pane users keep open ~100% of the time — it anchors the docking UX.

**Scope boundary (vs. `change-review`, PROPOSALS §2).** `git-workbench` is **repo plumbing**:
whatever is in the working tree relative to `HEAD`, regardless of who wrote it. `change-review` is
**review of the agent's work product per turn** (accept/revert this turn's hunks). They overlap on
"per-hunk staging UI" but differ in the unit: git-workbench's unit is the commit; change-review's
unit is the agent turn. This doc does not build change-review; a shared hunk-diff renderer could
later be factored out, but that is a follow-up, not a dependency.

---

## 2. Panel UX

### Layout

Default dock `right` (matches every context/viewer plugin). Vertical stack:

```
┌───────────────────────────────────────────────┐
│ ⎇ main   ↑2 ↓0   ● 3 staged  ○ 5 unstaged  ↻   │  header bar
├───────────────────────────────────────────────┤
│ STAGED (3)                              ↧ all  │
│   ● src/agent.ts        +42 −7               ↩ │  (unstage-all / per-file unstage)
│   ● src/ipc.ts          +5  −0                ↩ │
│   ● M package.json      +1  −1               ↩ │
├───────────────────────────────────────────────┤
│ UNSTAGED (5)                            ↥ all  │
│   ○ M src/panel.tsx     +12 −3               ↥ │  (stage-all / per-file stage)
│   ○ ? notes.scratch.md  (untracked)         ↥ │
│   … 3 more                                     │
├───────────────────────────────────────────────┤
│ DIFF: src/panel.tsx                            │
│  ┌───────────────────────────────────────────┐│
│  │ @@ -10,6 +10,9 @@ function render() {     ↥││  hunk header: stage this hunk
│  │  10   const x = …                          ││  (context line)
│  │  11 + const y = …                          ││  (added — green)
│  │  12 − const z = …                          ││  (removed — red)
│  └───────────────────────────────────────────┘│
├───────────────────────────────────────────────┤
│ COMMIT MESSAGE                          🤖 draft│
│ ┌───────────────────────────────────────────┐ │
│ │ feat(panel): stage hunks individually      │ │  editable textarea, bound to the
│ │                                            │ │  `commitMsg` context export
│ └───────────────────────────────────────────┘ │
│ [ Commit 3 files ]     [ ⚙ amend ]  [ sign? ] │
└───────────────────────────────────────────────┘
```

- **Header bar:** current branch (`⎇`), ahead/behind vs. upstream (`↑n ↓m`; hidden if no
  upstream), staged/unstaged counts, and a manual **refresh** (`↻`). Branch name click is a no-op
  in v1 (branch switching is out of scope — see §8).
- **Staged / Unstaged lists:** each row is `status-code path +adds −dels`. Status glyphs follow
  porcelain (`M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked, `U` conflicted).
  Row hover reveals a per-file stage (`↥`) / unstage (`↩`) button; section header has stage-all /
  unstage-all. Selecting a row loads its diff below.
- **Diff view:** per-file unified diff, syntax-highlighted with **Shiki** (the stack's chosen
  highlighter, CLAUDE.md). Highlighting is applied per line with add/remove background tint layered
  on top of the token colors. Each hunk header carries a **stage-this-hunk / unstage-this-hunk**
  control. Binary files render a "binary file — N bytes changed" placeholder, no diff body.
- **Commit area:** a textarea two-way-bound to the `commitMsg` context export (see §5). A `🤖 draft`
  affordance asks the agent to (re)draft the message from the staged surface. The **Commit** button
  is enabled only when there is a staged change and a non-empty message. `amend` toggles
  `--amend`. `sign?` is a checkbox surfacing `-S` **(extrapolation — only if the repo/user has
  signing configured; otherwise hidden)**.

### Interactions

| Action                  | Effect                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Click file row          | Load & render that file's diff in the diff pane                                                                         |
| Per-file `↥` / `↩`      | `git add <path>` / `git reset -- <path>` via backend, then refresh                                                      |
| Hunk `↥` / `↩`          | Apply a single-hunk patch (`git apply --cached [--reverse]`), then refresh                                              |
| Stage-all / unstage-all | `git add -A` / `git reset`                                                                                              |
| Edit commit textarea    | Writes `commitMsg` export via `atelier.context.set` (debounced)                                                         |
| `🤖 draft`              | `atelier.agent.send("Draft a commit message for the staged changes.")` **(extrapolation — needs `agent:send`; see §4)** |
| Commit                  | Backend runs `git commit -F -` with the export value; on success, clears the message and refreshes                      |
| Refresh (`↻`)           | Re-run status/diff snapshot                                                                                             |

### States

- **Loading:** first mount runs a status probe; show a skeleton until the first snapshot arrives.
- **Clean tree:** "Working tree clean" empty-state with the branch/ahead-behind header still shown.
- **Not a repo:** cwd has no `.git`. Empty-state: "No git repository here" + an **`Initialize
repository`** button (`git init`, gated behind a confirm). See §8.
- **Detached HEAD:** header shows `⎇ (detached @ <sha>)`; commit still allowed; ahead/behind hidden.
- **Mid-operation (merge/rebase/cherry-pick in progress):** header shows a warning ribbon
  ("MERGING — resolve conflicts"); conflicted files (`U`) are listed with a distinct glyph; commit
  button relabelled "Commit merge". No conflict-resolution editor in v1 (out of scope — the user
  resolves in their editor or asks the agent).
- **Index locked** (`.git/index.lock` present): a non-fatal banner "Another git process is running"
  with a retry; mutating actions are disabled until the lock clears. See §8.
- **Backend wedged** (crash-loop, PLUGIN_API §5): pane shows "git backend unavailable — reload the
  plugin"; read-only cached snapshot stays visible.

All of the above must be reconstructable on mount from `storage` + a fresh status probe (restore
contract, §8 of PLUGIN_API and below).

---

## 3. Manifest sketch

Real JSON matching the schema confirmed against `PLUGIN_API.md` §1/§4/§5 and
`docs/PLUGIN_ARCHITECTURE.md` §2 (fields observed in shipping manifests: `id, name, version,
description, icon, kind, entry, backend, permissions, defaultDock, tools, contextExports`, and
`systemInstruction` in cartographer). `service` is the §5 backend flag.

```jsonc
{
  "id": "git-workbench",
  "name": "Git Workbench",
  "version": "0.1.0",
  "description": "Repo state, staged/unstaged files, per-file syntax-highlighted diffs with hunk staging, and commit with a shared, agent-drafted message. Read status and stage/unstage/commit via tools; the commit message is one context document you and the user co-edit.",
  "icon": "M4 4.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M4 7.5v4M4 12.5a1.5 1.5 0 1 0 0 .1M12 4.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M12 7.5c0 3-3 2-8 4.5",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.cjs",
  "service": true,
  "permissions": ["tools", "data:publish", "data:subscribe", "context", "agent:send", "storage"],
  "defaultDock": "right",
  "contextExports": [
    {
      "key": "commitMsg",
      "label": "Commit message (draft)",
      "format": "text",
      "maxTokens": 800
    },
    {
      "key": "status",
      "label": "Working-tree status",
      "format": "markdown",
      "maxTokens": 1200
    }
  ],
  "tools": [
    {
      "name": "git_status",
      "description": "Return the current branch, upstream ahead/behind, and the staged and unstaged file lists with per-file add/remove counts. Read-only.",
      "inputSchema": {}
    },
    {
      "name": "git_diff",
      "description": "Return the unified diff for one file (or the whole tree). 'staged' picks the index diff vs HEAD; otherwise the working-tree diff. Large diffs are truncated with a marker.",
      "inputSchema": {
        "path": "string?",
        "staged": "boolean?"
      }
    },
    {
      "name": "git_stage",
      "description": "Stage paths (git add) or unstage them (stage=false → git reset). With no paths, stages/unstages the entire working tree.",
      "inputSchema": {
        "paths": { "type": "array", "items": "string", "optional": true },
        "stage": "boolean?"
      }
    },
    {
      "name": "git_stage_hunk",
      "description": "Stage or unstage a single hunk, identified by file path and hunk index as returned by git_diff. Applies a one-hunk patch to the index.",
      "inputSchema": {
        "path": "string",
        "hunkIndex": "number",
        "stage": "boolean?"
      }
    },
    {
      "name": "git_commit",
      "description": "Commit the staged changes. If 'message' is omitted, uses the current commitMsg context document. Set amend=true to amend the previous commit. Refuses when nothing is staged (unless amend).",
      "inputSchema": {
        "message": "string?",
        "amend": "boolean?"
      },
      "timeoutMs": 20000
    }
  ]
}
```

Notes on the manifest, grounded in the contract:

- **`kind: "both"`** — it is a panel _and_ contributes tools (PLUGIN_API §1). `backend` is required
  because it registers privileged tools (§1, §5).
- **`service: true`** — the backend is a long-running service, not on-demand (PLUGIN_API §5). We
  want it kept alive to watch the index/HEAD and **push status updates onto a DataBus channel**
  when files change, rather than only responding to tool calls. A service backend may push
  unsolicited `{ publish: { conversationId, channel, data } }` (needs `data:publish`, §5).
- **`inputSchema`** shorthand + JSON-Schema-subset object forms are both used, matching PLUGIN_API
  §5 (`"string?"` optional shorthand; `{ type:"array", items:"string", optional:true }`).
- **`contextExports`** — `commitMsg` is the co-edited draft (CONTEXT_SYSTEM.md primitive); `status`
  is a host-injected digest so the agent sees the staged surface every turn without calling
  `git_status`. Enabling a context-doc plugin **auto-pins** its exports (CONTEXT_SYSTEM.md), so
  both are live in context on enable. `status` is agent-read-only in practice — the backend owns
  it — see the "concurrent writer" note in §5.
- **`permissions`** — least-privilege set justified in §4/§5. `context` (host `context.get/set` +
  auto-generated `set_/edit_` tools), `tools` (register the git tools), `data:publish` +
  `data:subscribe` (backend pushes status snapshots; panel subscribes), `agent:send` (the `🤖
draft` button and commit hand-off), `storage` (remember selected file / diff-view prefs across
  restore).

---

## 4. Data flow

Four participants: the **panel** (sandboxed renderer), the **service backend** (child process
running `git`), the **agent context** (host `ContextManager`), and the **host API**. All plugin →
outside traffic goes through `window.atelier` (PLUGIN_API §3); the panel never touches fs, process,
or IPC directly (§3 "Not exposed").

### The git-running boundary

The panel **cannot run `git`** — no process spawn from the sandbox (PLUGIN_API §3). All git
execution lives in the **service backend** (`backend.cjs`), which runs as an isolated Electron
utility process and talks to the host over `process.parentPort` (§5 protocol:
host → `{ id, tool, input }`, child → `{ id, result | error }`). The backend shells out to the
system `git` (`spawn('git', args, { cwd })`).

**Which cwd?** The backend needs the conversation's cwd. The `{ hello: { pluginId, service } }`
and `{ enable: { conversationId } }` lifecycle messages (§5) tell it _which_ conversation, but the
**cwd itself is not in the documented lifecycle payload** — see **HOST-GAP #1**.

### The two data paths

**A. Tool path (request/response) — agent-driven and panel-driven writes.**

```
agent ──git_stage/git_commit/…──▶ SDK ──▶ host ──{id,tool,input}──▶ backend (runs git) ──{id,result}──▶ host ──▶ agent
panel ──plugin_control / tool────▶ host ──▶ backend ─────────────────────────────────────────────────▶ result
```

The agent reaches the tools directly (PLUGIN_API §5 invocation flow). The **panel** needs the same
operations (its stage/unstage/commit buttons). The panel has **no documented way to call its own
plugin's contributed tools** — `atelier.tools.onInvoke` only _registers a handler_, it does not
_invoke_ (PLUGIN_API §3). Options:

- Use the built-in **`plugin_control`** lever: the host validates the target is enabled and
  delivers `{ command, payload }` on the reserved `control:<pluginId>` channel the plugin
  subscribes to (PLUGIN_ARCHITECTURE §3). **But `plugin_control` is described as a tool the
  _agent_ calls**, not something the panel invokes — the panel is not the agent. See **HOST-GAP #2**.
- Fallback that _is_ in the contract: the panel publishes a command on a **plugin-owned DataBus
  channel** (`atelier.data.publish("git-workbench:cmd", …)`, needs `data:publish`) that the
  **service backend subscribes to** and executes, replying on a result channel. This works with
  today's API (service backends can pub/sub on DataBus, §5). This design **adopts the DataBus
  command channel as the panel↔backend path** and treats `plugin_control` as the agent's generic
  lever only. (Extrapolation: a service backend subscribing to a channel is implied by "may push
  unsolicited publish"; explicit backend-side `subscribe` should be confirmed — see HOST-GAP #2.)

**B. Status path (push) — keeping everyone fresh.**

```
git index/HEAD changes ──▶ backend detects ──publish──▶ DataBus "git-workbench:status" ──▶ panel (subscribe) re-renders
                                          └─────────── also context.update-equivalent ─▶ status export ─▶ agent (next turn)
```

The service backend watches the repo (see §5, "watching") and, on change, publishes a fresh status
snapshot to `git-workbench:status`. The **panel subscribes** (`atelier.data.subscribe`, needs
`data:subscribe`) and re-renders lists/diffs. The **`status` context export** is refreshed so the
agent sees the current staged surface on its next turn.

**Who writes the `status` export?** `context.update` is a **plugin (panel) host API**
(PLUGIN_ARCHITECTURE §2: host API addition, permission `context`; CONTEXT_SYSTEM uses
`atelier.context.set`). It is **not documented as a backend capability** — the backend talks only
`parentPort` + DataBus publish. So the flow is: backend publishes status on DataBus → **panel**
receives it and calls `atelier.context.set('status', digest)`. This keeps `status` fresh **only
while the panel is mounted**. For the closed-pane case, see **HOST-GAP #3**.

### Restore / persistence flow

On mount (treat every mount as a restore, PLUGIN_API §8, PLUGIN_ARCHITECTURE Dos):

1. Host re-hydrates `storage` and fires `load`.
2. Panel reads UI prefs from `storage` (last-selected file, diff wrap on/off, amend toggle).
3. Panel reads `commitMsg` via `atelier.context.get('commitMsg')` and fills the textarea.
4. Panel requests a fresh status snapshot (publishes a `refresh` command; backend replies) and
   rebuilds lists/diffs from live git — **git state is authoritative and never persisted**; only
   _UI intent_ and the _draft message_ persist.

The commit message survives Clear-chat / restart because it is a context export in
`…/plugins/git-workbench/storage.json` under `ctx:commitMsg` (CONTEXT_SYSTEM.md persistence).

---

## 5. How the agent participates

### Tools the agent gets

From `manifest.tools` (registered as in-process MCP tools when the plugin loads, PLUGIN_API §5):
`git_status`, `git_diff`, `git_stage`, `git_stage_hunk`, `git_commit`.

From `contextExports` the host **auto-generates** per-export tools (CONTEXT_SYSTEM.md §2):
`set_git-workbench__commitMsg` / `edit_git-workbench__commitMsg` (and the same pair for `status`,
though the agent should not normally write `status` — the backend owns it; see caveat below).

### Context the agent sees every turn

Both pinned exports are injected in the `<atelier-context>` block each turn (CONTEXT_SYSTEM.md §1):

- **`status`** — a markdown digest: branch, ahead/behind, staged files (+/−), unstaged files, a
  note if the tree is clean or mid-merge. So the agent always knows the working-tree shape without
  spending a `git_status` turn.
- **`commitMsg`** — the current draft, so the agent can refine wording it or the user last set.

An optional **`systemInstruction`** (cartographer uses this field) could carry standing guidance
("draft Conventional-Commits style; end the body with the Co-Authored-By trailer from CLAUDE.md;
never commit unless the user asked"). Recommended, using the existing `systemInstruction` manifest
field. _(This encodes the CLAUDE.md rule "Commit or push only when the user asks" as a standing
instruction rather than trusting per-turn memory.)_

### Turn-by-turn interplay (the shared-commit workflow)

1. Agent finishes a code change (via its normal Write/Edit tools). Files land in the working tree.
2. Backend's watcher fires → publishes status → panel re-renders → `status` export refreshed. Next
   turn, the agent's injected context shows the new unstaged files.
3. User (or agent) stages the intended hunks: user clicks hunks in the pane; **or** the agent calls
   `git_stage` / `git_stage_hunk` ("stage the src changes, leave notes.scratch.md"). Either way the
   staged surface updates for both.
4. Agent drafts the message: `set_git-workbench__commitMsg` (full draft) or
   `edit_git-workbench__commitMsg` (tweak). It appears in the pane textarea (poll/subscribe).
5. User reads it, edits inline if needed (writes back via `context.set`), and clicks **Commit** —
   **or** tells the agent to commit, which calls `git_commit` (message omitted → backend reads the
   `commitMsg` export). The CLAUDE.md rule "commit only when the user asks" is enforced by the
   standing instruction, not the tool.
6. On success the backend publishes a fresh (now-clean) status; panel clears the textarea; agent's
   next-turn `status` shows the clean tree and the new `HEAD`.

**The `🤖 draft` button** is `atelier.agent.send("Draft a commit message for the staged changes
using the shared commit-message document.")` (needs `agent:send`). This nudges the agent to write
`commitMsg` without the user typing the prompt. _(Extrapolation on exact wording; the mechanism —
`agent.send` — is in PLUGIN_API §3.)_

**Concurrent-writer caveat on `status`.** Because the host also auto-generates
`set_git-workbench__status`, the agent _could_ overwrite the backend-maintained status. Mitigation:
the plugin treats `status` as backend-authoritative and the standing instruction tells the agent
not to write it; a stricter fix (a read-only export flag) is **HOST-GAP #4**.

---

## 6. HOST-GAP — capabilities this design needs that the contract does not (clearly) provide

Checked against `PLUGIN_API.md` and `docs/PLUGIN_ARCHITECTURE.md`. Each gap has a
today's-API fallback so the plugin is buildable now, with the gap noted as a wanted improvement.

- **HOST-GAP #1 — Backend needs the conversation cwd.** `git` must run in the conversation's
  working directory, but the documented backend lifecycle (`hello` / `enable` / `disable` / `bye`,
  §5) carries `pluginId`, `service`, and `conversationId` — **not the cwd**. The panel _can_ learn
  cwd via `atelier.agent.info()` (`{ …, cwd }`, PLUGIN_API §3), but the **backend** has no such
  call. _Fallback:_ the panel calls `agent.info()`, then publishes the cwd to the backend over the
  DataBus command channel on first load. _Wanted:_ include `cwd` in the backend `enable`/`hello`
  payload, or give backends a host RPC for conversation info.

- **HOST-GAP #2 — No panel→own-tool / panel→backend RPC in the contract.** `atelier.tools.onInvoke`
  only registers a handler; `plugin_control` is an _agent_ tool (PLUGIN_ARCHITECTURE §3), not a
  panel API. There is no documented "panel calls its backend" primitive. _Fallback:_ a
  plugin-owned DataBus request/reply channel (`git-workbench:cmd` → `git-workbench:cmd-reply`),
  which relies on the service backend being able to **subscribe** to a channel — the contract
  states backends can _publish_ (§5) but does not explicitly grant _subscribe_. _Wanted:_ an
  explicit backend `subscribe`, or a first-class `atelier.backend.call(tool, input)` panel API.

- **HOST-GAP #3 — Keeping `status` fresh while the pane is closed.** `context.update`/`set` is a
  panel API (PLUGIN_ARCHITECTURE §2 / CONTEXT_SYSTEM.md); the backend cannot write a context export.
  So the `status` export goes stale when the pane is unmounted but the plugin/service stays enabled.
  _Fallback:_ accept staleness while closed; the agent can always call `git_status` for ground
  truth, and status re-freshes the moment the pane mounts. _Wanted:_ let a service backend push a
  context-export snapshot (a `context.update` over `parentPort`), mirroring how CONTEXT_SYSTEM.md's
  `set_` tool handlers "run in the main process on storage, so they work whether the pane is open
  or closed."

- **HOST-GAP #4 — No read-only / backend-owned context export.** Every declared export gets an
  agent-writable `set_`/`edit_` tool (CONTEXT_SYSTEM.md §2). `status` should be backend-owned and
  agent-read-only. _Fallback:_ a standing instruction telling the agent not to write it. _Wanted:_
  an export flag (`"writable": false`) that suppresses the generated write tools for host-maintained
  exports. _(CONTEXT_SYSTEM.md already has a read-by-layout precedent — the `guide:<key>` vs
  `ctx:<key>` split — so a read-only export is a natural extension.)_

- **HOST-GAP #5 — Repo change detection.** The backend wants to re-publish status when the index or
  HEAD changes. Nothing in the contract offers file-watch to a backend; the backend must watch
  `.git/` itself (Node `fs.watch`) — allowed since a backend is a normal child process, but worth
  flagging as a self-provided capability, and `fs.watch` reliability on Windows/network drives is a
  known risk (§8). _Not strictly a host gap_, but noted so an implementer isn't surprised the host
  gives no watch help.

None of these block a v1: every gap has a working fallback on today's API. They are listed so the
platform team can decide whether to close them (they would each simplify this plugin and every
future backend-plus-context plugin).

---

## 7. Implementation plan (ordered milestones)

Each milestone builds, launches under `npm run dev`, and meets a checkable bar before the next
(CLAUDE.md definition of done). Sibling designs may inform the shared hunk renderer; do not scaffold
`change-review` here.

- **M1 — Read-only status pane.** Manifest (`kind: "both"`, `service: true`), `backend.cjs` running
  `git status --porcelain=v2 --branch`, panel subscribes to the status channel and renders header +
  staged/unstaged lists. Not-a-repo and clean-tree empty states. Establishes the DataBus command +
  status channels (HOST-GAP #1/#2 fallbacks). **Bar:** open on a dirty repo → correct lists; on a
  non-repo folder → the init empty state.
- **M2 — Per-file diffs with syntax highlighting.** `git_diff` in the backend (`git diff` /
  `git diff --cached`), panel renders the selected file's unified diff via **Shiki** with add/remove
  tinting; binary-file and large-diff (truncation) handling. **Bar:** click a file → correct,
  highlighted diff; a 10k-line diff truncates instead of hanging.
- **M3 — File-level staging.** `git_stage` + panel stage/unstage buttons and stage-all/unstage-all,
  driving refresh via the status push. **Bar:** stage a file → it moves lists and the header counts
  update, for both panel-initiated and agent-initiated (`git_stage`) calls.
- **M4 — Hunk staging.** `git_stage_hunk` (apply a single-hunk patch to the index via
  `git apply --cached [--reverse]`), hunk controls in the diff view. **Bar:** stage one hunk of a
  multi-hunk file → only that hunk lands in the index (verify with `git diff --cached`).
- **M5 — Commit message context doc.** `commitMsg` export, two-way textarea binding
  (`context.get/set`), `🤖 draft` via `agent.send`, agent-side `set_/edit_` tools live. **Bar:**
  agent drafts a message → appears in the pane; user edits → agent sees the edit next turn.
- **M6 — Commit.** `git_commit` (`git commit -F -` with the export value; `--amend`), Commit button,
  success/clear/refresh cycle, standing `systemInstruction` ("commit only when asked"). **Bar:**
  commit from the pane and from the agent (`git_commit`) both produce the right commit;
  nothing-staged is refused with a clear message.
- **M7 — Status context export + freshness.** `status` markdown digest refreshed on every push
  while mounted; document the closed-pane staleness (HOST-GAP #3). **Bar:** with the pane open, the
  agent's injected context reflects a stage/commit done in the pane on the next turn.
- **M8 — Robustness pass.** Index-lock banner + retry, mid-merge/detached-HEAD states, backend
  crash-loop handling, `fs.watch` fallback to polling, path-escape guards. **Bar:** the edge cases
  in §8 each degrade gracefully rather than erroring or wedging.

---

## 8. Risks / edge cases

- **`.git/index.lock` (concurrent git).** The agent's Bash, the user's terminal, and this backend
  can all touch the index at once. Mutating ops must detect the lock (or the "another git process"
  stderr) and surface the retry banner rather than clobbering. Never delete the lock automatically.
- **Huge diffs / huge repos.** A generated file or a lockfile can produce a multi-MB diff. `git_diff`
  must cap output (line + byte limit) and mark truncation; the panel virtualizes long lists and
  renders only the selected file's diff. Shiki highlighting is bounded (skip highlighting past N
  lines, fall back to plain-tinted text). The `status` export honors its `maxTokens` (host truncates,
  CONTEXT_SYSTEM.md) — a repo with 500 changed files must not blow the context budget; the digest
  summarizes counts and lists only the first K files.
- **Non-repo cwd.** No `.git` → the init empty-state, no error thrown (a bad plugin must never throw
  into the host, PLUGIN_ARCHITECTURE Don'ts). `git init` is confirm-gated.
- **Concurrent agent edits during review.** The agent may Write a file _while the user is reading its
  diff_. The backend watcher re-publishes status; the panel must reconcile: if the currently
  displayed file changed underneath, show a "diff changed — refresh" affordance rather than silently
  swapping content out from under a mid-stage user. Staging a hunk that no longer applies (the file
  moved) fails the `git apply` cleanly → surface "hunk no longer applies, refresh".
- **Line-ending / CRLF churn on Windows.** `git diff` can show whole-file diffs from autocrlf. Run
  git with the repo's own config (don't override); if a diff looks like pure EOL churn, the panel
  may hint at it, but do not "fix" the user's config.
- **Detached HEAD / mid-merge / rebase.** Handled as states (§2); no in-pane conflict resolution in
  v1 — the user resolves in their editor or asks the agent.
- **Renames & submodules.** Porcelain v2 reports renames (`R`) with a similarity score; render the
  `old → new` path. Submodule changes render as a single-line status entry, no recursive diff in v1.
- **`fs.watch` unreliability** (Windows, network/WSL mounts, some editors' atomic-save). Fall back to
  a low-frequency status poll (e.g. every 3–5s while the pane is focused) if watch events are absent
  or flaky (HOST-GAP #5).
- **Path traversal.** Any path the agent passes to `git_stage`/`git_diff` must be validated to stay
  within the repo/cwd before it reaches `git` (mirrors the host's cwd-escape refusal on
  `data.writeFile`, PLUGIN_API §3). Backend rejects `..`-escaping paths.
- **Backend crash-loop.** Three crashes within 5s wedges the backend (PLUGIN_API §5); the pane shows
  the wedged state and keeps the last good snapshot read-only until reload.
- **Committing signed / hooks.** Pre-commit hooks may reject or modify the commit; surface hook
  stderr in the pane. Never pass `--no-verify` unless the user asks (CLAUDE.md).
- **Trailer policy.** The standing instruction should carry the CLAUDE.md commit trailer
  (`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`) so agent-drafted messages comply.

---

## 9. Acceptance criteria

The plugin is done (per phase / CLAUDE.md definition of done) when all hold:

1. Enabling `git-workbench` in a conversation whose cwd is a git repo mounts a right-docked pane
   showing the correct **branch, ahead/behind, and staged/unstaged file lists** with per-file
   add/remove counts, with no app restart.
2. Selecting a file renders its **syntax-highlighted unified diff**; a large diff truncates with a
   marker instead of hanging; a binary file shows a placeholder.
3. **File-level and hunk-level staging** both work from the pane and via the agent tools
   (`git_stage`, `git_stage_hunk`); staging a single hunk lands exactly that hunk in the index
   (verifiable with `git diff --cached`).
4. The **commit message is a shared context document**: the agent's `set_/edit_` writes appear in
   the pane textarea, and the user's textarea edits are visible to the agent on the next turn.
5. **Commit** from the pane and via `git_commit` both succeed, use the shared message, clear it, and
   refresh to a clean tree; committing with nothing staged is refused with a clear message; the
   agent does not commit unless asked (standing instruction).
6. With the pane open, a stage/commit done in the pane is reflected in the agent's injected `status`
   context on the **next turn**.
7. **Edge cases degrade, never crash:** non-repo cwd shows the init empty-state; an index lock shows
   a retry banner; a mid-merge/detached-HEAD state renders as a labelled state; a wedged backend
   shows a read-only snapshot — none throw into the host.
8. **Restore:** close the conversation and reopen it later → the pane returns right-docked, the draft
   commit message is intact (from `storage`), and the file lists/diffs rebuild from live git.
9. Manifest is Zod-valid on discovery; declared permissions are exactly those used; a malformed
   manifest lists in the rail without loading (PLUGIN_API §1, PLUGIN_ARCHITECTURE Don'ts).

---

### Appendix — API-claim ledger

Grounded (stated by the contract): folder-as-plugin & sandbox origin (PLUGIN_API §1); `kind:"both"`

- backend requirement for privileged tools (§1, §5); manifest fields incl. `contextExports` /
  `systemInstruction` (observed in cartographer/data-table/living-doc manifests); `service:true`
  backend + `parentPort` protocol + unsolicited `publish` (§5); `data.subscribe/publish/writeFile`
  and `agent.info/send`, `context` API, permission split, "not exposed" list (§3/§4); auto-generated
  `set_/edit_` export tools + per-turn `<atelier-context>` injection + auto-pin + storage persistence
  (CONTEXT_SYSTEM.md §1/§2, persistence); `plugin_control` as the agent's generic lever
  (PLUGIN_ARCHITECTURE §3); restore-on-mount contract (PLUGIN_API §8).

Extrapolated (flagged in-text): panel→backend via a DataBus command channel (HOST-GAP #2); backend
learning cwd via panel-relayed `agent.info` (HOST-GAP #1); backend `subscribe` to DataBus;
`🤖 draft` prompt wording; `sign?` control existence; exact icon path. Wanted host additions are
consolidated under §6.
