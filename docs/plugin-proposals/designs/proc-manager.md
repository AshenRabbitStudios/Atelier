# proc-manager — design

A default Atelier plugin for **managed dev processes**: npm scripts auto-discovered from
`package.json` plus arbitrary commands, with start/stop/restart, a live per-process log tail,
port + health badges, agent-facing tools to start/stop/query the same processes, and process
state exported into the agent's context.

Status: **design** (not built). Grounds in PLUGIN_API.md, docs/PLUGIN_ARCHITECTURE.md,
docs/CONTEXT_SYSTEM.md, the schema in `electron/shared/plugins.ts`, and the service-backend
lifecycle in `electron/plugin/PluginBackendManager.ts`. Proposal source: PROPOSALS.md §6.
Extrapolations beyond what those files state are marked **[EXTRAPOLATION]**.

---

## 1. Purpose + user stories

**The need (PROPOSALS.md §6).** Real sessions juggle a dev server, a watcher, maybe docker.
The agent starts them, loses track, restarts them on the wrong port; the user can't see any of
it. This plugin makes those processes first-class, visible objects owned by one long-lived
service — for the human _and_ the agent — killing the "two zombie vite instances fighting over
5173" class of incident.

This is a **`kind: "both"`, `service: true`** plugin: a panel (the process list + log viewer)
and a long-running backend service that actually owns the child processes (a tool responder
that is _idle between calls_ cannot own a `vite` that must keep running).

**User stories**

- _As a user_, I open the pane and see every dev process for this conversation's cwd: the npm
  scripts from `package.json` (auto-discovered) and any commands I've added, each with a
  running/stopped/exited badge, its port, and a health dot. I click Start on `dev`; I watch its
  log tail live in the pane.
- _As a user_, I don't want a zombie `vite` after I close the conversation, disable the plugin,
  or quit the app. Whatever I started here dies with the thing that owns it — including on
  Windows, where a killed parent leaves the child tree alive by default.
- _As the agent_, before I run a build I ask `proc_status` "is the dev server up and on which
  port?" — a lookup, not a `netstat` expedition. I `proc_start('dev')` and `proc_stop('dev')`
  without shelling out, and I _see_ the resulting state because it's pinned into my context.
- _As the agent_, when I need to know why the server won't start, I read the tail of its log via
  a tool without the user having to paste it.

---

## 2. Panel UX

Two regions in one pane (default dock `bottom` — dev output belongs at the bottom, like
bash-stream): a **process list** (top / left) and a **log viewer** (the bulk of the pane).

### Process list

One row per managed process:

- Name (`dev`, `build:watch`, or a user label for an arbitrary command).
- Source tag: `npm` (auto-discovered) vs `custom`.
- Status badge: `stopped` / `starting` / `running` / `exited (code)` / `crashed`.
- **Port badge** — the detected listening port(s), e.g. `:5173`, or blank.
- **Health dot** — green (healthy), amber (starting / unknown), red (unhealthy / crashed).
- Controls: Start / Stop / Restart; select-row → focus its log in the viewer.
- "Add command…" affordance to register an arbitrary command (label, command, optional cwd
  override, optional health URL).

### Log viewer — xterm.js

Dev-server output is ANSI-colored, so the log surface must be a real terminal, not a
`<pre>`. Per architecture invariant #1 and PLUGIN_API.md §1, **xterm.js is the sanctioned
ANSI surface**, and a plugin renders it _inside its own sandboxed pane_ — it does **not** need
a host-provided terminal. The confirmed pattern is `plugins/examples/bash-stream/`, which
vendors `vendor/xterm.js` + `vendor/xterm.css` into its own folder and instantiates a
`Terminal` in `index.html`. The pane runs at its own origin (`atelier-plugin://<id>`), so
loading its own scripts and CSS is normal (PLUGIN_API.md §1).

So: **proc-manager vendors xterm.js the same way bash-stream does**, one `Terminal` per
process (or one reused terminal that swaps its buffer when the selected row changes —
**[EXTRAPOLATION]**; one-per-process is simpler and matches xterm's disposal model, at a
memory cost bounded by scrollback, see §8). Log lines arrive from the backend service over a
**DataBus channel** (§4) and are `term.write()`-n straight through, preserving color.

