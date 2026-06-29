# DESIGN_SYSTEM.md — Atelier

The visual + interaction standard for Atelier. **Normative.** Pair with SPEC.md (what to
build) and CLAUDE.md (how to work). The reference implementation is `Atelier Workspace.dc.html`
(a self-contained prototype of the full shell in all three themes); this document is the
durable contract that survives it.

The whole point of this system is the same as the app's: **legibility and extensibility**.
Every rule below exists so that a plugin authored next year — by a human or by the agent —
docks into the workspace and looks native without touching app-level styling.

---

## 0. The three invariants

If a change violates one of these, it is a bug, not a style preference.

1. **Tokens are the only source of color, and they cascade.** No component hard-codes a hex
   value. Every color, radius, and spacing step reads a CSS variable. A new theme is one map
   of variables; nothing else changes. (§1, §2)
2. **Every docked surface is the same Panel.** The chat pane, the metrics pane, a terminal,
   and a plugin nobody has written yet are all the _same shell_ — rounded surface, a
   `--tab-h` header with tabs + actions, a scrolling body. The chrome never special-cases a
   panel kind. This is what keeps the workspace content-unbounded. (§4)
3. **Chrome is quiet; content is legible.** Surfaces, borders, and toolbars recede
   (low contrast, no saturation). The accent and status colors are spent only on things the
   user must act on or read. Saturated color is a signal, never decoration. (§3)

---

## 1. Token system (single source of truth)

In the repo these live in `src/styles.css` as `:root` variables, themed by a
`[data-theme="…"]` attribute on the root element (replacing the current flat `:root` block).
Density is a second, orthogonal attribute. Components reference `var(--…)` only.

```css
:root,
[data-theme='slate'] {
  /* tokens below */
}
[data-theme='carbon'] {
  /* tokens below */
}
[data-theme='daylight'] {
  /* tokens below */
}

[data-density='comfortable'] {
  --fz: 14px;
  --pad: 14px;
  --tab-h: 34px;
  --gap: 8px;
  --lh: 1.6;
}
[data-density='compact'] {
  --fz: 13px;
  --pad: 9px;
  --tab-h: 30px;
  --gap: 7px;
  --lh: 1.5;
}
```

Apply at the top of the renderer tree:

```tsx
<div className="app" data-theme={theme} data-density={density}>
```

### 1.1 The token contract (names are stable; values are per-theme)

