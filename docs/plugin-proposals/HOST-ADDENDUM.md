# Host-API addendum — verbs to land before the 2026-07-20 plugin builds

Status: **build spec** (approved direction from user review 2026-07-20). This consolidates the
per-doc HOST-GAPs in `designs/` into one implementable slice. Everything here follows the
existing contract patterns: cwd-scoped, Zod-validated at the receiving side, permission-gated,
`{ error }`-returning (never throwing into the host). Update `PLUGIN_API.md` and the
`plugin_authoring_guide` text for every verb you add.

Ground truth to verify before coding (the design docs cite these): `electron/shared/events.ts`
(AgentEvent union, IPC channel ids, existing plugin schemas), `electron/plugin/runtime.ts`
(sandbox `window.atelier` surface), `electron/plugin/fileWrite.ts` (+ test — `resolveWithinCwd`
guard), the backend parentPort protocol, and the manifest permission enum in
`electron/shared/plugins.ts`.

## Tier 1 — required tonight

### A1. `atelier.fs.list(dir?)` — permission `fs:list`

Read-only, cwd-scoped, **non-recursive** directory listing (one level per call).

```ts
fs.list(dir?: string): Promise<
  | { entries: { name: string; kind: 'file' | 'dir'; size?: number; mtime?: number; ignored: boolean }[]; truncated?: boolean }
  | { error: string }>
```

- `dir` cwd-relative, `''` = root. Same `resolveWithinCwd` guard as `writeFile`; `{ error }` on escape.
- `ignored` computed host-side (`.gitignore` + built-in defaults: `.git/`, `node_modules/`). A
  correct-enough single-file `.gitignore` evaluation is fine for v1; nested/negated rules are a
  polish item. Cap entries per dir (5000) with `truncated: true`.

### A2. `atelier.shell.openPath(path)` — permission `shell:open`

Open a cwd-relative file in the OS default handler. Backed by the existing `app:open-path`
main handler but **re-gated**: `resolveWithinCwd`, refuse escape with `{ error }`. Do NOT expose
the renderer's unscoped `app.openPath` to sandboxes.

### A3. `atelier.agent.compose(text)` — permission `agent:compose`

Stage text into THIS conversation's chat composer at the cursor **without sending** (distinct
from `agent.send`). Length-capped (~4KB). Renderer shell inserts into the ChatPanel composer for
the pane's conversation; if that composer is not mounted, return `{ error: 'composer not open' }`.

### A4. `atelier.os.*` — permission `os:notify`

```ts
os.notify(n: { title: string; body: string; sound?: boolean; tag?: string }): Promise<{ id: string } | { error: string }>
os.onNotificationClick(cb: (e: { id: string }) => void): () => void   // clicks on THIS plugin's notifications
os.flashFrame(on: boolean): Promise<void>                              // BrowserWindow.flashFrame
os.setBadgeCount(n: number): Promise<void>                             // best-effort on Windows (overlay icon or no-op; don't over-engineer)
os.isWindowFocused(): Promise<boolean>
os.onWindowFocusChange(cb: (focused: boolean) => void): () => void
```

Main-side: Electron `Notification` (silent unless `sound`), `tag` coalesces (close+replace an
earlier notification with the same tag from the same plugin). Notification click also
focuses/raises the Atelier window (accept Windows foreground-lock limits). Rate-cap host-side
(e.g. ≤1 notification / plugin / 3s; excess coalesced or dropped with `{ error }`).

### A5. `atelier.agent.history(limit?)` — existing permission `agent:read`

Bounded mount-time backfill of this conversation's normalized `AgentEvent` trace:
`Promise<AgentEvent[]>` (oldest→newest, default 200, max 1000). Main keeps a bounded
per-conversation ring (e.g. last 1000 events, in-memory is acceptable for v1; note persistence as
future work). This is the "main proc logs the information and exposes it" requirement from the
user review — agent-flow, timeline restore, and heat backfill all hang off it.

### A6. Backend lifecycle context

- Include `cwd` in the `hello` payload and in each `enable` payload (`{ enable: { conversationId, cwd } }`).
- Include `conversationId` on every tool invoke posted to a backend (`{ id, tool, input, conversationId }`).
  Keep the reply shape unchanged.

### A7. Panel→backend RPC — no new permission (requires the plugin to declare a `service` backend)

```ts
atelier.backend.call(op: string, params?: unknown, timeoutMs?: number): Promise<unknown>  // rejects -> { error } style result
```

Host posts `{ id, rpc: { conversationId, op, params } }` to the plugin's service backend; backend
replies `{ id, result } | { id, error }`. Same 30s default / 600s max timeout discipline as tools.
Payload caps like tool IO. This kills the "abuse DataBus for pane→backend calls" pattern.

### A8. Backend storage access

Backends need config the pane wrote (e.g. notification channel settings) even when the pane is
closed. Give backends a parentPort request/response for the SAME per-(conversation, plugin)
storage the pane sees:

```
backend → host: { id, storage: { op: 'get' | 'set' | 'keys', conversationId, key?, value? } }
host → backend: { id, result } | { id, error }
```

Gated by the plugin's existing `storage` permission. Ship a tiny helper for backends (documented
pattern in PLUGIN_API.md is fine; no SDK package needed).

## Tier 2 — stretch (only if Tier 1 is green and time remains)

- **B1 `agent:read-all`**: `agent.onAnyEvent(cb)` (events tagged `conversationId`),
  `agent.listConversations()` — see designs/attention.md HOST-GAP A.
- **B2 `agent.focusConversation(id)`** — designs/attention.md HOST-GAP D.
- **B3 app-scoped storage** `storage.global.*` — designs/attention.md HOST-GAP C.

## Definition of done

- New permissions added to the manifest enum + rail display; every new IPC payload Zod-validated
  main-side; every verb returns `{ error }` on denial (no throws across the boundary).
- Unit tests where the pattern already exists (path-scoping tests mirroring `fileWrite.test.ts`;
  schema tests). `npm run ci:status`-style local gate green (typecheck, lint, format:check, tests).
- `PLUGIN_API.md` + the in-app `plugin_authoring_guide` source updated for every verb/permission.
- One line per decision in `docs/DECISIONS.md`; progress notes in `docs/PROGRESS.md`.