No host API change is required for the terminal itself — this is the same capability
bash-stream already uses. The _log transport_ (backend → pane) is the part that leans on
`data:publish` from a service backend (PLUGIN_API.md §5, already supported).

---

## 3. Manifest sketch

Real JSON matching `ManifestSchema` in `electron/shared/plugins.ts` (validated on discovery by
`PluginRegistry`). Notable: `service: true` requires `backend` (enforced in
`PluginRegistry.read` → "a service plugin must declare backend"); `kind: "both"` requires
`entry` (also enforced there). Permissions must be members of `PLUGIN_PERMISSIONS`.

```json
{
  "id": "proc-manager",
  "name": "Process Manager",
  "version": "0.1.0",
  "description": "Manage the conversation's dev processes: npm scripts auto-discovered from package.json plus arbitrary commands. Start/stop/restart, watch each one's live log, and see its port and health. Use the proc_start / proc_stop / proc_restart / proc_status tools to control them; current process state is pinned into your context.",
  "icon": "M2.5 3h11v10h-11zM4.5 6l1.5 1.5L4.5 9M7.5 9.5h3",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.cjs",
  "service": true,
  "permissions": ["data:subscribe", "data:publish", "storage", "tools", "context"],
  "defaultDock": "bottom",
  "tools": [
    {
      "name": "proc_start",
      "description": "Start a managed process by name (an npm script or a registered custom command). Returns its new status, pid, and detected port if it binds one quickly.",
      "inputSchema": { "name": "string" },
      "timeoutMs": 30000
    },
    {
      "name": "proc_stop",
      "description": "Stop a running managed process by name (terminates its whole child-process tree). Returns the final status.",
      "inputSchema": { "name": "string" }
    },
    {
      "name": "proc_restart",
      "description": "Restart a managed process by name (stop if running, then start).",
      "inputSchema": { "name": "string" }
    },
    {
      "name": "proc_status",
      "description": "Query managed processes. With no name, returns every process (status, port, health, pid). With a name, returns just that one plus a tail of its recent log lines.",
      "inputSchema": {
        "name": "string?",
        "logLines": "number?"
      }
    }
  ],
  "contextExports": [
    {
      "key": "processes",
      "label": "Dev processes",
      "format": "markdown",
      "maxTokens": 800,
      "readonly": true
    }
  ]
}
```

Notes on the choices, grounded in the schema:

- `contextExports[].readonly: true` (schema line 66): the value is **injected every turn** so
  the agent always knows what's running, but **no `set_`/`edit_` write-tool** is registered —
  the agent changes process state through the `proc_*` tools, not by editing the export text.
  This is the correct primitive for a state mirror the agent should read but not hand-edit.
- The export is written by the plugin. A `readonly` export is still fed from `ctx:<key>`
  storage (CONTEXT_SYSTEM.md); the pane/backend keeps it fresh. Because the pane can be
  **closed** while processes run, see the HOST-GAP in §6 about who writes it.
- `permissions` are least-privilege: `data:subscribe`/`data:publish` for the log channel(s),
  `storage` for the custom-command list, `tools` for the four tools (required for a backend to
  register tools — PLUGIN_API.md §4), `context` for the export.

---

## 4. Architecture

### The service backend owns the child processes

The backend (`backend.cjs`) runs as an **Electron utility process**, one child per plugin,
spawned/killed by `PluginBackendManager`. With `service: true`, its lifecycle (confirmed from
`PluginBackendManager.startService` / `stopService`) is:

- **Spawn**: when the plugin is first enabled in _any_ conversation (`startService` →
  `ensure` → spawn + `{ hello: { pluginId, service: true } }`).
- **Enable per conversation**: `{ enable: { conversationId } }` each time it's enabled in a
  new conversation.
- **Disable per conversation**: `{ disable: { conversationId } }`; when the **last**
  conversation drops it, `stopService` calls `stop(pluginId)` → the child is killed.

