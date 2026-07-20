# http-workbench — design

> Status: **design proposal** (not built). Grounds every claim in the current contract
> (`PLUGIN_API.md`), architecture (`docs/PLUGIN_ARCHITECTURE.md`), context system
> (`docs/CONTEXT_SYSTEM.md`), the manifest Zod schema (`electron/shared/plugins.ts`), and
> the existing host network capability (`electron/plugin/netFetch.ts`). Extrapolations
> beyond what is built today are marked **[EXTRAPOLATION]**. Missing host support is
> collected under **HOST-GAP**.

A request/response console the user and the agent share. One pane holds a request builder
(method / URL / headers / body), a pretty response viewer (status, timing, JSON tree), and a
shared history. Both parties fire requests through the **same host pipe** (`net:fetch`), so
history is one stream, not two disjoint curl logs. History is a context export, so the agent
always sees what has been tried.

Proposal source: `docs/plugin-proposals/PROPOSALS.md` §9 (`http-workbench`, tier T2).

---

## 1. Purpose + user stories

**Purpose.** API development — endpoint migration, API validation, "generate the client",
webhook debugging — is a top agent use case, and today its verify step is curl-spam whose
output the user never sees structured. This plugin makes the HTTP request/response loop a
first-class, legible, shared surface: the agent fires a request and the user sees the exact
same structured result, can tweak one header, and replay.

**User stories.**

- _As a user_, I build a request (method, URL, headers, JSON body) in a form and hit Send;
  I see status, timing, response headers, and a collapsible JSON tree — not a wall of text.
- _As a user_, I open any past request from history, edit one field, and replay it — without
  retyping the whole thing.
- _As the agent_, I write a new endpoint, then fire a request at it through a backend tool;
  the response lands in the user's pane, and I get the structured result back to reason over.
- _As the agent_, on every turn I see a compact digest of recent requests (method, URL,
  status, timing) as pinned context, so I never re-ask "did that endpoint work?" — I already
  know the last N outcomes.
- _As a user debugging a local dev server_, I point requests at `http://localhost:3000/...`
  and get the same structured view I get for remote APIs.

---

## 2. Panel UX

`kind: "both"` — a panel (the console) plus a backend tool (agent-fired requests). Default
dock `right`.

### 2.1 Request builder (top of pane)

- **Method** — dropdown limited to the host allow-list: `GET | POST | PUT | PATCH | DELETE |
HEAD` (matches `METHODS` in `netFetch.ts`).
- **URL** — single-line input. `http(s)` only (host rejects other schemes with
  `must be http(s)`).
- **Headers** — key/value rows, add/remove. A note surfaces that `cookie` is **dropped by
  the host** (`netFetch.ts` strips it) so the user isn't surprised when auth-via-cookie
  fails; direct them to an `Authorization` header instead.
- **Body** — a text/code editor (Shiki/CodeMirror per stack), shown only for methods that
  carry a body (`POST|PUT|PATCH|DELETE`; the host ignores a body on `GET|HEAD`). A
  "content-type" quick-select writes the matching header. Binary bodies: the user pastes
  base64 and sets their own content-type (mirrors the `net.fetch` contract; `binary` on the
  request side means "I already base64'd it").
- **Send** — fires via `atelier.net.fetch(url, opts)`. Disabled while a request is in
  flight; shows a spinner + elapsed timer.

### 2.2 Response viewer (main area)

- **Status line** — `200 OK` colored by class (2xx green, 3xx neutral, 4xx/5xx red), plus
  **timing** (wall-clock ms measured in the pane around the `net.fetch` call — see §4.3) and
  response size in bytes.
- **Body** — content-type aware:
  - JSON → collapsible **JSON tree** (expand/collapse nodes, copy-path, copy-value). Large
    arrays are windowed.
  - Other text → highlighted raw view with a "pretty/raw" toggle.
  - Binary (`bodyBase64`) → a "binary response, N bytes" placeholder with download-to-cwd
    (via `data.writeFile`, if the plugin also holds `data:write` — optional, see §6).
- **Headers** — a collapsible response-headers table (host already lower-cases keys and
  strips `set-cookie`).
- **Error** — when the host returns `{ error }` (invalid URL, non-http scheme, body/response
  too large, timeout, network failure), the viewer shows the error string in an error card
  rather than a fake response. `net.fetch` never throws across the relay — every failure is
  `{ error }` (`netFetch.ts`), so the pane always renders one of two shapes.