| Token                                   | Role — what it is allowed to color                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--bg`                                  | App background, behind everything                                                                |
| `--bg-2`                                | The **dock gutter** (behind floating panels) and code/terminal backgrounds — the deepest surface |
| `--surface`                             | A panel body; the default raised surface                                                         |
| `--surface-2`                           | Headers, bars, cards on a surface (one step up)                                                  |
| `--surface-3`                           | Hover/active fill, inset controls (two steps up)                                                 |
| `--input`                               | Text inputs, the composer field                                                                  |
| `--border`                              | Default 1px hairline between regions                                                             |
| `--border-2`                            | Stronger border: active tab, focused/selected, emphasis                                          |
| `--text`                                | Primary text                                                                                     |
| `--dim`                                 | Secondary text, inactive tab labels, metadata                                                    |
| `--faint`                               | Tertiary text, timestamps, placeholder, icon idle                                                |
| `--accent`                              | The one brand/interaction color: primary action, links, focus, active selection, charts          |
| `--accent-2`                            | Accent hover/brighter                                                                            |
| `--accent-weak`                         | Accent at ~12% — selection bg, loaded-plugin chip, chart fill, soft highlight                    |
| `--on-accent`                           | Text/icon **on** an accent-filled surface                                                        |
| `--ok` `--warn` `--err`                 | Status only: success, caution/approval, error/danger                                             |
| `--ok-weak` `--warn-weak`               | Status backgrounds at ~12% (diff add, permission strip)                                          |
| `--scroll` `--scroll-hover`             | Scrollbar thumb                                                                                  |
| `--shadow`                              | The single elevation shadow for floating panels                                                  |
| `--font` `--mono`                       | Type stacks                                                                                      |
| `--fz` `--pad` `--tab-h` `--gap` `--lh` | Density-driven scale (set by `[data-density]`, not by theme)                                     |

### 1.2 Theme values

**Slate** — cool, disciplined IDE dark. The default; the refined evolution of today's UI.

```
--bg:#0e1014  --bg-2:#090b0f  --surface:#14171e  --surface-2:#191d26  --surface-3:#202634
--input:#1b2029  --border:#252b37  --border-2:#333b4b
--text:#e7eaf0  --dim:#99a2b4  --faint:#5e6677
--accent:#5b9cff  --accent-2:#82b3ff  --accent-weak:rgba(91,156,255,.13)  --on-accent:#06122a
--ok:#46c79a  --warn:#e3b25a  --err:#ef7a63  --ok-weak:rgba(70,199,154,.14)  --warn-weak:rgba(227,178,90,.10)
--scroll:#2a3140  --scroll-hover:#3a4356  --shadow:0 10px 30px rgba(0,0,0,.45)
```

**Carbon** — warm copper studio dark. More character; same structure.

```
--bg:#15120e  --bg-2:#100d0a  --surface:#1b1712  --surface-2:#221d16  --surface-3:#2a2419
--input:#221c15  --border:#322a20  --border-2:#43392b
--text:#f0e9dd  --dim:#ad9f8c  --faint:#6f6452
--accent:#e08a46  --accent-2:#f0a063  --accent-weak:rgba(224,138,70,.14)  --on-accent:#1c1206
--ok:#9cb86a  --warn:#e0b54a  --err:#e0694a  --ok-weak:rgba(156,184,106,.15)  --warn-weak:rgba(224,181,74,.10)
--scroll:#3a3024  --scroll-hover:#4d4030  --shadow:0 12px 32px rgba(0,0,0,.5)
```

**Daylight** — warm-paper light mode with an ink-blue accent. For daytime work.

```
--bg:#eceae3  --bg-2:#e1ded4  --surface:#ffffff  --surface-2:#f6f4ee  --surface-3:#eeebe2
--input:#ffffff  --border:#e0dccf  --border-2:#cdc7b6
--text:#23262b  --dim:#6f6a5e  --faint:#a39d8e
--accent:#2f63e0  --accent-2:#4a7bf0  --accent-weak:rgba(47,99,224,.10)  --on-accent:#ffffff
--ok:#2c9a6b  --warn:#b07d18  --err:#cf4a30  --ok-weak:rgba(44,154,107,.12)  --warn-weak:rgba(176,125,24,.10)
--scroll:#cfcabb  --scroll-hover:#b8b2a0  --shadow:0 10px 30px rgba(40,36,28,.16)
```

Type stacks are theme-independent: `--font:"Segoe UI",system-ui,-apple-system,sans-serif`
(Windows-first), `--mono:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace`.

---

## 2. Adding a theme (the only correct way)

1. Add one `[data-theme="name"]{…}` block defining **every** token in §1.1. Do not omit any —
   there is no inheritance fallback by design, so a missing token is a visible bug you catch
   immediately.
2. Add the option to the theme switcher list. Nothing else.
3. Verify against the **theme checklist** (§9). Never introduce a token that only one theme
   defines; if a component needs a value, it becomes a token in all themes.

Do **not** theme by overriding component classes (`.chat-header { background:… }` per theme).
That defeats the cascade and is the #1 way themes drift apart.

---

## 3. Color usage rules (semantic, not decorative)

- **Accent is rationed.** One accent action per region. The composer Send button, a primary
  modal action, the active selection, focus rings, links, and chart strokes — that's the list.
  Two accent buttons competing in one view is a smell.
- **Status colors mean status.** `--err` is destructive/error _only_ (close-on-hover, deny,
  failed tool). `--warn` is "needs your attention" (the permission strip, caution). `--ok` is
  success (tool ✓, allow, saved checkpoint). Never use them for emphasis or variety.
- **Hierarchy is via the surface ramp + text ramp, not borders.** Lift a thing by moving it
  up the `--surface` → `--surface-2` → `--surface-3` ramp; quiet text by moving down
  `--text` → `--dim` → `--faint`. Reach for a border only to separate regions, not to box
  every element.
- **The Windows close-button red `#e81123` is the one allowed literal** (OS convention, on
  hover only). Everything else is a token.

---

## 4. The Panel contract (the core of extensibility)

A **Panel** is the universal docked surface. Chat, plugins, and built-ins are all Panels.
Dockview owns placement (SPEC §5); this contract owns the _look_.

**Shell (identical for every panel):**

