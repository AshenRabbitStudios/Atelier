# HOLOGRAM_DATA_MODEL.md — the extensible data model for the Hologram viewer

Status: **design, pre-implementation.** Supersedes the prototype's NN-only `SceneData` (kept only as
the `archviz/1` demo). This is the contract the agent authors and pushes; the pane renders it.

**Goal:** any AI architecture or concept we build or discuss is expressible here, to arbitrary depth.
Each node has two **decoupled** channels:

1. an **abstract 3D glyph** — the _shape_ of the thing in space (structural, iconic; it does NOT
   render the underlying data — no tokens/scalars/RGB drawn in 3D), and
2. an **assortment of descriptive detail panels** — text, table, key-value, code, … — that carry the
   _full_ content in the inspector. **Every node** gets this capacity (not just leaves), and a
   description **need not be visual**: a scalar or a word is best _said_ in text/table, not drawn.

And the viewer has one interaction channel back to the agent:

3. a **selection/reference channel** — the user shift-clicks to select one or more nodes and asks
   "what's this?" / "add more detail here"; the agent knows exactly what is referenced.

## 1. Six design pillars

1. **Details = an assortment of descriptive panels**, on **every** node (`markdown`, `table`,
   `keyValue`, `list`, `code`, `json`, optional `chart`). Rendered in the inspector, never in 3D.
   Depth of description is universal; the glyph does not read them. Descriptions of scalars/words are
   text, not visuals.
2. **Abstract glyph vocabulary** — a node's 3D form is chosen by `kind`/`glyph` from an open registry
   of _structural_ shapes (attention fan, MLP graph, matrix, cell, volume, neutral slab, …). Iconic,
   not data-bound. Decoupled from the details.
3. **Open registries, not fixed enums** — `kind`, `glyph`, edge `kind`, `layout` are open string keys
   with graceful fallback (unknown glyph → `neutral`; unknown layout → `flow`; unknown panel → text).
   New concepts = new entries or data, never an engine edit.
4. **3D-native, pluggable layout** — layouts emit real `[x,y,z]`. `flow`, `layered` (3D Sugiyama —
   ranks one axis, fan across the _other two_), `grid`/`volume`, `stack` (parallel planes in depth),
   `radial`, `manual`. A scene declares what its axes _mean_; depth is used, not decorative.
5. **Dual recursion + typed edges** — depth via **drill** (camera dives, scene swaps, lazy) and
   structure-in-place via **containment** (a `group` is a translucent volume of children); edges are
   typed data-flow (optional `tensor` shape/dtype + a `role`), inspectable like nodes.
6. **Per-export context wiring** — the bulk scene is pushed **out** to the pane with no readback
   (`inject:false`); a tiny **selection** is read **in** so the agent knows what the user references
   (`inject:true`). Injection is per-export precisely so these two can coexist.

## 2. Schema (normative)

```ts
type Vec3 = [number, number, number]
type Hex = string

interface ArchScene {
  format: 'archviz/2'
  id: string
  path: string[] // breadcrumb identity, root → here (e.g. ['gpt','block.3','attn'])
  title?: string
  subtitle?: string
  layout?: LayoutSpec // default { type: 'flow', axis: 'y' }
  axes?: { x?: AxisMeta; y?: AxisMeta; z?: AxisMeta }
  nodes: Node[]
  edges?: Edge[]
  annotations?: Annotation[]
  camera?: { pos?: Vec3; target?: Vec3 }
  palette?: string
}

interface AxisMeta {
  label: string
  kind?: 'flow' | 'depth' | 'heads' | 'time' | 'space' | 'free'
}

interface Node {
  id: string
  label: string
  kind: string // semantic category → default glyph + default color. OPEN set.
  glyph?: string // explicit abstract 3D form; default from kind. OPEN registry.
  group?: string // parent group id (in-place containment / clustering)
  pos?: Vec3 // manual override; else the layout computes it
  size?: Vec3
  color?: Hex
  summary?: string // one-line inspector header
  details?: Detail[] // the descriptive panels — EVERY node may carry these (§3)
  metrics?: Record<string, string>
  expandable?: boolean // has a deeper level resolved lazily via drill
  childrenPath?: string[] // scene path to load on drill (default: [...path, id])
}

interface Edge {
  a: string
  b: string
  kind?: string // data|residual|recurrent|attention|weight|gradient|control|retrieval … OPEN
  label?: string
  tensor?: { shape: (number | string)[]; dtype?: string; modality?: string } // WHAT flows (shown on edge-inspect)
  dir?: 'forward' | 'backward' | 'bi'
  style?: { color?: Hex; packet?: boolean; speed?: number; curve?: 'straight' | 'bezier' | 'arc' }
}

type LayoutSpec =
  | { type: 'manual' }
  | { type: 'flow'; axis: 'x' | 'y' | 'z'; spacing?: number; cross?: 'auto' | 'none' }
  | { type: 'layered'; rankAxis: 'x' | 'y' | 'z'; spread: ['x' | 'y' | 'z', 'x' | 'y' | 'z'] }
  | { type: 'grid'; dims: Vec3; order?: 'xyz' | 'zyx' }
  | { type: 'stack'; axis: 'x' | 'y' | 'z'; spacing?: number }
  | { type: 'radial'; axis?: 'x' | 'y' | 'z'; radius?: number }
```

