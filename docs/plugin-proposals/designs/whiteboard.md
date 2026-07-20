# whiteboard — design

Status: **build spec** (requested in user review 2026-07-20). A default `kind: "panel"` plugin:
a tabbed visual-communication surface where the agent and the user express and edit the same
artifacts — **diagrams, data tables, and charts** — the visual vocabulary of a big-tech design
doc. Not a freeform canvas: a set of typed boards.

Both sides read and write the SAME document (the Atelier context-export pattern): the agent
writes boards via its generated `set_whiteboard__boards` / `edit_whiteboard__boards` tools; the
user edits in the pane (cell edits, diagram source tweaks, comments); the agent sees every user
edit next turn because the export is re-injected.

## 1. Purpose + user stories

- **Agent explains architecture**: pushes a mermaid flowchart/sequence/ER diagram; the user reads
  it rendered, adds a comment "what about the cache path?", agent revises the same board.
- **Agent presents data**: benchmark numbers as a table board AND a bar-chart board; user edits a
  cell (corrects a figure); agent sees the correction.
- **User sketches intent**: user creates a table of requirements or edits diagram source; agent
  reads it next turn and responds.
- **Design-doc set**: multiple boards act like figures in a doc — tabs across the top, each typed.

Non-goals v1: freehand drawing, real-time cursors, image import, mermaid WYSIWYG editing (source
editing + live render is the contract).

## 2. Board model (the `boards` context export, format `json`)

```jsonc
{
  "active": "arch", // optional: board id the pane should focus (agent can direct attention)
  "boards": [
    {
      "id": "arch",
      "title": "Architecture",
      "type": "mermaid",
      "source": "flowchart TD\n  A[Renderer] --> B[Main]\n  B --> C[(SDK)]",
      "comments": [{ "by": "user", "ts": 1752987600000, "text": "what about the cache path?" }]
    },
    {
      "id": "bench",
      "title": "Benchmarks",
      "type": "table",
      "columns": ["case", "before_ms", "after_ms"],
      "rows": [
        ["cold start", 1200, 340],
        ["hot reload", 90, 85]
      ],
      "align": ["left", "right", "right"]
    }, // optional
    {
      "id": "bench-chart",
      "title": "Benchmarks (chart)",
      "type": "chart",
      "chart": "bar", // bar | line | area | scatter | pie
      "x": { "label": "case", "categories": ["cold start", "hot reload"] },
      "y": { "label": "ms" },
      "series": [
        { "name": "before", "values": [1200, 90] },
        { "name": "after", "values": [340, 85] }
      ]
    },
    {
      "id": "notes",
      "title": "Open questions",
      "type": "note",
      "markdown": "- Should the cache be per-conversation?\n- TTL?"
    }
  ]
}
```

- Board `type` ∈ `mermaid | table | chart | note`. `comments[]` allowed on every type
  (`by: "user" | "agent"`); the pane renders them as a thread under the board and lets the user
  append — that is the primary talk-back channel besides direct edits.
