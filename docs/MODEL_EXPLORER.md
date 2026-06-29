# MODEL_EXPLORER.md — the model canvas (design, for review)

A design for the hardest planned plugin: **a canvas for a future version of me to show you —
exactly and beautifully — the full architecture of a model we are designing together, so I
never make a choice you'd have made differently without you seeing it.** It renders structure
as a navigable 3D scene, but its real job is **communication**: surfacing every decision,
assumption, and the confidence behind it, so silent divergence becomes impossible. Think Jarvis
presenting a design to Stark — anticipatory, legible, explorable — **not** "a node graph in 3D."

**Status: design only — not built.** Normative plugin contract: PLUGIN_API.md /
PLUGIN_ARCHITECTURE.md. Visual rules: DESIGN_SYSTEM.md. This proposes a future ROADMAP phase.

## Why this exists (the actual goal)

The failure this kills: in past work, I made a strange choice the user assumed would have gone
another way — and **he didn't even know it happened** until much later. That is not a diagram
problem; it is a _communication_ problem. The canvas is the shared source of truth for a model's
design where **my choices are legible and challengeable before they become buried surprises.**

So the headline feature is not topology — it is the **decision / assumption / confidence layer**
(§3) and the **surprise surface** that actively draws your eye to exactly the places you'd want
to interrogate. Exact structure (§2, §4) is the substrate; the alignment layer is the product.

## Decisions baked in (2026-06-29)

- **Communication-first.** Structure serves understanding, not the reverse. Any feature is judged
  by whether it helps the human catch a divergence or grasp a part — not by graph fidelity alone.
- **Agent-authored.** I write the document from the model's code/spec — no machine-extraction
  backend in v1. Consequence: fidelity of _structure_ rests on the validator (§4); fidelity of
  _intent_ rests on me actually recording my decisions and assumptions, which the schema requires.
- **Framework-agnostic.** Schema assumes no specific ML framework. Ingestion adapters are deferred
  (a `source` provenance seam is left so a future adapter can populate the same doc).
- **Local, single-user.** Renderer stays sandboxed; pane reaches the app only through the host
  `context` / `storage` API. No SDK in the renderer; no new network surface.

## Non-goals (v1)

- No automatic ingestion from a framework artifact (deferred).
- No training/runtime telemetry (activations, gradients) — structure + intent only.
- Not a pretty read-only poster; it is an interactive, two-way alignment surface.

## 1. What it must communicate

For every part of the model, not just _what it is_ but _why it is that way_:

- **What** — the structural truth: modules, ops, data flow, tensor shapes (§2).
- **Why** — the decision behind it: what I chose, what I rejected and why, what I assumed,
  how sure I am, whether you've ratified it (§3).
- **No assumed knowledge** — every part carries a plain-language `summary` + `description` and an
  inline `defines` glossary; validation rejects empty/placeholder text.

A node the human cannot fully understand, or a choice they cannot see and challenge, is a bug.

## 2. Schema — a recursive, typed dataflow graph (the substrate)

A model is a graph of nodes; any node may contain its own subgraph (`children`) — that is the
recursive drill-down. Every data edge carries a typed tensor — that is the data flow.

```jsonc
{
  "version": 1,
  "root": "model",
  "nodes": {
    "block.0.attn": {
      "id": "block.0.attn",
      "label": "Causal self-attention",
      "kind": "module",
      "summary": "Multi-head causal self-attention, 12 heads.", // required
      "description": "Full plain-language explanation, no assumed terms.", // required, non-empty
      "defines": { "causal": "Each position may attend only to itself and earlier positions." },
      "properties": { "heads": 12, "head_dim": 64, "params": 2362368, "dtype": "fp16" },
      "io": {
        "in": [
          { "name": "x", "dims": [{ "B": null }, { "T": 1024 }, { "D": 768 }], "dtype": "fp16" }
        ],
        "out": [
          { "name": "y", "dims": [{ "B": null }, { "T": 1024 }, { "D": 768 }], "dtype": "fp16" }
        ]
      },
      "children": ["qkv", "softmax", "proj"], // ← descend here
      "design": {/* the alignment layer — see §3 */},
      "source": { "file": "model.py", "symbol": "CausalSelfAttention" } // provenance seam
    }
  },
  "edges": [
    {
      "from": "block.0.attn",
      "to": "block.0.mlp",
      "tensor": { "dims": [{ "B": null }, { "T": 1024 }, { "D": 768 }], "dtype": "fp16" },
      "kind": "data"
    },
    { "from": "block.0:in", "to": "block.0:out", "kind": "residual" }
  ]
}
```