## 3. Details — the descriptive formats, on every node (the "know everything" surface)

Rendered in the inspector as labeled sections/tabs; **not** in 3D. Open union — unknown → text.

```ts
type Detail =
  | { type: 'markdown'; title?: string; md: string } // prose / full description
  | { type: 'table'; title?: string; columns: string[]; rows: (string | number)[][] } // e.g. a latent dict
  | { type: 'keyValue'; title?: string; items: { k: string; v: string }[] } // shapes, dtype, hyperparameters
  | { type: 'list'; title?: string; ordered?: boolean; items: string[] }
  | { type: 'code'; title?: string; language?: string; source: string } // pseudocode, config, formula-as-text
  | { type: 'json'; title?: string; value: unknown } // raw structured blob
  | { type: 'chart'; title?: string; kind: 'bar' | 'line'; labels?: string[]; values: number[] } // optional widget
```

- **Every node** — input, attention block, an intermediate `expandable` group, or a terminal leaf —
  may carry any mix of these. There is no leaf/non-leaf distinction in how richly a node is described.
- A **latent dictionary** node → a `table` (`columns:['index','token','meaning']`, sampled rows) +
  `keyValue` (size, dim, dtype); the glyph stays an abstract matrix/box.
- A **scalar / word** → a `keyValue` or `markdown` line — _said_, not drawn.
- **Data flow** → `Edge.tensor`; inspecting an edge shows it as a `keyValue`.
- The inspector can **expand/maximize** a long table or text so big descriptions are readable.

## 4. Glyph & kind registries (abstract forms only)

- **Glyph** = `(node, THREE, ctx) => THREE.Group`, registered by name; iconic/structural, NOT
  data-driven. The 13 ported NN glyphs are seeds; `neutral` (clean labeled slab) is the fallback.
- **Default glyph + color from `kind`** (open categorical palette: input/attention/ffn/norm/embedding/
  output/expert/conv/recurrent/data/control/memory/tool/retrieval/…). Explicit `glyph`/`color` override.
- **Structural glyphs we expect to add** (all abstract): `volume` (H×W×C box field — shape, not
  values), `router`/`moe`, `cache`, `gate`, `db`/`index`, `branch`/`merge`, `agent`/`tool`/`service`.

## 5. Recursion, 3D, and the two context channels

- **Drill (depth):** `expandable` node → double-click → load `childrenPath`'s scene → camera dives,
  scene swaps, breadcrumb pushes. **Lazy:** unauthored path → "not detailed yet — ask me to expand".
- **Containment (in-place):** a `group` renders children inside a translucent volume; groups may
  carry their own sub-`LayoutSpec`.
- **Breadcrumb + cache:** scene identity is `path`; the pane caches received scenes in `storage` by
  path → instant Back, never re-asks the agent.