The backend spawns dev processes with Node's `child_process` and holds a table
`Map<procKey, ChildHandle>` where `procKey` is `<conversationId>:<name>` — because the service
child is **shared across conversations** (one child, many enabled conversations), it must
partition its process table, logs, and DataBus publishes by `conversationId`. **[EXTRAPOLATION]**
— PROPOSALS.md describes per-conversation dev processes; the shared-service partitioning is the
implementation consequence, not stated verbatim.

**Message protocol** (confirmed from `backend.cjs` example + PLUGIN_API.md §5): host →
`{ id, tool, input }`; child → `{ id, result }` | `{ id, error }`. Lifecycle in:
`{ hello }`, `{ enable }`, `{ disable }`, `{ bye }`. Unsolicited out (service only):
`{ publish: { conversationId, channel, data } }` — used to push log lines and status updates
onto DataBus channels of a conversation the plugin is enabled in (the manager verifies the
plugin is enabled in that conversation before forwarding; `data:publish` is checked in main).

### DataBus channels

**[EXTRAPOLATION]** on exact channel names (the DataBus namespace is host-owned; these are
proposed):

- `proc:<name>:log` — per-process log lines (stdout+stderr interleaved, ANSI preserved). The
  pane `data.subscribe`s the selected process's channel and `term.write()`s each value.
- `proc:status` — a snapshot array of `{ name, status, port, health, pid, exitCode }` the pane
  renders as the list. Pushed on every state change.

The pane never spawns anything and never reads state on its own; it is a pure view over these
channels + the `storage`-held custom-command list.

### Auto-discovery of npm scripts

On `enable` for a conversation, the backend needs that conversation's **cwd** to read
`package.json`'s `scripts`. See the HOST-GAP in §6 — the current `{ enable: { conversationId } }`
message carries no cwd, and the backend has no `data`/fs API of its own. Given the cwd, discovery
is a plain `JSON.parse(readFileSync(join(cwd,'package.json')))` and each `scripts` key becomes a
managed npm process whose command is the package manager's run verb (`npm run <key>`,
respecting a detected `pnpm`/`yarn` lockfile — **[EXTRAPOLATION]**).

### Port detection

**[EXTRAPOLATION]** — no host primitive exists for this; the backend does it. Two layered
strategies:

1. **Log scraping** — match common "listening on"/"Local: http://…:PORT" patterns in the
   process's stdout (fast, framework-agnostic-ish, best-effort).
2. **Port ownership by pid** — resolve which TCP port(s) the process tree is listening on.
   Cross-platform this is awkward; on win32 it means parsing `netstat -ano` and matching pids,
   on posix `lsof -i -P -n` or reading `/proc`. Scraping is primary; pid→port is the fallback
   and the confirmer. Detected ports go into the status snapshot and the port badge.

### Health checks