- **`kind`**: `module | op | param | io | group` — drives color and geometry.
- **Recursion**: `children` is a subgraph with its own edges; lazy-loaded so a large model is
  never fully in memory.
- **Data flow**: every `data` edge requires a typed `tensor` (named dims + dtype). Named axes (`B`,
  `T`, `D`) let the validator check shapes _agree_ at joins, not merely that numbers match.
  `residual`/`skip` edges are first-class and styled distinctly.

## 3. The decision, assumption & confidence layer (the actual point)

Each node (and edge) may carry a `design` block — this is what makes my reasoning visible:

```jsonc
"design": {
  "decisions": [
    { "choice": "Pre-norm (LayerNorm before attention).",
      "alternatives": [ { "option": "Post-norm", "whyNot": "Less stable at depth without warmup." } ],
      "rationale": "Standard for decoder-only LMs at this scale; stabilizes training.",
      "confidence": "high",            // low | medium | high  (or 0..1)
      "reversibility": "load-bearing", // load-bearing | easily-changed
      "status": "proposed" }           // proposed | confirmed | diverged  (status is human-set)
  ],
  "assumptions": [
    { "text": "Vocab size 50257 (GPT-2 BPE).", "checked": false,
      "impact": "Sets lm_head output width; wrong if a different tokenizer is used." }
  ]
}
```

Three mechanisms turn this data into communication:

- **The surprise surface.** The canvas _actively_ highlights where you'd want to look: nodes whose
  `confidence` is low, that carry unchecked `assumptions`, that are `load-bearing` **and** not yet
  `confirmed`, or where my `choice` deviates from a common default. You never hunt for where I went
  off-script — it glows. A "show me what you weren't sure about / what you decided for me" view
  filters the whole model to exactly those nodes.
- **Confidence & review as a primary visual channel** (not buried metadata). Calm/cool = confirmed
  and confident; warm/pulsing = unreviewed, low-confidence, or assumption-laden. Sweeping the model
  tells you at a glance where alignment is solid and where it's owed.
- **The review loop (two-way).** You mark a node `confirmed`, or flag `diverged` with a note, from
  the pane. `status` is **human-set only** (like `guide:` keys today — the agent's write tool cannot
  touch it), so ratification is yours. Unratified + load-bearing nodes stay visually loud until you
  sign off. _This is the closed loop that prevents "I didn't even know."_

## 4. Validator — exactness for the substrate, honesty for the intent

Runs on every write:

1. **Structural**: every edge endpoint resolves; no dangling refs/orphans; `children` form a DAG
   (cycles only via explicit `recurrent` edges).
2. **Shape propagation**: walk from `io.in`, propagate tensor shapes through edges, assert each
   node's declared `io.out` matches what its inputs imply. Mismatch = hard error, node highlighted.
   This _proves the structure is internally consistent._
3. **Completeness & honesty**: `summary`/`description` present and non-trivial on every node; every
   `data` edge typed; **and every `load-bearing` node carries at least one recorded `decision`.**
   Surfaced as a completeness meter so partial work is visible, never passed off as finished.

Honest limit (agent-authored): the validator catches _inconsistency_, not _wrongness_ — a
self-consistent but incorrect model still passes. Mitigations: the `source` provenance fields and
the decision/assumption layer give you the hooks to spot-check; ingestion (deferred) closes it.

## 5. The experience — Jarvis, not a node editor

3D and motion exist to aid comprehension, never as decoration:

- **The model presents itself.** On open it composes/assembles so you see how it's built, then
  settles. Selecting a part smoothly focuses the camera; ambient labels stay readable.
- **You interrogate it.** Ask "why is this here?" and the inspector narrates the `design` block —
  the choice, the rejected alternatives and why, the assumptions, the confidence. The surprise
  surface speaks first, unprompted, about what you'd most want to question.
