# DATA_MODEL.md — Schemas, component catalog, and file format

Everything visible is generated from plain data. Port these as typed modules under
`src/data/`. Three functions produce all content:

- `getModel('transformer' | 'rnn')` → the top-level architecture scene.
- `getDetail(node)` → the internals scene for a drilled-into node (keyed by
  `node.glyph`).
- Both return the same `SceneData` shape consumed by `renderScene` (ARCHITECTURE §3).

---

## 1. TypeScript schema (`src/data/schema.ts`)

```ts
export type Vec3 = [number, number, number];
export type Hex  = string;            // e.g. "#35d7ff"

export interface Spec { k: string; v: string; }   // a key/value row in the inspector

export type Glyph =
  | 'tokens' | 'embedding' | 'wave' | 'attention' | 'addnorm'
  | 'ffn' | 'dist' | 'cell' | 'vec'
  | 'matrix' | 'sum' | 'curve' | 'op';            // 'op' / unknown → default cube

export interface NodeDef {
  id: string;            // unique within the scene
  label: string;         // sprite label + inspector title
  type: string;          // short uppercase role tag, e.g. "ATTENTION"
  glyph: Glyph;          // which geometry builder to use
  pos: Vec3;             // center, world units
  size: [number, number, number];  // bounding box (also the pick target)
  color: Hex;            // glyph + edge color
  desc: string;          // plain-English explanation (inspector body)
  specs?: Spec[];        // inspector key/value rows

  // glyph-specific options:
  heads?: number;        // 'attention' — number of head-planes (visual cap 4)
  rows?: number;         // 'vec'/'matrix' — cell rows
  cols?: number;         // 'matrix' — cell columns
  hi?: number;           // 'matrix' — index of a row to highlight white
  fn?: 'tanh'|'gelu'|'bell'; // 'curve' — activation shape
}

export interface EdgeDef {
  a: string;             // from node id
  b: string;             // to node id
  residual?: boolean;    // faint bowed skip line, no packet
  recur?: boolean;       // teal recurrent line (RNN)
  speed?: number;        // packet speed multiplier (default 1)
}

export interface FloatLabel { t: string; pos: Vec3; }

export interface SceneData {
  nodes: NodeDef[];
  edges: EdgeDef[];
  floats?: FloatLabel[];
  grid: number;          // grid plane y-position
  cam: Vec3;             // camera position for this scene
  target: Vec3;          // orbit target
  title?: string;        // detail scenes only (HUD title)
  subtitle?: string;     // detail scenes only (HUD subtitle)
}
```

### Color constants (used throughout)
```ts
const TEAL = '#36f0e0';  // attention / hidden state
const GOLD = '#ffce7a';  // feed-forward / activations
const ROSE = '#ff8fb0';  // outputs / blends
const WC   = '#bfefff';  // white-cyan (norms, matrices, neutral)
// P = palette primary (#35d7ff Arc Reactor by default) — structural nodes
```

---

## 2. Top-level architectures

### 2a. Transformer encoder — `getModel('transformer')`
A vertical tower, data flowing bottom → top. Camera `[17,3,34]`, target `[0,0.6,0]`,
grid `-13.8`, float label `"ENCODER BLOCK × 6"` at `[6.6,2,0]`.

| id | label | type | glyph | pos | color | specs |
|---|---|---|---|---|---|---|
| tok | Input Tokens | INPUT | tokens | [0,−12.6,0] | P | seq len: n · vocab: ~50k |
| emb | Token Embedding | EMBEDDING | embedding | [0,−9.9,0] | P | d_model: 512 |
| pos | Positional Encoding | POSITION | wave | [6.1,−9.9,0] | WC | type: sinusoidal |
| mha1 | Multi-Head Attention | ATTENTION | attention (heads 6) | [0,−6.4,0] | TEAL | heads: 8 · d_k: 64 |
| n1 | Add & Norm | RESIDUAL + NORM | addnorm | [0,−3.9,0] | WC | op: x + Sublayer(x) |
| ffn1 | Feed Forward | FEED-FORWARD | ffn | [0,−1.4,0] | GOLD | d_ff: 2048 |
| n2 | Add & Norm | RESIDUAL + NORM | addnorm | [0,1,0] | WC | op: x + Sublayer(x) |
| mha2 | Multi-Head Attention | ATTENTION | attention (heads 6) | [0,4,0] | TEAL | heads: 8 · d_k: 64 |
| n3 | Add & Norm | RESIDUAL + NORM | addnorm | [0,6.5,0] | WC | op: x + Sublayer(x) |
| ffn2 | Feed Forward | FEED-FORWARD | ffn | [0,9,0] | GOLD | d_ff: 2048 |
| n4 | Add & Norm | RESIDUAL + NORM | addnorm | [0,11.4,0] | WC | op: x + Sublayer(x) |
| out | Linear + Softmax | OUTPUT | dist | [0,14,0] | ROSE | output: vocab logits |