```
surface:  background var(--surface); border 1px var(--border); border-radius 9px;
          box-shadow var(--shadow); overflow hidden; min-height/min-width 0
header:   height var(--tab-h); background var(--surface-2); border-bottom 1px var(--border);
          padding 0 6px; a tab strip (left) + action icons (right)
tab:      height calc(var(--tab-h) - 8px); radius 6px; 12px label + optional 13px icon;
          inactive = transparent bg / --dim text; active = --surface bg, 1px --border-2, --text, 600
body:     flex:1; min-height:0; overflow auto; the plugin's content
action:   24–26px square, radius 6px, --faint icon, hover --surface-3 / --text
```

**Gutter:** panels float on `--bg-2` with `8px` padding/gaps; splitters are `8px` strips with
`col-resize`/`row-resize` cursors.

**What a plugin supplies — and _only_ this:** an `id`, a `name`, a single-path 16px icon
(§6), and a body element. It never styles the shell, the header, or the tabs; it never picks
its dock position (the user docks it; layout persists per conversation per SPEC §4.5). A
plugin's body should still use the tokens so it reads as native, but it is free to render
anything inside (chart, xterm, 3D canvas, document).

**Consequence for code:** the renderer's Dockview `components` map points every panel kind at
the same `<Panel>` wrapper; the kind only decides the _body_. Adding a panel kind must not
require a new header/tab/chrome component. (Mirrors `LayoutService.addPanel(kind, params)`
in SPEC §5 — the styling layer has the same "by name, no coupling" shape.)

---

## 4a. Locked placement decisions — DO NOT REGRESS

These were deliberately moved away from an earlier design. They are not open for
re-litigation; treat any reversion as a bug.

### LD-1 — The fork / branch selector lives on the user message, not the pane header

The version switcher for a forked turn is a **per-message control**. It renders on the
**user message's role row**, immediately to the **right of that message's Edit button**
(`role label · ✎ edit · ‹ n/N ›`). Editing a user message forks the session at that message
(SPEC §3.3), so the branch arrows belong to the message being forked — not to a global slot.

- **Do NOT** put branch navigation in the Claude pane **header / top bar** (the early design).
  The header carries session/model/bypass/status only — never the fork switcher.
- Show the arrows on a user message only when it has alternative branches (`N > 1`); the Edit
  affordance is always available on hover.
- Each fork point owns its own `n/N` — it is not one shared counter across the transcript.

### LD-2 — Subscription usage limits live in the top bar, always visible

The account usage meters sit in the **top bar** and show **two windows: 5-hour and weekly**.
Each meter renders **all three** of:

1. a **progress bar** that ramps color with utilization — `--ok` < 70% → `--warn` 70–89%
   → `--err` ≥ 90% (it visibly "goes red as it gets close to full"),
2. a **numeric %** (tabular-nums, tinted to match the bar), and
3. **time until reset** (e.g. `2h 40m`, `4d 6h`).

Format: `5-hr ▓▓▓░ 84% · 2h 40m` `Weekly ▓▓░ 39% · 4d 6h`. These are global/account-wide
(not per-conversation), so the top bar — above the workspace swap — is the correct home. Data
comes from the SDK usage snapshot (App.tsx already polls `agent.usage`); thresholds and reset
timestamps map straight onto the three elements above. Keep it visible at all window widths;
let the cwd path truncate before the meters do.

---

## 5. Component patterns (and migration map from current `styles.css`)

Keep the existing class names where they exist; re-point their declarations at tokens and the
ramp. Mapping of today's ad-hoc values → system:

| Region                              | Today                        | Becomes                                                                                                                                           |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title bar (NEW)                     | —                            | 36px, `--surface-2`, app mark + **usage meters (LD-2)** + theme switcher + Windows controls (46×36; close hover `#e81123`)                        |
| `.conversation-bar`                 | `#141414`, drag region       | 42px, `--surface`; ☰ menu, conv tabs, +/import, cwd. Stays workspace-agnostic (SPEC §4.5)                                                        |
| `.usage-bar` / `.usage-mini` (LD-2) | separate `.usage-strip`      | move into the **top bar**; 5-hr + weekly, each = ramping bar (`--ok`→`--warn`→`--err`) + numeric % + reset time                                   |
| Fork / branch nav (LD-1)            | —                            | on the **user message role row**, right of its Edit button (`✎ ‹ n/N ›`). **Never** in the pane header                                            |
| `.conv-tab` / `.active`             | bespoke blue                 | tab pattern: active = `--surface-3` + `--border-2` + `--text`                                                                                     |
| `.usage-strip` / `.usage-mini`      | `#141414`                    | fold into conversation bar right; bars use `--ok`/`--warn`/`--err` by threshold                                                                   |
| `.claude-panel` + `.chat-header`    | `--bg-elev`                  | a **Panel** (§4). Header = the Claude tab + session id + bypass switch + model select + status dot. **No branch nav here** (LD-1)                 |
| `.transcript`                       | padding 12/16                | `var(--pad)` 18px; messages `max-width:760px` for line length                                                                                     |
| `.msg-user .msg-body`               | `--bg-elev`, 2px accent left | unchanged pattern, tokenized                                                                                                                      |
| `.block-thinking`                   | collapsible, italic          | unchanged; chevron + "Thought for a moment", body `--dim` italic                                                                                  |
| `.block-tool`                       | expandable row               | row = chevron, tinted kind icon (read=`--accent`, edit=`--warn`, bash=`--ok`), mono name, summary, spinner→`✓`. Body: diff or `<pre>` on `--bg-2` |
| diff lines                          | `.code-fallback`             | add = `--ok-weak`/`--ok` `+`; del = `--warn-weak`/`--err` `-`; ctx = `--faint`                                                                    |
| `.composer`                         | `--bg-elev`                  | `--surface-2` bar; field `--input`, radius 10, focus-within `--accent`; round Send (accent when non-empty) / square Stop (`--err`)                |
| `.perm-card` / `.permissions`       | warn-tinted                  | `--warn-weak` strip; Allow=`--ok`, Allow-for-session=`--surface-3`, Deny=`--err`                                                                  |
| `.q-card` / `.questions`            | accent-tinted                | `--accent-weak` strip; options use the selectable pattern (`--border-2` + `--accent-weak` when chosen)                                            |
| `.btn-*`                            | fixed greens/reds            | `.btn` base + intent via token: primary `--accent`/`--on-accent`, ok `--ok`, danger `--err`, ghost `--surface-3`/`--border`                       |
| `.switch`                           | red track                    | track `--border-2` → `--err` (this control specifically signals danger when ON)                                                                   |
| `.model-select`                     | `--bg-input`                 | `--surface-3`, `--border`, focus `--border-2`                                                                                                     |
| `.modal`                            | `--bg-elev`                  | `--surface-2`, `--border-2`, `--shadow`; overlay `rgba(0,0,0,.5)`                                                                                 |
| Plugin sidebar (NEW)                | —                            | a Panel; expanded ↔ 50px icon rail; rows = 28px tinted icon + name + desc + load(+)/eject(×); loaded icon uses `--accent-weak`/`--accent`         |
| scrollbars                          | none                         | themed via `--scroll`/`--scroll-hover`                                                                                                            |

**Selectable pattern** (reused by conv tabs, panel tabs, question options, sidebar items):
idle = transparent/`--border`, `--dim`; selected = `--surface-3`/`--surface` + `--border-2`,
`--text`, weight 600. One pattern, everywhere — never invent a per-place selected style.

---

## 6. Iconography & type

- **Icons:** 16px line icons, `stroke:currentColor`, `stroke-width:1.3–1.4`, round caps/joins,
  `fill:none`. Prefer **single-path** icons so a plugin can ship one `d` string. Color is
  inherited from the parent (`--faint` idle, `--accent` active/loaded). No emoji in chrome —
  the current `☰ ＋ ⤓ 📂 🗑` glyphs migrate to line icons (a ☰ menu glyph is the one tolerable
  exception). No filled/duotone icon sets mixed in.
- **Type:** UI text `--fz`/`--lh`. Section labels 10px uppercase, `letter-spacing:.07em`,
  `--faint`. Code, paths, session ids, metrics, timestamps in `--mono`. Numbers that update
  live (`step`, `loss`) use `font-variant-numeric: tabular-nums`. Body line length capped
  ~760px in the transcript.

---

## 7. Motion

Restrained and purposeful. Allowed: token transitions on hover (~120ms), the toggle thumb
(150ms), a `fadeup` on new transcript messages (250ms), the streaming caret blink (1s steps),
the tool spinner (0.7s), and ambient data (chart/terminal) updating on their own cadence.
No decorative/looping motion on idle chrome; no gradient washes; no parallax. Reduced-motion
users get instant states.

---

## 8. Design-decision architecture (how to stay consistent over time)

This is the part that keeps future work from drifting. When you (Claude Code) face a new UI
decision, resolve it **in this order** and stop at the first that answers:

1. **Is there already a token / pattern for this?** Use it. (Color → §1.1; a row/tab/card →
   §5 patterns; a docked thing → §4.) 90% of decisions end here.
2. **Is it a new _semantic_ color need?** Add it as a token defined in _all three themes_
   (§2). Never a one-off hex, never a single-theme token.