- Scatter series use `points: [[x, y], ...]` instead of `values` (numeric x; no categories).
- Unknown fields are preserved (pane must not strip what it doesn't understand).
- The pane never destroys boards it fails to render — a board with a mermaid syntax error shows
  the error + raw source, still editable.

## 3. Manifest sketch

```jsonc
{
  "id": "whiteboard",
  "name": "Whiteboard",
  "version": "0.1.0",
  "description": "Tabbed visual boards the agent and user share: mermaid diagrams, editable data tables, charts (bar/line/area/scatter/pie), and note boards with comment threads. The agent writes boards with its set/edit tools; user edits and comments flow back into context.",
  "icon": "<single-path 16px line glyph — e.g. rectangle with a rising polyline inside>",
  "kind": "panel",
  "entry": "index.html",
  "permissions": ["context", "storage"],
  "defaultDock": "center",
  "contextExports": [
    {
      "key": "boards",
      "label": "Whiteboard boards",
      "format": "json",
      "maxTokens": 4000,
      "description": "JSON: { active?, boards: [...] }. Types: mermaid{source}, table{columns,rows}, chart{chart,x,y,series[{name,values|points}]}, note{markdown}. Every board may carry comments[{by,ts,text}]. Edit with the edit tool for small changes (a cell, a comment reply); set replaces everything. Preserve user comments and edits — never drop boards you did not change."
    }
  ]
}
```

Ship a `defaults.json` seeding `guide:boards` (usage guide injected read-only to the agent:
schema recap + "prefer edit_ over set_, keep tables small, respond to comments in-place or in
chat") and a starter `ctx:boards` with one example board of each type so the pane demos itself.

## 4. Rendering (all local — the sandbox has no network)

- **Mermaid**: vendor `mermaid.min.js` into the plugin folder (`npm i mermaid`, copy the ESM/UMD
  min bundle; the pane may `fetch()`/`<script>` its own folder assets). Render on board change,
  `securityLevel: 'strict'`, theme wired to the Atelier CSS variables. Pan/zoom via simple
  wheel+drag transform on the SVG container. Export: "copy source" + "download .svg".
- **Tables**: hand-rolled grid (contenteditable cells or input-on-click). Edits debounce
  (~400ms) into `context.set`. Column sort (view-only, does not rewrite row order in the doc),
  add-row/add-column, cell alignment from `align`. Numbers right-aligned by default.
- **Charts**: hand-rolled SVG rendering (no heavy dep): bar (grouped), line/area (multi-series),
  scatter, pie. Axis ticks, series legend, hover tooltip with value. Colors from theme tokens
  with a fixed fallback palette. A "view as table" toggle for accessibility.
- **Notes**: minimal markdown render (headings/lists/bold/code) — small hand-rolled or tiny
  vendored renderer; user edits raw markdown in a textarea toggle.

Tab strip across the top (board titles, type glyph, `+` menu to add a board of each type,
rename/delete with confirm). Active tab follows `active` when the AGENT changes it (a `context`
event where `active` differs), but never fights the user's manual tab choice within ~30s of a
user click (store last user click ts).

## 5. Sync discipline (the hard part — same pattern as data-table/diagram examples)

- On `load`: read `context.get('boards')`, render; restore last-active tab from `storage`.
- On `context` event for `boards` (external/agent edit): re-read and re-render, PRESERVING
  in-progress user edit state (if a cell editor is open, apply the remote change around it and
  re-apply the open editor; if the same cell changed remotely, remote wins and flash the cell).
- On user edit: update DOM immediately, debounce `context.set` ~400ms. A pane's own `context.set`
  does NOT echo back a `context` event — update local model synchronously.
- Malformed JSON in the export (agent typo): show a non-destructive error banner with the raw
  text and a "fix in place" textarea; never overwrite with `{}`.
- Size guard: warn in-pane when the serialized doc approaches the maxTokens×4 char cap; suggest
  the agent split large tables (the guide says the same).

## 6. Milestones

1. Manifest + tab shell + note boards + comments thread + sync discipline (the skeleton proves
   the bidirectional loop).
2. Table boards (edit, add row/col, sort view).
3. Chart boards (bar/line/area first, then scatter/pie).
4. Mermaid boards (vendor bundle, error-tolerant render, pan/zoom, svg export).
5. defaults.json (guide + starter boards), polish (active-tab steering, size guard, theme).

## 7. Acceptance criteria

1. Agent `set_whiteboard__boards` with one board of each type → all four render correctly.
2. User edits a table cell and adds a comment → next agent turn sees both in the injected export.
3. `edit_whiteboard__boards` changing one mermaid node label re-renders just fine; user comments
   elsewhere in the doc survive.
4. Mermaid syntax error → error + source shown, other boards unaffected, doc not corrupted.
5. Pane close/reopen and app restart restore all boards (context persistence) + last active tab
   (storage).
6. A malformed export value never crashes the pane and is never silently overwritten.
7. Works fully offline (vendored assets only; no CDN).