- **True 3D:** full `[x,y,z]` positions + 3D-native layouts (`layered` fans across two axes;
  `grid`/`stack` volumetric) + `axes` semantics so depth reads.

**Context channel OUT — bulk push (no readback):** the agent maintains scenes as files under
`docs/architecture/<model>/<path>.json` (outside `/plugins`) and pushes the active scene to the
`architecture` export, declared **`inject:false`** — its value is never fed back into agent context.
The pane merges it into its path cache and navigates there.

**Context channel IN — selection/reference (the one intentional readback):** the user selects nodes
in the pane — **click = replace, shift-click = add/toggle** — to highlight one or more. The pane
writes the current selection to a SMALL `selection` export declared **`inject:true`**:

```jsonc
{
  "path": ["gpt", "block.3"],
  "nodes": [{ "id": "attn", "label": "Multi-Head Attention", "kind": "attention", "summary": "…" }]
}
```

So when the user asks **"what's this?"** or **"add more detail here,"** the agent already sees exactly
which node(s) at which path are referenced, and answers / authors more `details` for them and pushes
the updated scene back out. The payload is just ids + labels → negligible per-turn cost, which is why
the bulk `architecture` can stay `inject:false` while `selection` is `inject:true`. (This is the
concrete reason injection must be **per-export**, not a global switch.)

## 6. Coverage check (the model must already account for these)

| Architecture / concept | Layout           | Glyph (abstract)                              | Details (descriptive)                                    |
| ---------------------- | ---------------- | --------------------------------------------- | -------------------------------------------------------- |
| GPT decoder            | `flow` y         | embedding, block(`expandable`), cache, output | vocab `table`; config `keyValue`; logits `chart`         |
| MoE layer              | `grid`/`stack`   | router + expert slab                          | routing weights `chart`; per-expert `keyValue`           |
| CNN / U-Net            | `layered` 3D     | `volume` (H×W×C shape)                        | layer specs `keyValue`; input image as `markdown` link   |
| Diffusion              | timestep `stack` | UNet via drill                                | scheduler `table`; latent `tensor` on edges              |
| Latent dict / codebook | `manual`/`grid`  | matrix                                        | the dictionary as a `table` (idx · entry · meaning)      |
| Tokenizer              | `flow`           | tokens                                        | vocab `table`; merge rules `code`; drill to text→BPE→ids |
| RAG / agentic system   | `flow`/`radial`  | tool/db/memory/router                         | tool I/O `keyValue`; retrieval edges                     |

A new case adds a glyph/layout/detail variant; it never forces a re-architecture.

## 7. Implementation sequencing (separate from this design)

1. Schema + 4 registries + graceful fallback + **auto-layout** (`flow`, `layered`-3D, `stack`,
   `grid`). Port the 13 glyphs into the registry; add `neutral` + categorical color. Keep `archviz/1`.
2. **Detail-panel inspector** — render `markdown`/`table`/`keyValue`/`list`/`code`/`json`/`chart`,
   with expand/maximize. Edge picking + inspection.
3. **Multi-select** (click=replace, shift-click=add) + the `selection` export wiring.
4. Dual recursion (drill + containment), path cache, breadcrumb, "not detailed yet".
5. 3D extras as needed: `volume`/`router`/`cache`/system glyphs; refine `layered`/`grid`.
6. Push wiring: optional `inject` flag on `ContextExportSchema` (default true); `architecture`
   `inject:false`; `selection` `inject:true`. Agent authors/pushes `docs/architecture/**`.
7. Optional later: `chart` polish, KaTeX for formulas, animated forward-pass.

## 8. Open decisions (record answers in DECISIONS.md)

- **`chart` panels:** ship a minimal `bar`/`line` widget now, or text/table only first? (Default:
  include a minimal `bar` — cheap, useful for distributions/routing.)
- **Heavy details** (50k-row vocab, full weight matrix): agent sends a representative sample + true
  size; pane paginates/caps. (Default: yes.)
- **Selection granularity:** nodes only, or also edges/groups selectable+referenceable? (Default:
  nodes first; edges next.)
- **Scene file granularity:** one file per path (lazy) vs one tree file per model. (Default: per-path.)

```

```