### 2.3 History (side/bottom list within the pane)

- Chronological list of prior requests, each row: method badge, URL (truncated), status
  chip, timing, and a source marker (**user** vs **agent** — see §4.4). Newest first.
- Click a row → loads that request's response back into the viewer (from stored summary; the
  full body may be trimmed — see §5.2) and **populates the builder** with its method/URL/
  headers/body for **replay-with-edit**.
- History is **shared**: agent-fired requests appear here too, interleaved with the user's.
- Clear-history control. History is bounded (§5.2) so storage never grows unbounded.

### 2.4 Replay-with-edit

Selecting a history entry copies its request into the builder (fully editable), so "tweak
one header and replay" is: click entry → edit field → Send. The replay is a **new** history
entry (the original is preserved), keeping history an append-only trail of what was actually
sent.

### 2.5 Persistence / restore

Per the restore contract (`PLUGIN_API.md` §8, `PLUGIN_ARCHITECTURE.md` "treat every mount as
a potential restore"): the pane holds **no** durable state in the DOM. On `load` it rebuilds
entirely from `storage` — the history list and the last-open request live under the plugin's
`(conversation, plugin)` storage. The response viewer's current selection is derived from
history; nothing is snapshotted by the host.

---

## 3. Manifest sketch

Real JSON matching `ManifestSchema` in `electron/shared/plugins.ts`. `kind: "both"` requires
`entry` (panel) and `backend` (tools). `permissions` are validated against
`PLUGIN_PERMISSIONS`.

```json
{
  "id": "http-workbench",
  "name": "HTTP Workbench",
  "version": "0.1.0",
  "description": "A shared HTTP request/response console. Build a request (method, URL, headers, body), see a pretty response (status, timing, JSON tree), and replay from history. The agent can fire requests through the same pipe via the http_request tool, so you and the agent share one console. Recent request history is pinned to context.",
  "icon": "M2.5 8h11M8 2.5a7 7 0 0 1 0 11M8 2.5a7 7 0 0 0 0 11M2.5 8a13 13 0 0 1 11 0M2.5 8a13 13 0 0 0 11 0",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.cjs",
  "permissions": ["net:fetch", "storage", "context", "tools"],
  "defaultDock": "right",
  "tools": [
    {
      "name": "http_request",
      "description": "Fire an HTTP request through the shared HTTP Workbench console. The request and its response appear in the user's pane and are added to shared history. Returns status, headers, timing, and body (truncated if large). http(s) only; the `cookie` header is dropped by the host.",
      "inputSchema": {
        "method": {
          "type": "string",
          "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          "description": "HTTP method (default GET)",
          "optional": true
        },
        "url": "string",
        "headers": {
          "type": "object",
          "description": "Request headers as a flat string map. `cookie` is dropped by the host.",
          "optional": true
        },
        "body": "string?",
        "timeoutMs": "number?"
      },
      "timeoutMs": 65000
    }
  ],
  "contextExports": [
    {
      "key": "history",
      "label": "HTTP request history",
      "format": "markdown",
      "maxTokens": 1500,
      "readonly": true,
      "description": "Recent HTTP requests fired in this conversation (method, URL, status, timing). Maintained automatically by the plugin; read-only."
    }
  ]
}
```

Schema notes (grounded in `plugins.ts`):

- `tools[].inputSchema` accepts either the shorthand string form (`"string"`, `"number?"`)
  or the JSON-Schema-subset object form (`{ type, enum, description, optional, ... }`); both
  are used above and are within the depth-4 cap.
- `tools[].timeoutMs` (`65000`) exceeds the host's `net.fetch` max (`NET_MAX_TIMEOUT_MS =
60_000`) on purpose, leaving headroom for host round-trip and history write; it is within
  the schema max of `600000`.
- `contextExports[].readonly: true` is a real schema field — it injects the value every turn
  but registers **no** `set_`/`edit_` write-tool, so only the pane maintains it. Correct
  here: the agent shouldn't hand-edit its own request log; the plugin owns it.

---

## 4. Architecture — who performs the request, and why

### 4.1 The request is performed by the host, via `net:fetch`

Both the user's Send and the agent's `http_request` tool route to the **same** host-side
fetcher: `createNetFetcher()` in `electron/main.ts`, exposed to panes as
`atelier.net.fetch(url, opts)` and gated by the `net:fetch` permission
(`ipcMain.handle(IPC.pluginNetFetch, ...)`). This is the "one shared pipe" that the proposal
demands, and it already provides exactly the request verb we need: method allow-list,
arbitrary headers, request/response body, binary, timeout, and `{ error }`-on-failure
(`netFetch.ts`).

Rejected alternatives:

- **Pane doing its own fetch** — impossible and undesirable: the sandboxed pane has no
  network of its own (`PLUGIN_API.md` §3 `net`), by design.
- **The backend child doing the fetch** — the backend child process (over `parentPort`) is
  **not** wired to `createNetFetcher`; `net:fetch` is a _pane_ capability enforced at the
  IPC edge (`main.ts`). Giving the child raw network would fork the pipe (two code paths, two
  cap surfaces) and contradict "one shared console." Instead the agent tool routes back
  through the host fetcher — see §4.4. **[EXTRAPOLATION]** (the routing is new wiring, §6).

### 4.2 Localhost dev servers

`netFetch.ts` accepts any `http:`/`https:` URL and does **no** host allow/deny filtering, so
`http://localhost:3000` and `http://127.0.0.1:...` work today with no extra plumbing. This is
the primary API-dev use case and needs nothing beyond `net:fetch`. Aligns with `PLUGIN_API.md`
§3: "call a local dev server's API."

### 4.3 Timing

Node/Electron `fetch` doesn't return a timing breakdown, and `netFetch.ts` returns only
status/headers/body — no elapsed time. So **wall-clock timing is measured by the caller**
around the `net.fetch` call:

- Pane: measure in the pane (`performance.now()` before/after the awaited `net.fetch`).
- Agent tool: measure in the backend/host around the host fetch (§4.4).

This is round-trip time including host relay overhead, not server-only latency — label it
"round-trip" in the UI to avoid overclaiming. A precise server-timing breakdown would be a
**HOST-GAP** (§6).

### 4.4 The agent tool shares the same pipe (the core requirement)

The agent's `http_request` tool must produce a history entry and a pane update _identical in
shape_ to a user request. Flow:

```
agent → http_request tool → plugin backend child (parentPort)
      → backend asks host to perform net.fetch on its behalf   [HOST-GAP: backend net bridge]
      → host runs createNetFetcher (same fetcher the pane uses)
      → host appends a history entry (source: "agent") to the plugin's conversation storage
      → host publishes the new entry on a DataBus channel the pane subscribes to
      → pane renders it live; result also returned to the agent
```

Two things this needs that don't fully exist yet (collected in §6):

1. A way for the **backend child to invoke the host fetcher** (the child has `parentPort` to
   the host but no `net.fetch`). Options, in preference order:
   - **(a) Host performs the fetch when relaying the tool call.** Cleanest: the host, on
     `http_request`, calls `netFetch` itself (enforcing the plugin's `net:fetch` permission),
     writes history, publishes to the pane, and returns the result to the child — the child
     is a thin schema/format shim. Keeps one fetch path and one permission check.
     **[EXTRAPOLATION]** — new host wiring.
   - (b) Give the child a `parentPort` RPC back to the host fetcher. More moving parts;
     duplicates the permission check. Not preferred.
2. A **shared write path** so a user request and an agent request land in the _same_ history
   store and both refresh the pane. See §4.5.

### 4.5 Shared history store + live pane refresh

History is per-`(conversation, plugin)` state, so it lives in the plugin's `storage`
(`…/conversations/<id>/plugins/http-workbench/storage.json`) — the only guaranteed-restorable
store (`PLUGIN_API.md` §8). Both writers append there:

- **User path:** the pane writes each request it sends (and its response summary) to
  `storage` directly.
- **Agent path:** the host writes the entry when it performs the agent's fetch (§4.4 option
  a), then publishes it on a `control:`-style or plugin DataBus channel so the open pane
  merges it live without a reload. If the pane is closed, the entry is already in `storage`
  and appears on next mount.

The **history context export** (`ctx:history`) is refreshed by the pane whenever history
changes (user side) and by the host on the agent side (**[EXTRAPOLATION]** — normally
`context.update`/`ctx:` writes come from the pane; an agent-fired request updating context
while the pane is closed is the new bit — see §5.1 and §6).

### 4.6 Self-signed certs and the remote-content-is-hostile rule

- **Self-signed certs (local HTTPS dev):** `netFetch.ts` uses the default `fetch`, which
  **rejects** self-signed/untrusted TLS. There is no opt-out today. Many local dev servers
  use self-signed HTTPS, so this will bite. This is a deliberate-conservatism point, not a
  bug: silently trusting arbitrary certs is exactly the "remote content is hostile" concern.
  Proposed resolution: **do not** add blanket cert-skipping. If needed, gate a
  per-request "allow untrusted cert for this host" behind an explicit, host-side, opt-in
  flag scoped to loopback/private addresses only — a **HOST-GAP** (§6), not something the
  plugin can or should do from the sandbox.
- **Remote-content-is-hostile (CLAUDE.md invariant 3 / `PLUGIN_API.md` "Why the sandbox
  exists"):** this plugin **fetches** remote HTTP and renders the response **as data** — it
  never _executes_ remote content. That is squarely the sanctioned side of the line: the
  hostile-content posture applies to `browser:embed` (runs remote JS) and to treating fetched
  bytes as code, neither of which happens here. Concretely the viewer must:
  - Render JSON/text **as inert text** (a JSON tree, escaped) — never `innerHTML` a response,
    never `eval`, never build a live DOM from response markup. An HTML response is shown as
    highlighted source, not rendered.
  - Treat response header/body strings as untrusted display data (the host already strips
    `set-cookie` and lower-cases header keys).
    This keeps the plugin on the "fetch text, don't run it" side that `net:fetch` explicitly
    permits and `browser:embed` explicitly does not.

---

## 5. Agent tool + history context export

### 5.1 History context export format

Declared as `contextExports[0]` (§3), `format: "markdown"`, `readonly: true`,
`maxTokens: 1500`. The pane maintains `ctx:history` as a compact, human-and-agent-readable
digest of **recent** requests — not full bodies. Example value:

```markdown
# HTTP request history (most recent first)

- POST http://localhost:3000/api/users → 201 Created · 34ms · agent
  req: {"name":"Ada"} · resp: {"id":"u_88","name":"Ada"}
- GET http://localhost:3000/api/users/u_88 → 200 OK · 12ms · user
  resp: {"id":"u_88","name":"Ada","active":true}
- GET https://api.example.com/v1/ping → 500 Internal Server Error · 210ms · agent
  resp: {"error":"db unavailable"} (body 1.2 KB, truncated)
```

Rules:

- Each entry: `METHOD URL → status · timing · source`, plus a **one-line trimmed** request
  and response snippet.
- Bodies are **trimmed to a small per-entry cap** (e.g. 200–400 chars each) before entering
  the digest; a `(truncated)` / `(body N KB)` marker preserves honesty. Full bodies never
  enter context.
- Only the most recent K entries are included; if the rendered digest would exceed
  `maxTokens`, the host truncates with its standard marker (context injection is host-bounded
  per `CONTEXT_SYSTEM.md` / `plugins.ts` `maxTokens`). The pane should pre-trim to K so the
  host rarely has to.

This makes "the agent always knows the last N outcomes" work with **no** re-inspection turn,
matching the proposal's "history is also a context export."

### 5.2 Response bodies can be huge — size discipline

Two independent size regimes:

- **Transport cap (host, already enforced):** `NET_MAX_RESPONSE_BYTES = 4_000_000` (4MB) and
  `NET_MAX_REQUEST_BYTES = 2_000_000` (2MB). Over-cap responses come back as
  `{ error: "response too large ..." }` — the viewer shows that error; nothing huge is ever
  buffered into history.
- **Storage/history cap (plugin):** the full response body (up to 4MB) may be viewed live,
  but history must **not** store every full body or `storage.json` bloats without bound.
  Policy:
  - Store per-entry: method, URL, request headers (with secret redaction — §8), request body
    (capped, e.g. ≤ 64KB), status, timing, response headers, and a **capped** response body
    (e.g. ≤ 128KB) plus `bodySize`.
  - Keep at most **N** history entries (e.g. 50) FIFO.
  - The last full response is available in the viewer for the current session; older entries
    show the capped body with a "response was N KB, trimmed" note.
  - The context digest (§5.1) is far smaller still.

### 5.3 The `http_request` tool

Input per §3 (`method?`, `url`, `headers?`, `body?`, `timeoutMs?`). Behavior:

- Validates input (host compiles `inputSchema` to Zod), performs the request via the shared
  host fetcher (§4.4), writes a history entry (`source: "agent"`), refreshes the pane and the
  context digest.
- Returns to the agent a structured result mirroring `NetFetchResult` plus timing:
  `{ status, statusText, headers, timingMs, bodyText? | bodyBase64?, truncated?, bodySize }`.
  The returned body is capped for the agent too (large bodies are expensive tokens) — return
  a capped body + `bodySize` + `truncated: true`, and let the agent narrow with a follow-up
  request if it needs a specific slice. **[EXTRAPOLATION]** on the exact cap.
- On host `{ error }`, the tool returns the error string as its result (never throws) so the
  agent can reason about the failure.

---

## 6. HOST-GAP

Things this design needs that are **not** in the current host, roughly in build order:

1. **Backend/tool → host fetcher bridge.** Today `net:fetch` is a _pane_ IPC handler; the
   backend child has no route to `createNetFetcher`. Needed: when the host relays the
   `http_request` tool call, the host itself performs the fetch under the plugin's
   `net:fetch` permission (preferred: §4.4 option a). Small, contained new wiring in
   `main.ts`; reuses `netFetch` and the existing permission check.
2. **Host-side history write + pane push for agent requests.** A path for the host (not the
   pane) to append to the plugin's `storage` and publish the new entry on a DataBus channel
   the pane subscribes to, so an agent request updates a **closed** pane's stored history and
   a **open** pane live. Storage-writes-from-host mirror what the context tools already do
   (`CONTEXT_SYSTEM.md`: "handlers run in the main process on storage").
3. **Host-side context refresh for agent requests.** The `ctx:history` digest must refresh
   when the agent fires a request even if the pane is closed. Context write-from-host exists
   for the auto-generated `set_`/`edit_` tools; here the _plugin's own tool_ (via the host)
   must update `ctx:history`. Likely a thin reuse of the context-store write path. Depends on
   (2).
4. **Optional: server-timing breakdown.** `netFetch.ts` returns no timing. Round-trip timing
   is caller-measured (§4.3); a DNS/connect/TTFB breakdown would need host support and is out
   of scope for v1.
5. **Optional: untrusted-cert opt-in for loopback/private hosts.** `fetch` rejects
   self-signed certs and there's no opt-out (§4.6). If local-HTTPS-dev demand is real, add a
   **narrowly scoped**, host-enforced, explicit opt-in (loopback/private ranges only) — never
   a blanket bypass. Defer unless demanded.
6. **Optional: streaming responses.** `net.fetch` is one-shot (`netFetch.ts`: "No streaming
   in v1 — a poller re-fetches"). SSE / chunked / long-poll endpoints are out of scope; the
   pane can offer a manual "re-fetch" poller. A true streaming verb is a separate host
   capability. (See §8 risks.)

Everything else (the request verb, method allow-list, cookie isolation, body/response caps,
`context`/`storage`/`tools` permissions, the manifest fields including `readonly` exports) is
already present.

---

## 7. Implementation milestones (ordered)

1. **M1 — Pane MVP (user-only, no agent, no history).** `kind: "panel"` first: builder
   (method/URL/headers/body) + Send via `atelier.net.fetch` + response viewer (status,
   round-trip timing, JSON tree, headers, error card). Permissions: `net:fetch`. Proves the
   shared pipe end-to-end against localhost and a public API.
2. **M2 — History + replay-with-edit + restore.** Add `storage` permission. Append each sent
   request/response summary to `storage` (capped, FIFO — §5.2); render the history list;
   click-to-load and replay-with-edit; full rebuild from `storage` on `load`. Verify
   close/reopen restores history.
3. **M3 — History context export.** Add `context` permission + `contextExports` (`readonly`
   `ctx:history`). Pane maintains the markdown digest (§5.1) on every history change; verify
   the agent sees recent requests each turn.
4. **M4 — Agent tool (`http_request`) sharing the pipe.** Add `backend` + `tools`; implement
   the HOST-GAP items (§6.1–6.3): host performs the agent's fetch, writes shared history,
   pushes to the pane, refreshes the context digest, returns a capped result. Verify: agent
   fires a request → it appears in the user's open pane, in history, and in the next turn's
   context.
5. **M5 — Polish + safety.** Secret redaction in stored/exported headers (§8); binary
   response handling + optional download-to-cwd (needs `data:write`); large-body windowing in
   the JSON tree; content-type quick-selects; clear-history.

Each milestone must build, launch under `npm run dev`, and meet its acceptance criteria
before the next (per CLAUDE.md).

---

## 8. Risks

- **Secrets in headers.** `Authorization`, API keys, and bearer tokens live in request
  headers. Risks: (a) they get **persisted** into `storage.json` on disk, and (b) they leak
  into the **context export** injected to the model. Mitigations:
  - Redact sensitive request headers (`authorization`, `x-api-key`, `cookie`-like, anything
    matching a token pattern) before writing history and **always** before building the
    context digest — store/show `Authorization: Bearer •••` with only a short prefix/suffix.
  - Never put full auth headers in `ctx:history`. The digest is header-light by default.
  - Note the host already drops `cookie` on the wire; this risk is about _at-rest_ and
    _in-context_ copies, which the plugin owns.
- **Huge responses.** Bounded at the wire by `NET_MAX_RESPONSE_BYTES` (4MB → `{ error }`
  over-cap), but a 3.9MB JSON response is still heavy to tree-render and must **not** be
  stored whole in history nor returned whole to the agent. Mitigations: viewer windows large
  arrays; history stores a capped body + size (§5.2); the tool returns a capped body +
  `truncated` (§5.3). The context digest never carries a full body.
- **Streaming / long-poll endpoints.** No streaming in v1 (host limitation). An SSE or
  chunked endpoint either times out (max 60s) or returns a partial buffered body. Mitigation:
  document the limitation in-pane; offer a manual re-fetch poller; treat true streaming as a
  future host capability (§6.6). Don't fake it.
- **Timing is round-trip, not server latency** (§4.3) — label it honestly so users don't read
  host-relay overhead as API slowness.
- **Self-signed local HTTPS fails** (§4.6) — surface a clear, specific error ("TLS cert not
  trusted; use http:// for local dev or see host cert opt-in") rather than a bare fetch
  error, so users aren't confused.

---

## 9. Acceptance criteria

- **Shared pipe.** A request sent from the pane and a request fired by the agent's
  `http_request` tool both go through the **same** host fetcher and land in the **same**
  history list, each tagged `user` / `agent`.
- **Builder + viewer.** The pane sends `GET/POST/PUT/PATCH/DELETE/HEAD` with custom headers
  and a JSON body; the viewer shows status (colored by class), round-trip timing, response
  size, response headers, and a collapsible JSON tree for JSON responses; a host `{ error }`
  renders as an error card, never a fake 200.
- **Localhost.** A request to `http://localhost:<port>` succeeds with no extra config.
- **History + replay.** Every sent request appears in history; clicking one loads its
  response and repopulates the builder; editing a field and re-sending creates a **new**
  entry while preserving the original.
- **Restore.** Close the conversation / quit / reopen → the pane rebuilds its full history
  from `storage` alone at its saved dock position (no host DOM snapshot).
- **Context export.** With the plugin enabled, the agent sees a compact, most-recent-first
  history digest each turn (method/URL/status/timing + trimmed snippets), bounded by
  `maxTokens`, with no full bodies and no raw auth headers.
- **Size discipline.** A ~4MB response viewer-renders without freezing (windowed), is **not**
  stored whole in history, and is returned to the agent capped with a `truncated` marker; an
  over-4MB response surfaces the host's "response too large" error.
- **Agent → open pane.** When the agent fires `http_request` while the pane is open, the new
  entry appears live in the user's pane without a reload; when the pane is closed, it is
  present on next mount.
- **Secret hygiene.** Auth-style headers are redacted in stored history and absent/redacted in
  the context digest.
- **Containment.** A malformed request, an over-cap body, a timeout, or a network failure
  yields a clean in-pane error and a clean tool result — never a throw into the host, never a
  crash of the pane or another plugin (`PLUGIN_API.md` §3 `net`, invariant 3).

```

```
