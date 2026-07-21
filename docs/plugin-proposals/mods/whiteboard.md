# whiteboard — modification plan (user review 2026-07-21)

**Verdict from review:** "ok, but has bugs… just not very user friendly."

## Diagnosed bugs

1. **Can't delete a board via the tab ×.** `deleteBoard` calls `confirm()` and
   `renameBoard` calls `prompt()`; the plugin iframe sandbox is
   `allow-scripts allow-same-origin` (src/components/PluginPane.tsx:696) — **no
   `allow-modals`**, so `confirm()` silently returns false and `prompt()` null. Delete and
   rename are both dead. Fix: never use native modals in panes; inline confirm popover on
   the tab (× → "delete? ✓/✗") and inline rename input on dblclick.
   Also document the pitfall in PLUGIN_API.md (§ sandbox) — this will bite every plugin.
2. **Pre-first-board state is "connecting…" + empty page.** The `#status` strip's initial
   text plus a bare board area reads as broken. Fix: a real empty state in the board area —
   what the whiteboard is, "＋ add a board" buttons (one per type, directly clickable), and
   a note that the agent can push boards. Status strip seeds "ready" once load resolves.

## Editability gaps (make boards feel authored, not read-only)

3. **Note board**: currently edit is hidden behind one small "edit markdown" toggle.
   Make the note board **split-view like a real editor**: Edit / Preview / Split buttons,
   click-anywhere-on-preview enters edit mode. Keep the markdown renderer.
4. **Chart board**: today there is zero chart editing (only "view as table", read-only).
   Add a **chart editor panel** (collapsible, under the chart):
   - chart-type switcher (bar / line / area / scatter / pie / **waterfall** — add waterfall
     to charts.js as a derived bar form) that rewrites `board.chart`;
   - axis label inputs; category list editor (add/remove/rename);
   - per-series editor: name, values as an editable inline grid (reuse table cell editing),
     add/remove series;
   - scatter: points editable as x/y pairs grid.
     The "view as table" becomes "edit data" — the same grid, now writable.
5. **Table board**: visually collapsed when empty and no formatting.
   - Min height + placeholder grid (3×3 of empty editable cells) so an empty table looks
     like a table.
   - **Cell formatting**: select a cell (click) or drag a range → a small format bar
     (text color, background, bold, border emphasis, align). Persisted as an optional
     `styles` map on the board: `{ "r,c": { bg, color, bold, align } }` — unknown-field
     rules already preserve it; agent can read/write it too. Column resize by dragging the
     header edge is out of scope (note it).
   - Row/col delete + reorder (row drag handle out of scope; add "delete row/col" in a
     row/col context menu).
6. **Mermaid board**: keep the source editor but add a **toolbar of insert-snippets**
   (node, edge, subgraph, direction toggle, common templates for flowchart/sequence/state)
   so users don't need to remember syntax. True visual mermaid editing is out of scope —
   snippets + live render + error surface is the honest 80%.
7. **Comments**: unchanged (works).

## Acceptance

- × deletes (with inline confirm), dblclick renames inline — no native dialogs anywhere.
- Fresh pane with no boards shows the teaching empty state with per-type add buttons.
- A chart's type can be switched visually; its categories/series/values edited in place;
  waterfall renders.
- Note board editable in split view; table has visible grid when empty + a working format
  bar writing `styles`; mermaid toolbar inserts snippets.
- All edits round-trip through `context.set('boards')` exactly as before (agent-visible).
- Existing model.js invariants (unknown-field preservation, malformed banner) untouched;
  headless asserts extended for `styles` + waterfall + new-board defaults.