- **Spatial grammar (axes carry meaning, so 3D earns its place):** X = data flow (in → out);
  Y = parallel structure (residual branch, heads, experts fan out); Z = abstraction depth —
  drilling into a node flies the camera _inward_ to a deeper plane, the parent a translucent frame
  around the child, the breadcrumb the stack of planes behind you. **Recursion becomes travel.**
  Homogeneous repeats (e.g. 48 identical blocks) render as planes you fly through like floors of a
  building. A 2D-per-plane fallback exists for when 3D hurts more than it helps.
- **Words live in a DOM overlay**, not the canvas — selectable, scrollable, legible. Canvas does
  geometry; HTML does prose and the raw node JSON (the "dict view").

## 6. Rendering stack

- **react-three-fiber + three.js + drei** (orbit, instancing, HTML overlays) — fits the existing
  React renderer; runs inside the sandboxed pane.
- **Layout**: `elkjs` layered DAG layout per level in a **web worker**, lifted into 3D, and
  **deterministic** (seeded by node id) so the scene does not reshuffle on each edit.
- **Scale**: GPU instancing for repeats; level-of-detail (collapsed node = summary card); lazy
  subtree loading on descend.

## 7. Host-API fit — the one real new capability

A full model's JSON exceeds the 20k-token `contextExports` cap, and re-injecting the whole tree
every turn is wasteful:

- **Full document** → plugin **`storage`** (out of per-turn context).
- **Pinned context export** → only the **root outline + the surprise surface** (the unreviewed /
  low-confidence / load-bearing-unconfirmed node list), so each turn I am reminded what alignment
  is still owed — cheaply.
- **Writes** → **node-addressable**, not whole-doc replace.

**Open decision (settle before P4):** recommend extending the generic context engine with
**JSON-Pointer (RFC 6901) path-scoped writes** for `format: "json"` exports — a generic
`set_<plugin>__<key>__at(path, value)` tool, no per-plugin code, reusable by any large-doc plugin
(data-table benefits too). Keeps the "engine is generic" invariant. Alternative (a child-process
backend) is heavier and reintroduces a non-hot-reloaded backend for pure data mutation — avoid.
Note: human-set `status` needs an author-only write path mirroring today's `guide:` rule.

## 8. Risks, ranked

1. **I under-record intent.** The whole value collapses if I draw structure but skip the `design`
   blocks. Mitigation: validator requires decisions on load-bearing nodes; completeness meter; the
   surprise surface makes a bare model look conspicuously unreviewed.
2. **Authoring fidelity** (validator catches inconsistency, not wrongness). Mitigation: `source`
   provenance; revisit ingestion when a framework is chosen.
3. **Scale** → context budget + render perf. Mitigation: out-of-context storage, lazy load, LOD.
4. **3D legibility / motion sickness.** Mitigation: strict spatial grammar + 2D fallback; motion
   serves focus, never spectacle.

## 9. Proposed phasing (each runs and meets acceptance before the next)

The communication layer threads through from the start — it is not late-phase polish.

- **P1 — Substrate + intent, flat.** Schema (incl. `design` block) + validator (structural, shape
  propagation, completeness incl. decisions-on-load-bearing) + a static example, rendered **2D**.
  _Acceptance:_ validator rejects dangling edges, shape mismatches, missing descriptions, and a
  load-bearing node with no recorded decision.
- **P2 — 3D single level + inspector** that narrates the `design` block. _Acceptance:_ select a
  node, see its choice/alternatives/assumptions/confidence.
- **P3 — Recursion** (drill-down-as-Z, breadcrumb, lazy load) **+ the surprise surface**.
  _Acceptance:_ the canvas auto-highlights unreviewed/low-confidence/load-bearing nodes; descend
  and ascend stays legible.
- **P4 — Review loop + scale + writes.** Human `confirmed`/`diverged` (author-only path); LOD,
  instancing, fly-through stacks; resolve node-addressable writes (§7). _Acceptance:_ ratify a
  node from the pane and watch it go calm; a small full model navigable at interactive framerate.
- **P5 — Jarvis polish.** Assemble-on-open, animated dataflow, narrated walkthroughs.

## 10. Deferred / future seams

- **Ingestion adapters** (ONNX / torch.fx / JAX trace → this schema) once a framework is chosen —
  upgrades "agent-authored" to "machine-extracted + agent-annotated" without schema change.
- **Runtime overlay** (activation/gradient stats) as an optional layer.
