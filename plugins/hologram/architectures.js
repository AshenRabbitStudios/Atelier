// architectures.js — built-in demo architectures, ported ~verbatim from the Neural Hologram
// prototype (../../ai architecture visual design handoff/.../Neural Hologram.dc.html).
//
// Pure data, no THREE dependency. Two entry points, both returning the SceneData shape the engine
// renders (see hologram.js renderScene):
//   getModel(key, P)  → a top-level architecture ('transformer' | 'rnn'). P = palette primary hex.
//   getDetail(node,P) → the internals scene for a drilled-into node, switched on node.glyph.
// These exist to lock visual fidelity against the design; the real viewer is fed by the agent.

const TEAL = '#36f0e0' // attention / hidden state
const GOLD = '#ffce7a' // feed-forward / activations
const ROSE = '#ff8fb0' // outputs / blends
const WC = '#bfefff' // white-cyan (norms, matrices, neutral)

export function getModel(key, P) {
  const resid =
    "A residual connection adds the sub-layer's input back to its output, then Layer " +
    'Normalization rescales the activations. This keeps gradients stable through a deep stack ' +
    'of layers.'

  // An archviz/2 scene with NO coordinates: proves auto-layout (3D layered), neutral glyphs,
  // categorical color, and descriptive detail panels for a non-NN (agentic RAG) system.
  if (key === 'system') {
    const N = (id, label, kind, summary, details, extra) =>
      Object.assign({ id, label, kind, summary, details: details || [] }, extra || {})
    const E = (a, b, o) => Object.assign({ a, b }, o || {})
    const nodes = [
      N('query', 'User Query', 'input', 'The incoming user request in natural language.', [
        {
          type: 'keyValue',
          title: 'I/O',
          items: [
            { k: 'modality', v: 'text' },
            { k: 'budget', v: '≤ 8k tokens' }
          ]
        }
      ]),
      N(
        'planner',
        'Planner',
        'control',
        'A controller LLM that decomposes the request and routes to tools or the responder.',
        [
          {
            type: 'markdown',
            md: 'Emits a step plan, then dispatches: retrieve context, call tools, or answer directly.'
          }
        ],
        { expandable: true }
      ),
      N(
        'retriever',
        'Retriever',
        'retrieval',
        'Embeds the query and searches the vector store for relevant chunks.'
      ),
      N(
        'vstore',
        'Vector DB',
        'db',
        'Approximate-nearest-neighbour index over the document corpus.',
        [
          {
            type: 'keyValue',
            title: 'index',
            items: [
              { k: 'metric', v: 'cosine' },
              { k: 'dim', v: '1536' },
              { k: 'vectors', v: '2.4M' }
            ]
          }
        ]
      ),
      N('tools', 'Tools', 'tool', 'External functions the agent can invoke.', [
        { type: 'list', title: 'available', items: ['web.search', 'python.run', 'sql.query'] }
      ]),
      N('memory', 'Memory', 'memory', 'Conversation + scratchpad state carried across turns.'),
      N(
        'llm',
        'Responder LLM',
        'attention',
        'Generates the final answer from the query, retrieved context and tool results.',
        [
          {
            type: 'keyValue',
            title: 'model',
            items: [
              { k: 'family', v: 'transformer' },
              { k: 'context', v: '128k' }
            ]
          }
        ],
        { expandable: true }
      ),
      N('out', 'Answer', 'output', 'The response returned to the user.')
    ]
    const edges = [
      E('query', 'planner'),
      E('planner', 'retriever'),
      E('retriever', 'vstore'),
      E('vstore', 'retriever', { kind: 'retrieval' }),
      E('planner', 'tools', { kind: 'control' }),
      E('retriever', 'llm'),
      E('tools', 'llm'),
      E('memory', 'llm', { kind: 'recurrent' }),
      E('planner', 'llm'),
      E('llm', 'out')
    ]
    return {
      format: 'archviz/2',
      id: 'system',
      title: 'Agentic RAG System',
      subtitle: 'Planner · retrieval · tools · responder — auto-laid-out, no coordinates',
      layout: { type: 'layered', rankAxis: 'y', spread: ['x', 'z'] },
      axes: {
        y: { label: 'data flow', kind: 'flow' },
        x: { label: 'parallel', kind: 'space' },
        z: { label: 'parallel', kind: 'space' }
      },
      nodes,
      edges
    }
  }

  if (key === 'transformer') {
    const N = (id, label, type, glyph, pos, size, color, desc, specs, extra) =>
      Object.assign(
        { id, label, type, glyph, pos, size, color, desc, specs: specs || [] },
        extra || {}
      )
    const nodes = [
      N(
        'tok',
        'Input Tokens',
        'INPUT',
        'tokens',
        [0, -12.6, 0],
        [6.6, 1.1, 2],
        P,
        'The raw input sequence split into tokens (sub-words). Each token is mapped to an integer ID drawn from the model’s vocabulary.',
        [
          { k: 'seq len', v: 'n' },
          { k: 'vocab', v: '~50k' }
        ]
      ),
      N(
        'emb',
        'Token Embedding',
        'EMBEDDING',
        'embedding',
        [0, -9.9, 0],
        [5.4, 2.2, 2.4],
        P,
        'A learned lookup table converts every token ID into a dense vector of dimension d_model. Tokens with related meaning end up close together in this space.',
        [{ k: 'd_model', v: '512' }]
      ),
      N(
        'pos',
        'Positional Encoding',
        'POSITION',
        'wave',
        [6.1, -9.9, 0],
        [3.3, 2.2, 1.8],
        WC,
        'Adds order information. Sinusoidal (or learned) vectors are summed onto the embeddings so the model knows where each token sits — attention itself is order-agnostic.',
        [{ k: 'type', v: 'sinusoidal' }]
      ),
      N(
        'mha1',
        'Multi-Head Attention',
        'ATTENTION',
        'attention',
        [0, -6.4, 0],
        [6.8, 2.8, 3],
        TEAL,
        'Self-attention lets every token look at every other token. The input is projected into Queries, Keys and Values and split across h parallel heads. Each head computes softmax(QKᵀ/√dₖ)·V; the heads are concatenated and projected back.',
        [
          { k: 'heads', v: '8' },
          { k: 'd_k', v: '64' }
        ],
        { heads: 6 }
      ),
      N('n1', 'Add & Norm', 'RESIDUAL + NORM', 'addnorm', [0, -3.9, 0], [5.2, 1, 2], WC, resid, [
        { k: 'op', v: 'x + Sublayer(x)' }
      ]),
      N(
        'ffn1',
        'Feed Forward',
        'FEED-FORWARD',
        'ffn',
        [0, -1.4, 0],
        [5.8, 2.4, 2.4],
        GOLD,
        'A position-wise MLP applied to each token independently: two linear layers with a GELU between them. It expands to a wide inner dimension and back, adding non-linear capacity.',
        [{ k: 'd_ff', v: '2048' }]
      ),
      N('n2', 'Add & Norm', 'RESIDUAL + NORM', 'addnorm', [0, 1, 0], [5.2, 1, 2], WC, resid, [
        { k: 'op', v: 'x + Sublayer(x)' }
      ]),
      N(
        'mha2',
        'Multi-Head Attention',
        'ATTENTION',
        'attention',
        [0, 4, 0],
        [6.8, 2.8, 3],
        TEAL,
        'The second encoder layer’s self-attention. Stacking layers lets the model compose simple relations from lower layers into richer, more abstract ones.',
        [
          { k: 'heads', v: '8' },
          { k: 'd_k', v: '64' }
        ],
        {
          heads: 6,
          details: [
            {
              type: 'markdown',
              title: 'How it works',
              md: 'Self-attention lets every position attend to every other position in the sequence. The input X (n × d_model) is linearly projected into Queries, Keys and Values, then split into h independent heads that each attend in a d_k-dimensional subspace. Per head: scores = QKᵀ/√d_k, weights = softmax(scores) row-wise, output = weights · V. The h head outputs are concatenated and mixed back to d_model by an output projection Wₒ. As the *second* encoder layer, mha2 attends over representations already contextualised by layer 1, so it composes lower-level relations into higher-level structure.'
            },
            {
              type: 'code',
              title: 'Computation',
              language: 'text',
              source:
                'Q = X·W_Q   K = X·W_K   V = X·W_V        # (n×d_model) · (d_model×d_model)\nsplit into h heads → Qᵢ, Kᵢ, Vᵢ           # each (n × d_k),  d_k = d_model/h = 64\nheadᵢ = softmax(Qᵢ·Kᵢᵀ / √d_k) · Vᵢ      # (n×n) weights → (n × d_k)\nMHA(X) = Concat(head₁ … head_h) · W_O    # back to (n × d_model)'
            },
            {
              type: 'keyValue',
              title: 'Shapes & parameters',
              items: [
                { k: 'd_model', v: '512' },
                { k: 'heads (h)', v: '8' },
                { k: 'd_k = d_v', v: '64  (= d_model / h)' },
                { k: 'W_Q / W_K / W_V', v: '3 × (512 × 512)' },
                { k: 'output W_O', v: '512 × 512' },
                { k: 'params', v: '≈ 4·d_model² ≈ 1.05M' },
                { k: 'compute', v: 'O(n²·d_model) — quadratic in sequence length' }
              ]
            },
            {
              type: 'list',
              title: 'Pipeline',
              ordered: true,
              items: [
                'Project X → Q, K, V',
                'Split into 8 heads (d_k = 64 each)',
                'Scores QKᵀ/√d_k, then softmax per row',
                'Weighted sum of V',
                'Concatenate the 8 heads',
                'Mix with Wₒ → output (n × 512)'
              ]
            },
            {
              type: 'markdown',
              title: 'Why divide by √d_k',
              md: 'Scaling the dot products by 1/√d_k keeps their variance ≈ 1 before the softmax. Without it, large d_k makes the logits big, the softmax saturates, and gradients through it vanish. (mha1 is structurally identical — same shapes, separate weights.)'
            }
          ]
        }
      ),
      N('n3', 'Add & Norm', 'RESIDUAL + NORM', 'addnorm', [0, 6.5, 0], [5.2, 1, 2], WC, resid, [
        { k: 'op', v: 'x + Sublayer(x)' }
      ]),
      N(
        'ffn2',
        'Feed Forward',
        'FEED-FORWARD',
        'ffn',
        [0, 9, 0],
        [5.8, 2.4, 2.4],
        GOLD,
        'The second layer’s feed-forward block. Identical structure, separate weights — every layer learns its own transformation of the sequence.',
        [{ k: 'd_ff', v: '2048' }]
      ),
      N('n4', 'Add & Norm', 'RESIDUAL + NORM', 'addnorm', [0, 11.4, 0], [5.2, 1, 2], WC, resid, [
        { k: 'op', v: 'x + Sublayer(x)' }
      ]),
      N(
        'out',
        'Linear + Softmax',
        'OUTPUT',
        'dist',
        [0, 14, 0],
        [5.6, 2.4, 2.2],
        ROSE,
        'A final linear layer projects the top-layer vectors onto vocabulary logits; softmax turns them into a probability distribution over the next token.',
        [{ k: 'output', v: 'vocab logits' }]
      )
    ]
    const E = (a, b, o) => Object.assign({ a, b }, o || {})
    const edges = [
      E('tok', 'emb'),
      E('pos', 'emb', { speed: 0.7 }),
      E('emb', 'mha1'),
      E('mha1', 'n1'),
      E('n1', 'ffn1'),
      E('ffn1', 'n2'),
      E('n2', 'mha2'),
      E('mha2', 'n3'),
      E('n3', 'ffn2'),
      E('ffn2', 'n4'),
      E('n4', 'out'),
      E('emb', 'n1', { residual: true }),
      E('n1', 'n2', { residual: true }),
      E('n2', 'n3', { residual: true }),
      E('n3', 'n4', { residual: true })
    ]
    return {
      nodes,
      edges,
      floats: [{ t: 'ENCODER  BLOCK  × 6', pos: [6.6, 2, 0] }],
      grid: -13.8,
      cam: [17, 3, 34],
      target: [0, 0.6, 0]
    }
  }

  // ---- RNN (unrolled) ----
  const xs = [-7.5, -2.5, 2.5, 7.5]
  const inputDesc =
    'The input vector at this timestep — typically the embedding of the t-th element of the sequence.'
  const hiddenDesc =
    'The cell’s memory at step t:  hₜ = tanh(W·xₜ + U·hₜ₋₁ + b). It blends the current input with everything seen before and is carried forward to the next step. The same weights W, U are reused at every timestep.'
  const outDesc = 'The prediction at step t, read out from the hidden state:  yₜ = softmax(V·hₜ).'
  const nodes = [
    {
      id: 'h0',
      label: 'h₀',
      type: 'INIT STATE',
      glyph: 'vec',
      pos: [-12.6, 0, 0],
      size: [2.2, 1.9, 1.8],
      color: P,
      desc: 'The initial hidden state — usually all zeros. It seeds the recurrence before any input has been seen.',
      specs: [{ k: 'value', v: '0' }]
    }
  ]
  const edges = []
  xs.forEach((x, i) => {
    const t = i + 1
    nodes.push({
      id: 'x' + t,
      label: 'x' + t,
      type: 'INPUT',
      glyph: 'vec',
      pos: [x, -3.4, 0],
      size: [2.2, 1.7, 1.6],
      color: P,
      desc: inputDesc,
      specs: [{ k: 'step', v: '' + t }]
    })
    nodes.push({
      id: 'h' + t,
      label: 'h' + t,
      type: 'HIDDEN STATE',
      glyph: 'cell',
      pos: [x, 0, 0],
      size: [3.4, 2.5, 2.5],
      color: TEAL,
      desc: hiddenDesc,
      specs: [
        { k: 'dim', v: '256' },
        { k: 'activation', v: 'tanh' }
      ]
    })
    nodes.push({
      id: 'y' + t,
      label: 'y' + t,
      type: 'OUTPUT',
      glyph: 'vec',
      pos: [x, 3.4, 0],
      size: [2.2, 1.7, 1.6],
      color: GOLD,
      desc: outDesc,
      specs: [{ k: 'step', v: '' + t }]
    })
    edges.push({ a: 'x' + t, b: 'h' + t })
    edges.push({ a: 'h' + t, b: 'y' + t })
    edges.push({ a: i === 0 ? 'h0' : 'h' + (t - 1), b: 'h' + t, recur: true })
  })
  return {
    nodes,
    edges,
    floats: [{ t: 'TIME  →', pos: [0, -4.6, 0] }],
    grid: -5,
    cam: [0, 3, 30],
    target: [0, 0, 0]
  }
}