Edges (flow): tok→emb, pos→emb (speed .7), emb→mha1, mha1→n1, n1→ffn1, ffn1→n2,
n2→mha2, mha2→n3, n3→ffn2, ffn2→n4, n4→out.
Residual (skip) edges: emb→n1, n1→n2, n2→n3, n3→n4 (all `residual: true`).

**Descriptions** (inspector body, verbatim):
- **Input Tokens** — "The raw input sequence split into tokens (sub-words). Each token is mapped to an integer ID drawn from the model's vocabulary."
- **Token Embedding** — "A learned lookup table converts every token ID into a dense vector of dimension d_model. Tokens with related meaning end up close together in this space."
- **Positional Encoding** — "Adds order information. Sinusoidal (or learned) vectors are summed onto the embeddings so the model knows where each token sits — attention itself is order-agnostic."
- **Multi-Head Attention (mha1)** — "Self-attention lets every token look at every other token. The input is projected into Queries, Keys and Values and split across h parallel heads. Each head computes softmax(QKᵀ/√dₖ)·V; the heads are concatenated and projected back."
- **Multi-Head Attention (mha2)** — "The second encoder layer's self-attention. Stacking layers lets the model compose simple relations from lower layers into richer, more abstract ones."
- **Add & Norm** — "A residual connection adds the sub-layer's input back to its output, then Layer Normalization rescales the activations. This keeps gradients stable through a deep stack of layers."
- **Feed Forward (ffn1)** — "A position-wise MLP applied to each token independently: two linear layers with a GELU between them. It expands to a wide inner dimension and back, adding non-linear capacity."
- **Feed Forward (ffn2)** — "The second layer's feed-forward block. Identical structure, separate weights — every layer learns its own transformation of the sequence."
- **Linear + Softmax** — "A final linear layer projects the top-layer vectors onto vocabulary logits; softmax turns them into a probability distribution over the next token."

### 2b. RNN (unrolled) — `getModel('rnn')`
A horizontal timeline, t = 1…4 at x = −7.5, −2.5, 2.5, 7.5. Camera `[0,3,30]`,
target `[0,0,0]`, grid `-5`, float `"TIME →"` at `[0,-4.6,0]`.

Per timestep t: an input vector `x{t}` (glyph `vec`, P, y −3.4), a hidden cell
`h{t}` (glyph `cell`, TEAL, y 0), an output `y{t}` (glyph `vec`, GOLD, y 3.4).
Plus an initial state `h₀` (glyph `vec`, P) at `[-12.6,0,0]`.

Edges per t: `x{t}→h{t}`, `h{t}→y{t}`, and a **recurrent** `h{t-1}→h{t}`
(`recur: true`; for t=1 it is `h0→h1`).

Descriptions:
- **x{t} (INPUT)** — "The input vector at this timestep — typically the embedding of the t-th element of the sequence."
- **h{t} (HIDDEN STATE)** — "The cell's memory at step t: hₜ = tanh(W·xₜ + U·hₜ₋₁ + b). It blends the current input with everything seen before and is carried forward to the next step. The same weights W, U are reused at every timestep." (specs: dim 256 · activation tanh)
- **y{t} (OUTPUT)** — "The prediction at step t, read out from the hidden state: yₜ = softmax(V·hₜ)."
- **h₀ (INIT STATE)** — "The initial hidden state — usually all zeros. It seeds the recurrence before any input has been seen." (specs: value 0)

---

## 3. Drill-down internals — `getDetail(node)`

Switches on `node.glyph`. Each returns a `SceneData` with `title`/`subtitle`. Common
grid `-7.5`. Layouts are left → right pipelines. Below: the node list (id · label ·
glyph) and edges; descriptions are short, plain-English, and already written in the
prototype (lift them verbatim).

