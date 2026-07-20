# db-explorer — design doc

Status: **design** (not built). Grounds itself in PLUGIN_API.md, docs/PLUGIN_ARCHITECTURE.md,
and docs/CONTEXT_SYSTEM.md. Proposal source: docs/plugin-proposals/PROPOSALS.md §10
(`db-explorer`, T2). Claims that go past the current contract are marked **[EXTRAPOLATION]**;
missing host capabilities are collected under **HOST-GAP**.

> One-line intent (from PROPOSALS §10): connect to a SQLite file or Postgres URL, read-only by
> default; show a schema tree and a query editor; render results as a real sortable/pageable
> grid; give the agent `db_query`/`db_schema` tools **whose results also render in the pane**;
> export the current schema summary as a pinned context document so the agent stops re-inspecting.

`kind: "both"` — it is a panel (schema tree + editor + grid), a tool backend (`db_query`,
`db_schema`), and a context-document plugin (`schema` export). It is the first proposal that
needs a **stateful service backend** (a live DB connection), which drives most of the design
below.

---

## 1. Purpose + user stories

**Purpose.** Databases are a top-ranked MCP category, but MCP DB servers dump tables _as prose
into the transcript_ (PROPOSALS §10) — the worst rendering for tabular data, and a token sink.
db-explorer moves the result set out of the chat bubble into a real grid that the user and the
agent look at _together_, and keeps the schema permanently in context so the "let me re-inspect
the schema" turn disappears.

**User stories.**

1. _As a developer debugging a migration,_ I connect to my dev SQLite file, the agent runs
   `db_query` to inspect the offending rows, and the result appears in **my** pane as a grid —
   so "why is this migration wrong" is investigated with both of us on the same result set.
2. _As a user,_ I open the schema tree, click a table, and get a `SELECT * … LIMIT 100` scaffold
   in the editor without typing it.
3. _As the agent,_ on every turn I already have the schema summary pinned in context, so I write
   correct column names on the first try instead of spending a turn on `db_schema`.
4. _As a cautious user,_ I connect read-only by default; the connection physically cannot write.
   When I _do_ want the agent to run a migration, I flip an explicit **Allow writes** switch and
   the change is visible in the pane before I confirm.
5. _As a returning user,_ I reopen the conversation days later; the pane restores to the same
   connection target and remembers my last query — but does **not** silently reconnect to a
   remote Postgres without a click (credential-safety, §9).

---

## 2. Panel UX

Three stacked regions in one pane (DESIGN_SYSTEM tokens; no bespoke chrome): **connection bar**
(top), **schema tree** (left column), **editor + result grid** (right column, split
horizontally). All copy uses `--faint`/`--accent` per the icon rule in PLUGIN_API §1.

### 2.1 Connection flow

- Empty state: a single field with a driver toggle — **SQLite** (a cwd-relative file path, e.g.
  `./dev.db`, or a picker restricted to the conversation cwd) or **Postgres** (a connection URL
  `postgres://…`). A **Read-only** checkbox is **on** and prominent by default.
- **Connect** hands the target to the backend (§4). On success the schema tree populates and the
  bar collapses to a status chip: driver icon · database name · `read-only` / `writes-on` badge ·
  a disconnect control.
- **Failure** (bad path, refused connection, auth error) renders inline in the bar, never throws
  into the host (PLUGIN_API §2). The message is the driver's error string, truncated.
- The connection **target** (driver + path/URL-without-password, read-only flag, last query) is
  written to `storage` so `load` can rebuild the bar. See §9 for why the password is **not**
  stored and a remote connect is never automatic on restore.

### 2.2 Schema tree

- Left column: databases → schemas (Postgres) → tables/views → columns, lazily expanded. Each
  column row shows name · type · PK/FK/nullable markers. A table row has two affordances:
  _insert a `SELECT * … LIMIT n` scaffold into the editor_, and _copy qualified name_.
- Built from the same introspection the backend uses for the context export (§5), so the tree and
  the exported summary never disagree.
- Refresh control re-introspects; also auto-refreshed after a successful **write** (§4.4).

### 2.3 Query editor

- CodeMirror 6 with SQL highlighting (stack-approved in CLAUDE.md: "Shiki (or CodeMirror 6)").
  Cmd/Ctrl-Enter runs. The editor value is persisted to `storage` (last query) each edit, debounced.