3. **Is it a new repeated structure?** Generalize an existing pattern rather than forking one.
   New repeated structures become a documented pattern here before their second use.
4. **Is it a new docked surface?** It's a Panel (§4) — supply id/name/icon/body, nothing else.
5. **Genuinely novel and unaddressed?** Pick the most reversible option, ship it, and record
   it in `docs/DECISIONS.md` _and_ add the rule/token here. The system grows by amendment, not
   by exception.

**Hard rules that bound every decision:**

- No hard-coded color/radius/shadow in a component. (lint target: hex literals in `styles.css`
  outside the theme blocks, except `#e81123`.)
- No per-theme component overrides. Themes only change the token blocks.
- No bespoke "selected" / "hover" / "card" treatment when a §5 pattern exists.
- A plugin body may use tokens freely but must not style Panel chrome.
- Density changes spacing/size via the `--fz/--pad/--tab-h/--gap/--lh` tokens only — never
  hard-coded paddings that ignore density.
- Accessibility floor: text on its background ≥ 4.5:1 (UI text), focus is always visible via
  `--accent`/`--border-2`, hit targets ≥ 28px in chrome.

**When in doubt, optimize for the invariants (§0):** quiet chrome, legible content, one
universal Panel, tokens all the way down.

---

## 9. Checklists

**Theme checklist** (run for every theme on any visual change):

- [ ] All §1.1 tokens defined; none missing.
- [ ] Chat: user bubble, thinking, tool row, diff add/del, code block, result line all legible.
- [ ] Permission + question cards readable; Allow/Deny intent colors correct.
- [ ] Active vs inactive tabs clearly distinct; focus ring visible on inputs/select.
- [ ] Metrics chart stroke + fill visible on `--surface-2`; terminal legible on `--bg-2`.
- [ ] Scrollbars visible but quiet. Shadows read as elevation, not grime.
- [ ] No element using a raw hex (except `#e81123`).

**New-component checklist:**

- [ ] Colors are tokens; spacing uses density tokens.
- [ ] Reuses a §5 pattern (selectable / panel / card / btn) where applicable.
- [ ] If docked, it's a Panel and supplies only id/name/icon/body.
- [ ] Passes the theme checklist in all three themes.
- [ ] Any new token or pattern was added to this doc; any irreversible choice logged in DECISIONS.md.

---

## 10. Migration plan (current UI → this system)

Do it in small, shippable steps; verify each against §9. Order chosen so the app stays
runnable throughout.

- **M1 — Tokenize.** Replace the flat `:root` in `styles.css` with the three `[data-theme]`
  blocks + `[data-density]` blocks (§1). Add `data-theme`/`data-density` to the `.app` root,
  fed by a `theme`/`density` setting (persist in the per-conversation/app store). Re-point all
  existing component declarations to tokens. **No visual redesign yet** — Slate should closely
  match today. Acceptance: app looks ~unchanged in Slate; Carbon/Daylight switch cleanly.
- **M2 — Panel-ize.** Extract the shared `<Panel>` shell (§4) and route every Dockview
  component kind through it; the chat pane becomes a Panel whose body is the transcript.
  Acceptance: chat + any built-in render via one shell; adding a kind needs no chrome code.
- **M3 — Chrome.** Add the 36px Windows title bar (app mark, **usage meters per LD-2**, theme
  switcher, window controls). Usage moves into the **top bar**, not the conversation bar.
  Acceptance: frameless window chrome reads as a native Windows app; 5-hr + weekly meters show
  ramping bar + % + reset and stay visible at all widths.
- **M4 — Plugin sidebar.** Build the collapsible sidebar (§5) over the real PluginHost
  registry (load/eject, loaded vs available, hot-reload affordance). Acceptance: loading a
  plugin docks a Panel; ejecting removes it; layout persists per conversation.
- **M5 — Block polish.** Migrate transcript blocks (thinking/tool/diff/result), permission +
  question cards, and the composer to the §5 patterns and icon set. Put the fork/branch nav on
  the user message row per **LD-1** (right of Edit), never in the header. Acceptance: structured
  rendering matches SPEC §3, LD-1 holds, and the theme checklist passes.
- **M6 — Example plugins as reference.** Re-skin the first example panes (metrics, bash
  stream) using only tokens, as the canonical "how a plugin body should look." Acceptance:
  example plugins set the bar; third-party panes copying them look native automatically.

Reference prototype for all of the above: `Atelier Workspace.dc.html`.
