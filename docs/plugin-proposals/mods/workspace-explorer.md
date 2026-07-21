# workspace-explorer — modification plan (user review 2026-07-21)

**Verdict from review:** "alright but a little messy looking." Three concrete asks:
indentation, real file-type icons, and a preview that highlights + prettifies.

## Diagnosis

- **No indentation at all**: `.children` has no padding (index.html); nested rows render
  flush-left. Rows are built per-dir recursively, so depth is known at render time.
- **Icons**: one generic file outline + one folder outline (explorer.js
  `fileIconSvg`/`dirIconSvg`). Nothing distinguishes a .ts from a .png at a glance.
- **Preview**: hand-rolled tokenizer with a small keyword set; no markdown or JSON
  rendering; no toggle.

## Changes

1. **Indentation.** Pass `depth` through `renderChildren`/`renderRow`; rows get
   `padding-left: 8 + depth*14px` (padding on the row, not the wrapper, so hover/selection
   still spans full width and the heat wash stays at the left edge). Add a faint vertical
   guide line per level (CSS `background` gradient on `.children`).
2. **File-type icons** (new `icons.js`): a registry of small inline SVGs keyed by exact
   filename then extension, colored per type family — folder open/closed (accent-tinted),
   code (js/jsx yellow, ts/tsx blue, py green-blue, rs orange, go cyan, c/cpp blue,
   cs purple, java red-brown, sh green), web (html orange, css/scss purple, vue/svelte),
   data (json yellow-braces, yaml/toml, csv, sql), docs (md blue ¶, txt, pdf), images
   (picture glyph, per-ext tint), config specials (package.json npm-red, lockfiles gray,
   .gitignore git-orange, Dockerfile whale-blue, LICENSE, .env yellow-warn), archives,
   fonts, binaries. Fallback: neutral file with the extension's first letters. Ignored
   entries stay dimmed.
3. **Preview renderers with a mode toggle** in `#pv-head`:
   - **Code** (default): keep tokenizer but upgrade — per-language keyword sets chosen by
     extension, plus regex/prop highlighting is out of scope; add `md`-aware plain mode.
   - **Rendered** (for .md/.markdown): markdown → HTML (port the whiteboard note renderer
     into a shared `md.js` inside the plugin folder) — headings, lists, code fences, links,
     tables (subset).
   - **Pretty** (for .json + parseable JSON files): `JSON.parse` → 2-space re-stringify →
     highlighted; parse failure falls back to Code with a note.
     Toggle buttons only show modes applicable to the selected file; chosen mode persists per
     extension in storage (`pvMode:<ext>`). Live tail continues to re-render in current mode.
4. **Tidy pass** (the "messy" catch-all): consistent row height, size badge for files on
   hover only, truncation/empty notes aligned to the indent guide, preview header shows a
   file icon + monospace path, and the toolbar buttons get icons + tighter spacing.

## Acceptance

- Nested entries visibly indent per level with guide lines; hover/selection full-width.
- At a glance: folders vs files vs types distinguished by icon + color; specials
  (package.json, .gitignore, Dockerfile) recognizable.
- .md preview renders formatted by default (toggle back to source); .json prettifies with
  a toggle; both survive live-tail updates.
- No host changes; gate green; manifest unchanged.