**[EXTRAPOLATION]** — a process may declare an optional health URL (custom commands) or one is
inferred from the detected port (`GET http://localhost:<port>/`). The backend polls it on an
interval and sets the health dot (green 2xx/3xx, red on refusal/timeout, amber while starting).
The backend can do this fetch itself (it's a Node process); it does **not** need the plugin
`net:fetch` permission (that gates the _sandboxed pane's_ host-brokered fetch, not the
backend's own network — the backend is a full Node child).

### Lifecycle & orphan prevention (critical on Windows)

This is the load-bearing correctness requirement — a managed process must **never** outlive its
owner. Four teardown paths, each must reap:

1. **Explicit stop** (user button or `proc_stop`): kill the process **tree**.
2. **Plugin disabled in the last conversation**: `PluginBackendManager.stopService` →
   `stop(pluginId)` kills the utility-process child. The backend must, on receiving `disable`
   for a conversation, kill all of that conversation's processes; and it should have a
   last-ditch reaper on its own `exit`/`beforeExit` (see below).
3. **Conversation closed** (but plugin still enabled elsewhere): the host disables the plugin
   for that conversation → `{ disable: { conversationId } }` → backend kills that conversation's
   processes. **[EXTRAPOLATION]** that closing a conversation disables its plugins for it; if the
   host does not currently emit `disable` on conversation-close, that is a HOST-GAP (§6).
4. **App quit**: `stopAll()` on the manager kills every backend child. But killing the
   **utility process** does not, on its own, kill _grandchildren_ it spawned.

**The Windows orphan problem, concretely.** On win32, `child.kill()` signals only the immediate
child. `npm run dev` typically is `npm` → `node` → `vite` (a tree), and killing `npm` orphans
`vite`, which keeps holding port 5173 — exactly the zombie the plugin exists to prevent. The
backend must therefore, per managed process:

- **[EXTRAPOLATION]** Spawn with a **detached process group** and kill the _group_, not the pid.
  On win32 the reliable reaper is `taskkill /PID <pid> /T /F` (`/T` = tree); on posix, spawn
  `detached: true` and `process.kill(-pid)` (negative pid = the group).
- Track every spawned pid and, on the backend's own shutdown, tree-kill all of them
  synchronously in a `process.on('exit')` handler as a backstop. Because the manager's
  `transport.kill()` may terminate the utility process without a graceful message, the backend
  should also handle `disable`/`bye` promptly and treat an unexpected parent-port close as
  "reap everything." **[EXTRAPOLATION]** — whether the utility process reliably runs an `exit`
  handler when the _parent_ kills it is a robustness question to verify (see §6 HOST-GAP and §9).
- **[EXTRAPOLATION]** On win32, consider assigning each process to a **Job Object** configured
  with `KILL_ON_JOB_CLOSE` — the OS then reaps the whole tree when the job handle closes, which
  is the only truly leak-proof option if the backend itself is force-killed. This needs a native
  addon or a helper; flag as optional hardening, not v1-blocking.

### Persistence & restore (PLUGIN_API.md §8 contract)

- **What persists**: the _registered_ process definitions — custom commands (label, command,
  cwd, health URL) — live in `storage` (`(conversation, plugin)`-scoped). Auto-discovered npm
  scripts are re-derived from `package.json` on each enable, so they are not persisted.
- **What does NOT persist**: a _running_ child. Processes are runtime; on restore the pane
  rebuilds the list from `storage` + fresh discovery, and everything shows `stopped`. **Atelier
  must not auto-restart processes on restore** — that would silently resurrect a `vite` days
  later. (Auto-restart-on-restore is an explicit opt-in at most — **[EXTRAPOLATION]**, and out
  of scope for v1.)
- The pane's `load` must fully rebuild from `storage` alone (treat every mount as a restore —
  PLUGIN_ARCHITECTURE.md "DO"). It then subscribes to `proc:status` to reflect anything already
  running in the shared service.

---

## 5. Agent tools + context export format

### Tools (declared in the manifest, handled in the backend)

Flow (PLUGIN_API.md §5): agent → SDK → host → backend child → result. The four `proc_*` tools
are listed in §3. Semantics:

- `proc_start(name)` → starts the process; resolves with `{ name, status, pid, port? }`. Uses
  the 30s `timeoutMs` (a slow first `vite` boot); resolves as soon as the process is spawned and
  a port is (optionally) detected, not on "fully ready".
- `proc_stop(name)` → tree-kills; resolves `{ name, status: "stopped", exitCode? }`.
- `proc_restart(name)` → stop-then-start; resolves like `proc_start`.
- `proc_status(name?, logLines?)` → with no name, the full array; with a name, that process plus
  the last `logLines` (default e.g. 40) of its log so the agent can diagnose without the user
  pasting.

The backend routes each `{ id, tool, input }` by `tool` (exactly like `backend.cjs`), but must
key work by the **conversation** the call belongs to. **[EXTRAPOLATION] / HOST-GAP (§6):** the
tool `input` as defined carries no `conversationId`; the backend needs to know which
conversation's process table to act on. Either the host must include the invoking conversation
in the tool message, or the plugin must be enabled in exactly one conversation to be
unambiguous. This must be resolved before build.

### Context export format (`processes`, `readonly`, markdown, ≤800 tokens)

A compact markdown table the host injects each turn (CONTEXT_SYSTEM.md — read into
`<atelier-context>` from `ctx:processes`). Example value:

```markdown
| process     | status             | port | health |
| ----------- | ------------------ | ---- | ------ |
| dev         | running (pid 4821) | 5173 | ok     |
| build:watch | running (pid 4903) | —    | —      |
| test:e2e    | exited (code 1)    | —    | —      |
```

Bounded by `maxTokens: 800`; the host truncates + marks. Refreshed on every state change so
"is the dev server up?" is always answerable from context without a tool call. Because it's
`readonly`, the agent cannot edit this text — it changes state via the tools, and the mirror
follows.

---

## 6. HOST-GAP

Things the current host contract/code does **not** provide that this plugin needs. Each should
be resolved (and recorded in docs/DECISIONS.md) before or during build; none is assumed to
already exist.

1. **Conversation cwd for the backend.** Auto-discovery reads `<cwd>/package.json`, but
   `{ enable: { conversationId } }` (per `PluginBackendManager`) carries **no cwd**, and a
   backend has no `agent.info()` / fs-cwd API. _Needed:_ the `enable` (and tool-call) message
   must carry the conversation's `cwd`, or a backend-side host RPC to resolve
   `conversationId → cwd`. **Gap.**

2. **Conversation identity on tool calls.** `{ id, tool, input }` has no `conversationId`. A
   shared service that manages per-conversation processes cannot tell which conversation a
   `proc_start` belongs to. _Needed:_ include the invoking `conversationId` in the tool message
   (analogous to how `publish` carries it outbound). **Gap.**

3. **`disable` on conversation close.** Orphan prevention path #3 assumes the host emits
   `{ disable: { conversationId } }` when a conversation is closed (not just when the user
   toggles the plugin off). If closing a conversation does _not_ disable its plugins, its
   processes would be orphaned until app quit. _Needed:_ confirm/guarantee conversation-close →
   service `disable`. **Gap / to confirm.**

4. **Guaranteed backend reaping on force-kill.** `PluginBackendManager.stop` calls
   `transport.kill()`. Whether an Electron `utilityProcess` reliably runs a synchronous
   `process.on('exit')` reaper before dying (so it can tree-kill its grandchildren) needs
   verification. If not, a Job Object / `taskkill /T` backstop owned by the host, or a documented
   guarantee, is required so no dev-server survives a hard backend kill on win32. **To confirm /
   possible gap.**

5. **Who writes a `readonly` context export.** CONTEXT_SYSTEM.md's `set_`/`edit_` tools are
   suppressed for `readonly` exports, and `atelier.context.set` is a **pane** API — but process
   state changes while the pane may be **closed**. _Needed:_ a way for the **backend** to update
   `ctx:processes` (e.g. the service publishing to a context channel, or a backend `context`
   RPC). Without it, a closed pane means a stale export. **Gap.** _Workaround if unavailable:_
   the pane, while open, mirrors `proc:status` into `context.set('processes', …)`; the export is
   only guaranteed-fresh while the pane is open. Note this limitation. **[EXTRAPOLATION]**

None of these gaps block the core panel + service + tools; they bound how complete
auto-discovery, context freshness, and orphan-proofing can be in v1.

---

## 7. Implementation milestones (ordered)

1. **M1 — Panel shell + custom commands (no real processes).** `kind: "both"` manifest, pane
   with a static process list from `storage` (custom commands add/remove), vendored xterm.js log
   viewer wired to a dummy channel. Verifies the pane, storage restore, and terminal rendering.
2. **M2 — Service backend + spawn/stop one process.** `service: true` backend that spawns a
   single custom command via `child_process`, streams stdout/stderr onto `proc:<name>:log`, and
   publishes `proc:status`. Pane Start/Stop buttons drive it via `plugin_control` or the tools.
   Prove the service lifecycle (`hello`/`enable`/`disable`) end to end.
3. **M3 — Tree-kill / orphan prevention.** Detached groups + `taskkill /T` (win32) /
   `kill(-pid)` (posix); `exit` backstop reaper; verify no orphaned child after stop, disable,
   conversation close, and app quit — **on Windows specifically**. Resolve HOST-GAPs #3/#4.
4. **M4 — npm auto-discovery.** Read `<cwd>/package.json` scripts on enable (resolve HOST-GAP
   #1: cwd delivery). Package-manager detection. Merge discovered + custom into the list.
5. **M5 — Agent tools.** `proc_start/stop/restart/status`, keyed by conversation (resolve
   HOST-GAP #2). `proc_status` log-tail.
6. **M6 — Port + health badges.** Log-scrape + pid→port fallback; health polling; badges in the
   list + status snapshot.
7. **M7 — Context export.** `processes` readonly markdown export, kept fresh (resolve HOST-GAP
   #5 or document the pane-open limitation). Verify injection.

Each milestone must build with no type errors and be verifiable per the acceptance criteria in
§9 before moving on (CLAUDE.md "definition of done").

---

## 8. Risks

- **Zombie processes (top risk, win32).** Killing the immediate child orphans the tree; a dead
  utility process orphans everything it spawned. Mitigation: tree-kill (`taskkill /T` /
  `kill(-pid)`), an `exit` backstop reaper, and optionally a Job Object (§4). This is the whole
  reason the plugin exists — get it right or it's net-negative. Must be tested on Windows.
- **Log volume.** A chatty dev server can emit megabytes/min. Mitigations: cap xterm scrollback
  per terminal (bounded memory), bound the backend's retained tail (a ring buffer for
  `proc_status` log-tail), and don't persist logs to `storage`. DataBus history for the log
  channel should be treated as ephemeral (PLUGIN_API.md §8 — tolerate empty on restore).
- **Shell differences on win32.** `npm`/`pnpm` are `.cmd` shims on Windows and often need
  `shell: true` (or invoking `npm.cmd`) to spawn — but `shell: true` re-introduces the
  intermediate `cmd.exe` layer that makes tree-kill essential. Command parsing, quoting, and the
  `PATH` (Node not always on PATH — see the repo's own memory note) differ from posix. Custom
  commands entered by the user must not be assumed posix. Test spawn + kill on both.
- **Shared service across conversations.** One backend child serves all enabled conversations;
  a bug that crosses conversation partitions leaks one conversation's processes/logs into
  another. Key everything by `conversationId`; validate at the boundary.
- **Backend crash budget.** `PluginBackendManager` wedges a backend after 3 crashes within 5s.
  A spawn bug that crashes the service on `enable` will wedge the whole plugin until reload — so
  spawn failures for an _individual_ dev process must be caught and reported as that process's
  status, never allowed to take down the service.
- **Health-check false negatives.** A server that binds a non-HTTP port or a non-root path reads
  as "unhealthy". Keep health advisory (a dot), never gating start/stop.

## 9. Acceptance criteria

- **Discovery:** enabling the plugin in a conversation whose cwd has a `package.json` lists
  every `scripts` entry as a managed npm process, plus any custom commands from `storage`.
- **Control (user):** Start/Stop/Restart on a row works; the status badge and port/health
  badges update; the selected process's log streams live into the xterm viewer with color
  preserved.
- **Control (agent):** `proc_start`/`proc_stop`/`proc_restart` change real process state and
  return the new status; `proc_status` returns the array (no name) or one process + a log tail
  (with name). Calls are correctly attributed to the invoking conversation.
- **Context:** the `processes` export is injected each turn and reflects current state; the
  agent can answer "is the dev server up and on what port?" from context with no tool call
  (freshness bounded per HOST-GAP #5 resolution).
- **Orphan prevention (the gate):** after **each** of — Stop button, `proc_stop`, disabling the
  plugin, closing the conversation, and quitting the app — **no managed child process (or its
  tree) remains running**, verified on **Windows** (no leftover `node`/`vite` holding the dev
  port). This is the criterion that justifies the plugin; a leak here is a release blocker.
- **Isolation:** a dev process that fails to spawn is reported as that process's `crashed`
  status and does **not** wedge the service or affect other processes/conversations.
- **Restore:** close + reopen the conversation → the list rebuilds from `storage` + fresh
  discovery, all processes shown `stopped`, nothing auto-restarted.
- **Definition of done (CLAUDE.md):** builds with no type errors; `npm run dev` launches; the
  above are demonstrably met or the un-automatable parts (esp. the Windows orphan check) are
  listed in docs/PROGRESS.md as "needs human spot-check".