- A **row-limit** selector (default 100, capped — §6) and a **page size** control sit on the run bar.
- When **read-only** is on, a statement the parser classifies as a write is refused _before_ it
  reaches the driver, with a "writes are off — enable in the connection bar" hint (belt to the
  driver's suspenders in §4.4).

### 2.4 Result grid

- Sortable (client-side within the fetched page), pageable (offset/limit re-query for pages beyond
  the fetched window — see §6), column-resizable. NULL rendered distinctly from empty string.
- Footer: row count of the current page, total-if-known, elapsed ms, and a **truncated** marker
  when the backend capped the set (§6). A "copy as CSV" / "copy as Markdown" affordance for the
  current page.
- **Non-SELECT results** (when writes are on): render the affected-row count and, for
  `RETURNING`/`SELECT`, the returned rows.

### 2.5 Shared result view — the agent queries into _this_ pane

This is the load-bearing UX from the proposal. When the agent calls `db_query`/`db_schema`:

1. Tool call → SDK → host → **service backend** runs it on the live connection (§4).
2. Backend returns the (capped) result to the agent **and** publishes the same result set onto a
   DataBus channel (`db:result` — see §4.3) that the pane subscribes to.
3. The pane renders it in the _same_ grid the user's own queries use, tagged with a small "from
   agent" provenance chip and the SQL text, so the user sees exactly what the agent ran and got.

Result: one shared console, not two disjoint query streams — matching the `http-workbench` shared-
history pattern (PROPOSALS §9) but for SQL. The grid is provenance-tagged (`you` vs `agent`) and
keeps a short scrollback of recent result sets (persisted count-bounded, §6/§9).

---

## 3. Manifest sketch

Real JSON against the schema in PLUGIN_API §1/§5 and docs/PLUGIN_ARCHITECTURE §2. `kind: "both"`;
`service: true` because the connection is long-lived (PLUGIN_API §5 "Backends: service"); it
declares `tools`, a `schema` `contextExport`, and least-privilege `permissions`.

```jsonc
{
  "id": "db-explorer",
  "name": "DB Explorer",
  "version": "0.1.0",
  "description": "Connect to a SQLite file or Postgres URL (read-only by default). Browse the schema, run queries in a grid, and let the agent run db_query/db_schema whose results render in the same pane. The current schema summary is pinned into context.",
  "icon": "M3 4.5c0-1 2.2-1.8 5-1.8s5 .8 5 1.8-2.2 1.8-5 1.8-5-.8-5-1.8zM3 4.5v7c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-7M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.cjs",
  "service": true,
  "defaultDock": "right",
  "permissions": ["tools", "storage", "data:subscribe", "data:publish", "context"],
  "contextExports": [
    {
      "key": "schema",
      "label": "Database schema",
      "format": "markdown",
      "maxTokens": 2000,
      "readonly": true
    }
  ],
  "tools": [
    {
      "name": "db_query",
      "description": "Run a read-only SQL query on the connected database and return rows. Results also render in the DB Explorer pane. Writes are refused unless the user has enabled write mode. Large result sets are truncated; use LIMIT and the returned truncation flag.",
      "inputSchema": {
        "sql": "string",
        "limit": "number?"
      },
      "timeoutMs": 30000
    },
    {
      "name": "db_schema",
      "description": "Return the schema of the connected database (tables, columns, types, keys) as structured JSON. Prefer the pinned schema context export first; call this only to refresh or drill in.",
      "inputSchema": {
        "table": "string?"
      }
    }
  ]
}
```

Notes on the field choices, all traceable to the contract:

- `permissions`: `tools` (register `db_query`/`db_schema`, requires a backend — PLUGIN_API §4),
  `storage` (persist connection target + last query + result scrollback — §8), `data:publish`
  (service pushes agent results onto `db:result` — §5 service backends, §4 `data:publish`),
  `data:subscribe` (the pane reads that channel), `context` (push the schema summary via
  `context.update` — PLUGIN_ARCHITECTURE §2 / CONTEXT_SYSTEM). No `net:fetch`, no `data:write`,
  no `browser:embed` — least-privilege.
- `contextExports.schema.format: "markdown"` so the agent reads it as prose (CONTEXT_SYSTEM shows
  `markdown`/`text` formats). Auto-pinned on enable, un-pinned on disable (CONTEXT_SYSTEM).
- The `set_db-explorer__schema` / `edit_db-explorer__schema` tools the host auto-generates for
  every export (CONTEXT_SYSTEM §2) are **not wanted here** — the schema is derived from the live
  DB, not agent-authored. **This capability already exists** (correcting an earlier draft that
  flagged it as HOST-GAP #1): `ContextExportSchema` in `electron/shared/plugins.ts` has a
  `readonly: z.boolean().default(false)` field — a readonly export is injected into context but
  gets no agent write-tools (cognition's `north-star` export uses it). The manifest above should
  declare `"readonly": true` on the `schema` export; no host change needed.

---

## 4. Architecture

### 4.1 Where the driver lives

The DB driver runs **only in the service backend child** (`backend.cjs`), never in the renderer
(sandboxed, no fs/network — PLUGIN_API §3 "Not exposed") and never in the main process (keep
native modules out of the app process; a driver crash must be contained). This matches the
existing `tool-plugin/backend.cjs`, which runs as an **Electron utility process** talking over
`process.parentPort` with `{ id, tool, input }` → `{ id, result | error }`. db-explorer is the
same protocol plus the service lifecycle (`hello`/`enable`/`disable`/`bye`) and unsolicited
`publish` messages (PLUGIN_API §5).

### 4.2 Driver strategy + native-module concerns (the real risk)

Candidates:

- **SQLite:** `better-sqlite3` — synchronous, simple, ideal for a utility process, and supports a
  true read-only open (`{ readonly: true }`). **But it is a native addon** compiled against a
  specific Node/Electron ABI. In an Electron app native addons must be built for **Electron's**
  ABI (via `electron-rebuild`/`@electron/rebuild`) and re-bundled per platform; the utility
  process runs Electron's Node, so the addon must match the Electron ABI, not the system Node.
  **[EXTRAPOLATION]:** if the packaging pipeline can't reliably rebuild native addons, the
  fallback is **`node:sqlite`** (the built-in SQLite, stable in recent Node/Electron — verify the
  bundled Electron's Node version) or the WASM build **`sql.js`** (no native compile, slower, whole
  DB in memory — fine for small dev DBs). **Decision: prefer `node:sqlite` if the bundled Electron
  ships it; else `better-sqlite3` with `@electron/rebuild` wired into packaging; `sql.js` as the
  zero-native escape hatch.** Record the final choice in docs/DECISIONS.md.
- **Postgres:** `pg` (node-postgres) — **pure JS, no native addon** (its optional `pg-native` is
  _not_ used), so it bundles into the utility process cleanly. This is why **SQLite ships first**
  (native-module packaging is the hard part) and **Postgres second** (`pg` is the easy driver but
  the credential/locking risks are bigger — §9).

Drivers sit behind a small internal `Driver` interface in the backend
(`connect(target, {readonly})`, `introspect()`, `query(sql, {limit})`, `close()`), so the tool
handlers and the introspection code are driver-agnostic and a third driver (MySQL, DuckDB) is an
additive change.

### 4.3 Channels used

- `db:result` — backend → pane: every executed result set (user _and_ agent), `{ provenance,
sql, columns, rows, rowCount, truncated, elapsedMs, error? }`. Backend publishes (needs
  `data:publish`), pane subscribes (needs `data:subscribe`). This is what makes agent queries
  render in the pane (§2.5).
- `control:db-explorer` — the built-in `plugin_control` lever (PLUGIN_ARCHITECTURE §3): the agent
  can, e.g., `{command: "run", payload: {sql}}` or `{command: "connect", payload: {…}}` without
  new bespoke tools. **[EXTRAPOLATION]** the control channel is delivered to the _pane_
  (PLUGIN_ARCHITECTURE §3 says the plugin subscribes to `control:<id>`); for a command that must
  hit the live connection, the pane forwards it to the backend — or the backend owns it. See
  HOST-GAP #2.

### 4.4 Connection lifecycle + read-only enforcement

- **Spawn:** as a `service: true` backend, the child spawns when the plugin is first enabled in a
  conversation and is killed when disabled in the last one (PLUGIN_API §5). It does **not** connect
  on spawn — connection is an explicit user (or agent-`control`) action, so enabling the plugin
  never auto-opens a remote DB (§9).
- **Connect:** the pane (or `plugin_control`) sends a connect command with the target + `readonly`.
  The backend opens exactly one connection (or a tiny pool for Postgres) and caches the driver
  handle keyed by `conversationId`.
- **Read-only enforcement — two layers, driver is authoritative:**
  1. **Driver-level (authoritative):** SQLite opened `{ readonly: true }`; Postgres runs on a
     connection that issues `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` / `SET
default_transaction_read_only = on` and, ideally, connects as a role with no write grants.
     A write physically fails at the engine. **This is the guarantee**, per invariant "read-only by
     default" (PROPOSALS §10).
  2. **Statement-level (fast-fail + UX):** a lightweight SQL classifier in the backend rejects
     anything that isn't a `SELECT`/`WITH…SELECT`/`EXPLAIN`/`PRAGMA`(read) before it reaches the
     driver, returning a clear "writes are off" error. It's a convenience/clarity layer, **not** the
     security boundary — the driver open is.
- **Opt-in for writes:** flipping **Allow writes** re-opens the connection _without_ the read-only
  flag (SQLite: reopen r/w; Postgres: drop `read_only`, or reconnect as a write-capable role) and
  updates the badge. The classifier then permits writes. Every write refreshes the schema tree and
  re-pushes the schema export (§5). **[EXTRAPOLATION]:** writes from the _agent_ (`db_query` with a
  write) should require the write mode to have been enabled _by the user in the pane_ — the agent
  cannot flip its own write switch. Enforced by keeping the write-mode flag in the backend's
  per-conversation state, settable only via the pane's connect/allow-writes path, never via the
  tool input.
- **Idle / teardown:** on `disable`/reload the backend closes all connections (`close()`), so a
  reloaded plugin runs fresh code with no leaked handles (PLUGIN_API §5, CLAUDE.md backend rule).
  **[EXTRAPOLATION]** an idle-timeout that closes the connection after N minutes of no query
  reduces the "locking a dev DB" risk (§9); reconnect transparently on the next query.

---

## 5. Schema context export — format, staleness, refresh

The `schema` export (§3) is a compact **markdown** summary the host injects each turn
(CONTEXT_SYSTEM §2), auto-pinned on enable, `maxTokens: 2000`, truncation-marked by the host.

**Format** — one section per table, dense enough to fit many tables under the cap:

```md
# Schema — dev.db (SQLite, read-only)

_introspected 2026-07-19T14:02Z_

## users (table)

- id integer PK
- email text NOT NULL UNIQUE
- created_at integer NOT NULL
- org_id integer FK → orgs.id

## orgs (table)

- id integer PK
- name text NOT NULL

## active_users (view)

- …
```

- **Budget strategy under `maxTokens`:** columns first for every table; if it won't fit, degrade
  gracefully — drop nullable/type detail before dropping table/column _names_, and append
  `…N more tables (call db_schema)` so the agent knows to drill in rather than assume the tail is
  empty. (CONTEXT_SYSTEM warns a truncated value the agent only ever saw truncated is dangerous —
  hence a summary the agent _knows_ is a summary, with the `db_schema` escape hatch.)

**Staleness / refresh** — the freshness contract of PLUGIN_ARCHITECTURE §2 ("push a fresh snapshot
whenever something changes"): the plugin calls `context.update('schema', md)` on:

- successful connect / reconnect,
- a successful **write** (schema may have changed),
- an explicit tree **Refresh**,
- **[EXTRAPOLATION]** optionally on a low-frequency poll of the DB's schema version
  (SQLite `PRAGMA schema_version`; Postgres catalog/event-trigger or a cheap `pg_class` hash) so
  out-of-band migrations (someone else runs a migration) are caught. Bounded polling only.

The export is **plugin-owned/read-only** (the manifest's `"readonly": true` flag — a real
`ContextExportSchema` field): the agent reads it, never overwrites it — unlike the agent-authored
`data-table`/`living-doc` exports.

---

## 6. Result-set size limits (backend → panel → agent) — tokens matter

Three hops, three separate caps, because the agent hop is a **token** budget, not a byte budget —
the whole reason this plugin exists is that tables in the transcript are a token disaster.

- **Backend → panel (`db:result`):** cap at the requested `limit` (default 100, hard cap
  **[EXTRAPOLATION]** ~1,000 rows) **and** a byte cap on the serialized payload (e.g. 2 MB, aligned
  with the host's other payload caps in PLUGIN_API §3). The grid pages beyond the fetched window by
  **re-querying** with a new offset (§2.4), so the pane never holds an unbounded set in memory.
- **Backend → agent (`db_query` result):** a **much tighter** cap — this is the token-sensitive
  hop. Default return **≤ 50 rows** and truncate wide/long cell values (e.g. ≥256 chars → elided
  with a marker), returning a structured envelope:
  `{ columns, rows, rowCount, truncated: true, note: "showing 50 of 1240; add LIMIT/WHERE or view
the pane" }`. The tool description (§3) tells the agent to expect truncation and use `LIMIT`.
  **The agent gets a legible summary; the full page lives in the grid** — exactly the split the
  proposal wants.
- **Panel scrollback (storage):** persist only the **last N** result sets (count-bounded, e.g. 5)
  and only _metadata + a capped row window_ per set, so `storage.json` doesn't grow without bound
  (§9 big-tables risk).

The caps are the plugin's, enforced in the backend, and independent of any host-side `maxTokens`
(which only bounds the pinned **schema** export, §5).

---

## HOST-GAP

Capabilities the current contract (PLUGIN_API / PLUGIN_ARCHITECTURE / CONTEXT_SYSTEM) does not
provide, that this plugin needs. Each should become a docs/DECISIONS.md item before build.

1. ~~Read-only / plugin-owned context exports.~~ **RESOLVED — not a gap.** `ContextExportSchema`
   already has `readonly: z.boolean().default(false)` (`electron/shared/plugins.ts`): a readonly
   export is injected but gets no auto-generated agent write-tools (cognition's `north-star`
   uses it). Declare `"readonly": true` on the `schema` export.
2. **Control delivery to a backend, not just the pane.** PLUGIN_ARCHITECTURE §3 delivers
   `plugin_control` over `control:<id>` to the _plugin_ (the pane subscribes). A DB command must
   reach the **live connection** in the backend. Either (a) define that a `service` backend also
   receives `control:` messages, or (b) accept that the pane forwards control → backend over an
   internal channel (works only while the pane is mounted). Decide and document.
3. **A cwd-scoped file picker / path validation for SQLite.** The pane can't touch fs
   (PLUGIN_API §3). Resolving `./dev.db` to an absolute path and confirming it's inside the
   conversation cwd must happen host- or backend-side. `data.readAsset`/`writeFile` are cwd-bounded
   text/image helpers, not a "open this file with a native driver" primitive — the **backend** does
   the open, but it needs the cwd to resolve/enforce the path. Confirm the backend receives the
   conversation `cwd` (AgentHost provides `cwd` per PLUGIN_API §3 `agent.info`, but the _backend_
   child's access to cwd is unspecified). **[EXTRAPOLATION]**
4. **Secret handling for Postgres URLs.** No host secret store exists. A password in a
   `postgres://user:pass@…` URL must not be persisted to `storage.json` (plaintext on disk). Need
   either a host-mediated secret channel or an explicit "enter password on each connect" flow.
   See §9. Until then, **SQLite-only ships credential-clean**; Postgres requires the §9 mitigation.

---

## 7. Implementation milestones (SQLite first)

Ordered; each builds and meets its slice before the next (CLAUDE.md working method). Assumes the
plugin host P3 + channels/context P4 (PLUGIN_ARCHITECTURE build order) are in place.

- **M0 — Skeleton.** Manifest (§3), panel shell, service backend that spawns and answers a stub
  `db_schema`. Enable/disable lifecycle clean; no DB yet. Verify it lists + mounts + restores an
  empty pane from `storage`.
- **M1 — SQLite read-only.** Chosen driver (§4.2) opens a cwd-scoped file `{ readonly: true }`;
  connection bar; schema tree from introspection; query editor; result grid with the row cap and
  paging (§6). No agent tools yet. **Acceptance: connect to a local `.db`, browse schema, run a
  SELECT, see a paged sortable grid; a write is refused by the driver.**
- **M2 — Agent tools + shared view.** `db_query`/`db_schema` handlers in the backend; publish to
  `db:result`; pane renders agent results with provenance (§2.5); token-tight tool envelope (§6).
- **M3 — Schema context export.** `context.update('schema', md)` on connect/refresh/write;
  auto-pin; markdown budget strategy (§5); `"readonly": true` on the export (existing
  `ContextExportSchema` field — no host change needed).
- **M4 — Write opt-in.** Allow-writes switch, r/w reopen, classifier, post-write schema refresh
  (§4.4); agent-write guarded by user-enabled write mode.
- **M5 — Postgres.** `pg` driver behind the same `Driver` interface; read-only session; the §9
  credential mitigation (no plaintext password at rest); connection pool + idle timeout.
- **M6 — Polish.** Schema-version staleness poll (§5), copy-as-CSV/MD, result scrollback bounding,
  error surfaces, DESIGN_SYSTEM pass.

---

## 8. Risks

- **Credentials (Postgres).** A connection URL carries a password; persisting it to
  `storage.json` writes a plaintext secret to disk, and injecting it into the schema export would
  leak it into the model's context. Mitigation: never persist the password (store URL with password
  stripped); prompt on each connect (or a host secret store — HOST-GAP #4); never include
  credentials in any exported/published payload; SQLite has no this problem and ships first.
- **Big tables → token blowout / OOM.** An unbounded `SELECT *` on a huge table could flood the
  agent's context or the utility process's 512 MB heap (PLUGIN_API §5). Mitigation: the three-tier
  caps (§6), streaming/`LIMIT`-wrapped queries in the backend, byte caps on payloads, and the V8
  heap cap the host already imposes.
- **Locking / mutating a dev DB.** A long-running or accidental-write query can lock a SQLite file
  (writer lock) or hold a Postgres transaction open. Mitigation: read-only-by-default is the primary
  guard; a per-query `timeoutMs` (statement timeout on Postgres, interrupt on SQLite); connection
  idle-timeout (§4.4); a single connection so we don't fan out locks.
- **Native-module packaging.** `better-sqlite3` must be rebuilt for Electron's ABI per platform or
  the plugin fails to load on a user's machine. Mitigation: prefer `node:sqlite`/`sql.js` (no
  native build) or wire `@electron/rebuild` into packaging and test on each target OS (§4.2).
- **Schema drift.** A migration run outside the pane makes the pinned schema stale, and the agent
  trusts stale context. Mitigation: refresh-on-write, an optional schema-version poll, and the
  `db_schema` escape hatch the export explicitly points at (§5).
- **A write disguised as a read.** A CTE or function call that mutates (`SELECT … FROM
a_function_with_side_effects()`) can slip past a naive classifier. Mitigation: the **driver-level**
  read-only open is authoritative (§4.4) — the classifier is only UX; we never rely on it for safety.

---

## 9. Acceptance criteria

The plugin is done (for its shipped milestones) when:

1. **Discovery/restore.** Appears in the rail from its folder; enabling mounts the pane; a
   conversation reopened later restores the connection _target_ + last query from `storage` and
   rebuilds the pane in `load` — **without** auto-reconnecting to a remote Postgres (a click is
   required). (PLUGIN_API §8, §9 credential risk.)
2. **SQLite read-only (M1).** Connects to a cwd-scoped `.db`, shows a correct schema tree, runs a
   SELECT, and renders a **sortable, pageable** grid; a `DELETE`/`UPDATE` is **refused by the
   driver** (not merely by the classifier).
3. **Shared result view (M2).** An agent `db_query` returns a token-bounded envelope to the agent
   **and** renders the same result in the pane's grid, provenance-tagged.
4. **Schema in context (M3).** With the plugin enabled, the schema summary is present in the
   agent's injected context every turn, refreshes after a write/refresh, respects `maxTokens` with
   a visible truncation marker, and is **not** overwritable by the agent.
5. **Write opt-in (M4).** Writes are impossible until the user flips **Allow writes** in the pane;
   the agent cannot enable write mode itself; after a write the schema tree + export refresh.
6. **Caps hold (M6).** A `SELECT *` on a large table does not flood the agent context, does not
   exceed the payload byte cap on `db:result`, and does not exceed storage bounds — truncation is
   marked everywhere it happens.
7. **Containment.** A driver error, a bad path, or a malformed query surfaces inline and never
   throws into the host; a backend crash is isolated and reported (PLUGIN_API §2/§5).
8. **Postgres (M5, when shipped).** Same as SQLite plus: read-only session enforced at the engine,
   no plaintext password persisted, credentials absent from every exported/published payload.

Un-automatable checks for docs/PROGRESS.md spot-check: native-module load on each packaged target
OS; the "reopen days later, no silent remote reconnect" flow; and visual confirmation that the
agent's result truly renders in the _user's_ grid.