export function getDetail(node, P) {
  const D = (id, label, type, glyph, pos, size, color, desc, extra) =>
    Object.assign(
      { id, label, type, glyph, pos, size, color, desc: desc || '', specs: [] },
      extra || {}
    )
  const E = (a, b, o) => Object.assign({ a, b }, o || {})
  const std = { grid: -7.5 }

  switch (node.glyph) {
    case 'attention': {
      const M = [2.4, 2.2, 1.4],
        Vz = [2, 2.6, 1.6],
        BIG = [3.4, 3.4, 1]
      const nodes = [
        D(
          'x',
          'X · token vectors',
          'INPUT',
          'vec',
          [-11, 0, 0],
          [2.2, 3, 1.6],
          P,
          'The layer input: one vector per token (n × d_model). Every token will be compared against every other.',
          { rows: 7 }
        ),
        D(
          'wq',
          'Wq',
          'PROJECTION',
          'matrix',
          [-7.4, 3, 0],
          M,
          WC,
          'Learned query projection. Multiplying each token vector by Wq produces its Query.',
          { cols: 5, rows: 5 }
        ),
        D(
          'wk',
          'Wk',
          'PROJECTION',
          'matrix',
          [-7.4, 0, 0],
          M,
          WC,
          'Learned key projection — produces each token’s Key.',
          { cols: 5, rows: 5 }
        ),
        D(
          'wv',
          'Wv',
          'PROJECTION',
          'matrix',
          [-7.4, -3, 0],
          M,
          WC,
          'Learned value projection — produces each token’s Value.',
          { cols: 5, rows: 5 }
        ),
        D(
          'q',
          'Q',
          'QUERIES',
          'vec',
          [-4, 3, 0],
          Vz,
          TEAL,
          'Queries — what each token is looking for.'
        ),
        D(
          'k',
          'K',
          'KEYS',
          'vec',
          [-4, 0, 0],
          Vz,
          TEAL,
          'Keys — what each token offers to be matched against.'
        ),
        D(
          'v',
          'V',
          'VALUES',
          'vec',
          [-4, -3, 0],
          Vz,
          TEAL,
          'Values — the content each token will contribute.'
        ),
        D(
          'qk',
          'QKᵀ',
          'SCORES',
          'matrix',
          [0, 1.5, 0],
          BIG,
          TEAL,
          'Every Query dotted with every Key → an n×n score matrix: how strongly each token should attend to each other token.',
          { cols: 6, rows: 6 }
        ),
        D(
          'soft',
          'Softmax ÷√dₖ',
          'WEIGHTS',
          'dist',
          [3.6, 1.5, 0],
          [3, 2.6, 1.6],
          GOLD,
          'Scores are scaled by 1/√dₖ for stability, then each row is softmaxed into attention weights that sum to 1.'
        ),
        D(
          'av',
          'A · V',
          'BLEND',
          'matrix',
          [6.8, -0.6, 0],
          BIG,
          ROSE,
          'Attention weights multiply the Values: each token’s output becomes a weighted blend of all Values.',
          { cols: 6, rows: 6 }
        ),
        D(
          'wo',
          'Concat · Wₒ',
          'MIX HEADS',
          'matrix',
          [10, -0.6, 0],
          M,
          WC,
          'The h heads ran in parallel on different sub-spaces; their outputs are concatenated and mixed back to d_model by Wₒ.',
          { cols: 5, rows: 5 }
        ),
        D(
          'out',
          'Output',
          'RESULT',
          'vec',
          [12.8, -0.6, 0],
          [2.2, 3, 1.6],
          P,
          'A context-enriched vector for every token, ready for the next sub-layer.',
          { rows: 7 }
        )
      ]
      const edges = [
        E('x', 'wq'),
        E('x', 'wk'),
        E('x', 'wv'),
        E('wq', 'q'),
        E('wk', 'k'),
        E('wv', 'v'),
        E('q', 'qk'),
        E('k', 'qk'),
        E('qk', 'soft'),
        E('soft', 'av'),
        E('v', 'av'),
        E('av', 'wo'),
        E('wo', 'out')
      ]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Multi-Head Self-Attention',
          subtitle: 'Q, K, V → scores → softmax → weighted blend',
          cam: [0.8, 1, 31],
          target: [0.8, 0.3, 0]
        },
        std
      )
    }
    case 'ffn': {
      const nodes = [
        D(
          'in',
          'x · d=512',
          'INPUT',
          'vec',
          [-10, 0, 0],
          [2.2, 3, 1.6],
          P,
          'One token vector entering the feed-forward block.',
          { rows: 7 }
        ),
        D(
          'w1',
          'W₁ · 512→2048',
          'EXPAND',
          'matrix',
          [-6, 0, 0],
          [2.6, 2.6, 1.4],
          WC,
          'First linear layer projects up to a much wider inner dimension.',
          { cols: 5, rows: 5 }
        ),
        D(
          'hid',
          'hidden · 2048',
          'WIDE LAYER',
          'vec',
          [-1.8, 0, 0],
          [2.6, 4.6, 1.8],
          GOLD,
          'A wide intermediate representation — 4× the model width — giving the block room to compute rich non-linear features.',
          { rows: 12 }
        ),
        D(
          'gelu',
          'GELU',
          'ACTIVATION',
          'curve',
          [1.8, 0, 0],
          [2.6, 2.6, 1.4],
          WC,
          'A smooth non-linearity applied element-wise; lets the network model curved relationships.',
          { fn: 'gelu' }
        ),
        D(
          'w2',
          'W₂ · 2048→512',
          'CONTRACT',
          'matrix',
          [5.6, 0, 0],
          [2.6, 2.6, 1.4],
          WC,
          'Second linear layer projects back down to d_model.',
          { cols: 5, rows: 5 }
        ),
        D(
          'out',
          'output · d=512',
          'RESULT',
          'vec',
          [9.4, 0, 0],
          [2.2, 3, 1.6],
          P,
          'The transformed token vector, same width as the input.',
          { rows: 7 }
        )
      ]
      const edges = [
        E('in', 'w1'),
        E('w1', 'hid'),
        E('hid', 'gelu'),
        E('gelu', 'w2'),
        E('w2', 'out')
      ]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Position-wise Feed-Forward',
          subtitle: 'Expand → activate → contract, per token',
          cam: [0, 1, 26],
          target: [0, 0.2, 0]
        },
        std
      )
    }
    case 'embedding': {
      const nodes = [
        D(
          'id',
          'token ID = 8123',
          'INDEX',
          'op',
          [-8, 0, 0],
          [3, 1.4, 1.4],
          P,
          'A single integer identifying the token in the vocabulary.'
        ),
        D(
          'tab',
          'Embedding table · V×d',
          'LOOKUP',
          'matrix',
          [-2.5, 0, 0],
          [3.4, 5.4, 1.4],
          WC,
          'A learned matrix with one row per vocabulary entry. The token ID simply selects a row.',
          { cols: 6, rows: 14, hi: 8 }
        ),
        D(
          'vec',
          'embedding vector',
          'RESULT',
          'vec',
          [3.2, 0, 0],
          [2.4, 3.4, 1.6],
          TEAL,
          'The selected row — a dense d_model vector that represents the token’s meaning.',
          { rows: 7 }
        )
      ]
      const edges = [E('id', 'tab'), E('tab', 'vec')]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Token Embedding Lookup',
          subtitle: 'An ID selects one row of the embedding table',
          cam: [0, 1, 24],
          target: [-1, 0, 0]
        },
        std
      )
    }
    case 'addnorm': {
      const nodes = [
        D(
          'sub',
          'Sublayer output',
          'STREAM',
          'vec',
          [-8, 2, 0],
          [2.2, 2.8, 1.6],
          TEAL,
          'The output of the attention or feed-forward sublayer.'
        ),
        D(
          'res',
          'Residual (input)',
          'SKIP',
          'vec',
          [-8, -2, 0],
          [2.2, 2.8, 1.6],
          P,
          'A copy of the sublayer’s input, carried around it unchanged.'
        ),
        D(
          'add',
          '⊕ Add',
          'RESIDUAL',
          'sum',
          [-3, 0, 0],
          [2.6, 2.6, 1.6],
          WC,
          'The two streams are summed. This skip connection lets gradients flow straight through, making deep stacks trainable.'
        ),
        D(
          'norm',
          'LayerNorm',
          'NORMALIZE',
          'curve',
          [1.6, 0, 0],
          [2.8, 2.8, 1.6],
          GOLD,
          'Each vector is re-centered to zero mean and unit variance, then scaled and shifted by learned γ, β. Keeps activations well-conditioned.',
          { fn: 'bell' }
        ),
        D(
          'out',
          'Output',
          'RESULT',
          'vec',
          [6, 0, 0],
          [2.2, 2.8, 1.6],
          P,
          'The stabilized result passed to the next sublayer.'
        )
      ]
      const edges = [E('sub', 'add'), E('res', 'add'), E('add', 'norm'), E('norm', 'out')]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Add & Norm',
          subtitle: 'Residual addition, then layer normalization',
          cam: [0, 1, 24],
          target: [-0.5, 0, 0]
        },
        std
      )
    }
    case 'wave': {
      const nodes = [
        D(
          'sin',
          'sin(pos / 10000^(2i/d))',
          'EVEN DIMS',
          'wave',
          [-7, 2.4, 0],
          [5, 2.2, 1.6],
          TEAL,
          'Even dimensions use sine waves. Low dimensions oscillate fast, high dimensions slowly.'
        ),
        D(
          'cos',
          'cos(pos / 10000^(2i/d))',
          'ODD DIMS',
          'wave',
          [-7, -2.4, 0],
          [5, 2.2, 1.6],
          GOLD,
          'Odd dimensions use cosine waves at the matching frequencies.'
        ),
        D(
          'pe',
          'PE[pos, dim]',
          'ENCODING',
          'matrix',
          [1.8, 0, 0],
          [5, 5, 1.2],
          WC,
          'Stacking the bands gives every position a unique fingerprint. Because frequencies vary smoothly, relative offsets are also recoverable.',
          { cols: 18, rows: 12 }
        )
      ]
      const edges = [E('sin', 'pe'), E('cos', 'pe')]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Sinusoidal Positional Encoding',
          subtitle: 'A bank of sine/cosine waves → a unique code per position',
          cam: [0, 1, 26],
          target: [-1, 0, 0]
        },
        std
      )
    }
    case 'tokens': {
      const nodes = [
        D(
          'txt',
          '“Holograms feel real.”',
          'RAW TEXT',
          'op',
          [-9, 0, 0],
          [4.4, 1.6, 1.4],
          P,
          'The raw input string before any processing.'
        ),
        D(
          'bpe',
          'BPE tokenizer',
          'SPLIT',
          'op',
          [-3.4, 0, 0],
          [3.2, 1.6, 1.4],
          WC,
          'A sub-word tokenizer greedily merges common character pairs, splitting text into known pieces.'
        ),
        D(
          'tok',
          'sub-word tokens',
          'TOKENS',
          'tokens',
          [2.4, 0, 0],
          [5.4, 1.6, 1.6],
          TEAL,
          'Each piece (e.g. “Holo”, “grams”) is a token. Rare words break into several; common words stay whole.'
        ),
        D(
          'ids',
          'token IDs',
          'INTEGERS',
          'vec',
          [7.8, 0, 0],
          [2.2, 2.6, 1.6],
          GOLD,
          'Every token is mapped to its integer index in the vocabulary — the numbers the model actually reads.',
          { rows: 5 }
        )
      ]
      const edges = [E('txt', 'bpe'), E('bpe', 'tok'), E('tok', 'ids')]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Tokenization',
          subtitle: 'Text → sub-word pieces → integer IDs',
          cam: [0, 1, 24],
          target: [0, 0, 0]
        },
        std
      )
    }
    case 'dist': {
      const nodes = [
        D(
          'h',
          'final hidden',
          'INPUT',
          'vec',
          [-8.5, 0, 0],
          [2.2, 3, 1.6],
          P,
          'The top-layer vector for the position whose next token we are predicting.',
          { rows: 7 }
        ),
        D(
          'w',
          'Linear · d→V',
          'PROJECT',
          'matrix',
          [-4, 0, 0],
          [2.8, 2.8, 1.4],
          WC,
          'Projects the hidden vector onto one score per vocabulary entry.',
          { cols: 6, rows: 6 }
        ),
        D(
          'log',
          'logits',
          'RAW SCORES',
          'dist',
          [0.5, 0, 0],
          [3.4, 2.8, 1.6],
          TEAL,
          'Unnormalized scores — one per possible next token.'
        ),
        D(
          'soft',
          'softmax',
          'PROBABILITIES',
          'dist',
          [4.8, 0, 0],
          [3.4, 2.8, 1.6],
          GOLD,
          'Softmax turns the logits into a probability distribution over the whole vocabulary.'
        ),
        D(
          'pick',
          'argmax → token',
          'SAMPLE',
          'op',
          [9, 0, 0],
          [3, 1.6, 1.4],
          ROSE,
          'The model samples or takes the highest-probability token as its prediction.'
        )
      ]
      const edges = [E('h', 'w'), E('w', 'log'), E('log', 'soft'), E('soft', 'pick')]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'Output Projection + Softmax',
          subtitle: 'Hidden vector → logits → probabilities → next token',
          cam: [0, 1, 26],
          target: [0, 0, 0]
        },
        std
      )
    }
    case 'cell': {
      const nodes = [
        D(
          'x',
          'xₜ · input',
          'INPUT',
          'vec',
          [-9, 2.6, 0],
          [2.2, 2.4, 1.6],
          P,
          'The input vector at the current timestep.'
        ),
        D(
          'hp',
          'hₜ₋₁ · prev state',
          'MEMORY',
          'vec',
          [-9, -2.6, 0],
          [2.2, 2.4, 1.6],
          TEAL,
          'The hidden state carried in from the previous step.'
        ),
        D(
          'wx',
          'W',
          'WEIGHTS',
          'matrix',
          [-5, 2.6, 0],
          [2.2, 2.2, 1.4],
          WC,
          'Input weights — the same matrix is reused at every timestep.',
          { cols: 5, rows: 5 }
        ),
        D(
          'uh',
          'U',
          'WEIGHTS',
          'matrix',
          [-5, -2.6, 0],
          [2.2, 2.2, 1.4],
          WC,
          'Recurrent weights applied to the previous hidden state.',
          { cols: 5, rows: 5 }
        ),
        D(
          'sum',
          '⊕ + b',
          'COMBINE',
          'sum',
          [-1, 0, 0],
          [2.6, 2.6, 1.6],
          WC,
          'The transformed input and previous state are added together with a bias.'
        ),
        D(
          'tanh',
          'tanh',
          'SQUASH',
          'curve',
          [2.8, 0, 0],
          [2.6, 2.6, 1.4],
          GOLD,
          'A tanh non-linearity squashes the result into (−1, 1), producing the new hidden state.',
          { fn: 'tanh' }
        ),
        D(
          'hn',
          'hₜ · new state',
          'MEMORY',
          'vec',
          [6.4, 0, 0],
          [2.2, 2.6, 1.6],
          TEAL,
          'The updated memory: hₜ = tanh(W·xₜ + U·hₜ₋₁ + b). Passed to the next step and to the output.'
        ),
        D(
          'y',
          'yₜ · output',
          'OUTPUT',
          'vec',
          [10, 0, 0],
          [2.2, 2.4, 1.6],
          ROSE,
          'The prediction at this step, read from hₜ via an output projection.'
        )
      ]
      const edges = [
        E('x', 'wx'),
        E('hp', 'uh'),
        E('wx', 'sum'),
        E('uh', 'sum'),
        E('sum', 'tanh'),
        E('tanh', 'hn'),
        E('hn', 'y')
      ]
      return Object.assign(
        {
          nodes,
          edges,
          title: 'RNN Cell · one timestep',
          subtitle: 'How xₜ and the previous state become new memory',
          cam: [0, 1, 28],
          target: [0.5, 0, 0]
        },
        std
      )
    }
    default: {
      const nodes = [
        D('v', node.label, node.type, 'vec', [0, 0, 0], [2.8, 4.6, 2], node.color, node.desc, {
          rows: 10
        })
      ]
      return Object.assign(
        {
          nodes,
          edges: [],
          title: node.label,
          subtitle: 'Vector representation',
          cam: [0, 0.5, 16],
          target: [0, 0, 0]
        },
        std
      )
    }
  }
}