### `attention` → "Multi-Head Self-Attention" (cam `[0.8,1,31]`, target `[0.8,0.3,0]`)
Nodes: `x` (X · token vectors, vec) → `wq`/`wk`/`wv` (Wq/Wk/Wv, matrix) →
`q`/`k`/`v` (Q/K/V, vec) → `qk` (QKᵀ scores, matrix) → `soft` (Softmax ÷√dₖ, dist) →
`av` (A·V blend, matrix) → `wo` (Concat·Wₒ, matrix) → `out` (Output, vec).
Edges: x→wq, x→wk, x→wv, wq→q, wk→k, wv→v, q→qk, k→qk, qk→soft, soft→av, v→av,
av→wo, wo→out.

### `ffn` → "Position-wise Feed-Forward" (cam `[0,1,26]`)
`in` (x·d=512, vec) → `w1` (W₁·512→2048, matrix) → `hid` (hidden·2048, vec rows 12) →
`gelu` (GELU, curve fn gelu) → `w2` (W₂·2048→512, matrix) → `out` (output·d=512, vec).
Linear chain.

### `embedding` → "Token Embedding Lookup" (cam `[0,1,24]`, target `[-1,0,0]`)
`id` (token ID = 8123, op) → `tab` (Embedding table V×d, matrix cols 6 rows 14 hi 8)
→ `vec` (embedding vector, vec rows 7).

### `addnorm` → "Add & Norm" (cam `[0,1,24]`, target `[-0.5,0,0]`)
`sub` (Sublayer output, vec) + `res` (Residual input, vec) → `add` (⊕ Add, sum) →
`norm` (LayerNorm, curve fn bell) → `out` (Output, vec).

### `wave` → "Sinusoidal Positional Encoding" (cam `[0,1,26]`, target `[-1,0,0]`)
`sin` (sin(...), wave) + `cos` (cos(...), wave) → `pe` (PE[pos,dim], matrix cols 18
rows 12).

### `tokens` → "Tokenization" (cam `[0,1,24]`)
`txt` ("…", op) → `bpe` (BPE tokenizer, op) → `tok` (sub-word tokens, tokens) →
`ids` (token IDs, vec rows 5).

### `dist` → "Output Projection + Softmax" (cam `[0,1,26]`)
`h` (final hidden, vec) → `w` (Linear d→V, matrix) → `log` (logits, dist) →
`soft` (softmax, dist) → `pick` (argmax → token, op).

### `cell` → "RNN Cell · one timestep" (cam `[0,1,28]`, target `[0.5,0,0]`)
`x` (xₜ, vec) → `wx` (W, matrix); `hp` (hₜ₋₁, vec) → `uh` (U, matrix); wx→`sum`,
uh→`sum` (⊕ + b, sum) → `tanh` (tanh, curve fn tanh) → `hn` (hₜ new state, vec) →
`y` (yₜ output, vec).

### default (any `vec`/`op` leaf, e.g. `x{t}`, `y{t}`, `h₀`)
A single large `vec` node showing the vector, titled with the node's own label and
description. (cam `[0,0.5,16]`.)

> **Adding a new component type** = add a `glyph` builder (glyphs.ts), one or more
> nodes in `getModel`, and a `case` in `getDetail`. No engine changes.

---

## 4. User-authored model file format (`.nnviz.json`)

For the desktop Open/Save feature, persist a whole architecture (overview + optional
custom internals) as JSON. Recommended envelope:

```jsonc
{
  "format": "nnviz/1",
  "name": "My Encoder-Decoder",
  "palette": "Arc Reactor",          // optional default palette
  "scene": {                          // a SceneData (see schema)
    "cam": [17, 3, 34],
    "target": [0, 0.6, 0],
    "grid": -13.8,
    "floats": [{ "t": "× 6", "pos": [6.6, 2, 0] }],
    "nodes": [
      { "id": "tok", "label": "Input Tokens", "type": "INPUT",
        "glyph": "tokens", "pos": [0,-12.6,0], "size": [6.6,1.1,2],
        "color": "#35d7ff", "desc": "…", "specs": [{ "k": "vocab", "v": "~50k" }] }
      /* … */
    ],
    "edges": [{ "a": "tok", "b": "emb" }]
  },
  "details": {                        // optional: override internals per node id
    "mha1": { /* a SceneData with title/subtitle */ }
  }
}
```

Loader rules:
- Validate against the schema; reject unknown `glyph` values (or fall back to the
  default cube) and report which node failed.
- If a node has no entry in `details`, `getDetail` falls back to the built-in graph
  for that `glyph` (so authors only override what they want).
- Keep the two built-in architectures (`transformer`, `rnn`) as bundled JSON so the
  same loader path serves built-ins and user files.

This makes the app a **generic neural-architecture viewer**, not just a two-model
demo — the headline reason to invest in the desktop build.
