// glyphs.js — the open GLYPH registry + the kind→{glyph,color} defaults + the categorical palette.
// A glyph is an ABSTRACT 3D form (iconic/structural) — it never renders the node's data. Each
// builder is a pure function (node, gx) => THREE.Group, where `gx` carries THREE + the wireframe
// primitive helpers. The 13 NN glyphs are ported ~verbatim from the prototype; `neutral` is the
// graceful fallback for any unknown glyph/kind. Adding a concept = add an entry here, no engine edit.

/** Build the glyph context (THREE + primitive helpers) once; pass to every builder. */
export function makeGlyphCtx(THREE) {
  const gMat = (c, o) =>
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false })
  const gCube = (w, h, d, c, o) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gMat(c, o))
  const gEdge = (geo, c, o) =>
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o })
    )
  const gLine = (pts, c, o) =>
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
      new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o })
    )
  return { THREE, gMat, gCube, gEdge, gLine }
}

// Categorical palette: color by node `kind`, independent of the structural primary. Open — unknown
// kinds fall back to `default`.
export const CATEGORY_COLORS = {
  input: '#35d7ff',
  output: '#ff8fb0',
  attention: '#36f0e0',
  ffn: '#ffce7a',
  mlp: '#ffce7a',
  norm: '#bfefff',
  embedding: '#35d7ff',
  position: '#bfefff',
  recurrent: '#36f0e0',
  expert: '#c9a0ff',
  router: '#ffd27a',
  conv: '#7affc0',
  cache: '#9fb8ff',
  data: '#9fd2e6',
  control: '#ff9f6b',
  memory: '#b0e0a0',
  tool: '#9ad0ff',
  retrieval: '#ffb0e0',
  db: '#a0c0ff',
  index: '#a0c0ff',
  default: '#9fb6c4'
}

// kind → default { glyph, color }. The agent usually sets only `kind`; glyph/color fill in here.
export const KIND_DEFAULTS = {
  input: { glyph: 'tokens', color: CATEGORY_COLORS.input },
  tokens: { glyph: 'tokens', color: CATEGORY_COLORS.input },
  embedding: { glyph: 'embedding', color: CATEGORY_COLORS.embedding },
  position: { glyph: 'wave', color: CATEGORY_COLORS.position },
  attention: { glyph: 'attention', color: CATEGORY_COLORS.attention },
  norm: { glyph: 'addnorm', color: CATEGORY_COLORS.norm },
  ffn: { glyph: 'ffn', color: CATEGORY_COLORS.ffn },
  mlp: { glyph: 'ffn', color: CATEGORY_COLORS.mlp },
  output: { glyph: 'dist', color: CATEGORY_COLORS.output },
  recurrent: { glyph: 'cell', color: CATEGORY_COLORS.recurrent },
  vector: { glyph: 'vec', color: CATEGORY_COLORS.data },
  matrix: { glyph: 'matrix', color: CATEGORY_COLORS.norm },
  activation: { glyph: 'curve', color: CATEGORY_COLORS.ffn },
  sum: { glyph: 'sum', color: CATEGORY_COLORS.norm },
  // system / non-NN kinds → a structural glyph (or neutral slab) in their category color
  expert: { glyph: 'neutral', color: CATEGORY_COLORS.expert },
  router: { glyph: 'router', color: CATEGORY_COLORS.router },
  moe: { glyph: 'router', color: CATEGORY_COLORS.router },
  conv: { glyph: 'volume', color: CATEGORY_COLORS.conv },
  cache: { glyph: 'cache', color: CATEGORY_COLORS.cache },
  data: { glyph: 'neutral', color: CATEGORY_COLORS.data },
  control: { glyph: 'neutral', color: CATEGORY_COLORS.control },
  memory: { glyph: 'cache', color: CATEGORY_COLORS.memory },
  tool: { glyph: 'neutral', color: CATEGORY_COLORS.tool },
  retrieval: { glyph: 'router', color: CATEGORY_COLORS.retrieval },
  db: { glyph: 'db', color: CATEGORY_COLORS.db },
  index: { glyph: 'db', color: CATEGORY_COLORS.index }
}

export function defaultGlyphFor(kind) {
  return KIND_DEFAULTS[kind]?.glyph || 'neutral'
}
export function defaultColorFor(kind) {
  return KIND_DEFAULTS[kind]?.color || CATEGORY_COLORS[kind] || CATEGORY_COLORS.default
}

// ── The registry. Each: (node, gx) => THREE.Group. ────────────────────────────────────────────
export const GLYPHS = {
  tokens(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0]
    const k = 7,
      gw = w * 0.92,
      cs = Math.min(0.95, (gw / k) * 0.62)
    for (let i = 0; i < k; i++) {
      const x = -gw / 2 + (i + 0.5) * (gw / k),
        lit = i % 3 === 1 || i === 4
      const b = gx.gCube(cs, cs, cs, col, lit ? 0.85 : 0.28)
      b.position.x = x
      g.add(b)
      const e = gx.gEdge(b.geometry, col, 0.85)
      e.position.x = x
      g.add(e)
    }
    return g
  },
  embedding(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1],
      d = n.size[2]
    const cols = 7,
      rows = 5,
      gw = w * 0.88,
      gh = h * 0.82,
      cw = (gw / cols) * 0.74,
      ch = (gh / rows) * 0.74
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const x = -gw / 2 + (c + 0.5) * (gw / cols),
          y = -gh / 2 + (r + 0.5) * (gh / rows)
        const op = 0.14 + 0.72 * (0.5 + 0.5 * Math.sin(c * 1.3 + r * 0.9 + c * r * 0.21))
        const b = gx.gCube(cw, ch, 0.14, col, op)
        b.position.set(x, y, d * 0.16)
        g.add(b)
      }
    return g
  },
  wave(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1],
      d = n.size[2]
    const lines = 4,
      amp = h * 0.17,
      segs = 44,
      gw = w * 0.9
    for (let li = 0; li < lines; li++) {
      const freq = 0.7 + li * 0.7,
        ph = li * 0.85,
        z = (li - (lines - 1) / 2) * (d * 0.2)
      const pts = []
      for (let s = 0; s <= segs; s++) {
        const x = -gw / 2 + (gw * s) / segs
        pts.push([x, Math.sin(x * freq + ph) * amp, z])
      }
      g.add(gx.gLine(pts, col, 0.85))
    }
    return g
  },
  attention(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1],
      d = n.size[2]
    const heads = Math.min(4, n.heads || 4),
      Nc = 4,
      plane = Math.min(w, h) * 0.66,
      cell = (plane / Nc) * 0.72,
      zspan = d * 0.66
    for (let hd = 0; hd < heads; hd++) {
      const z = heads > 1 ? -zspan / 2 + (zspan * hd) / (heads - 1) : 0
      for (let r = 0; r < Nc; r++)
        for (let c = 0; c < Nc; c++) {
          const x = -plane / 2 + (c + 0.5) * (plane / Nc),
            y = plane / 2 - (r + 0.5) * (plane / Nc),
            dd = r - c
          const op = 0.1 + 0.72 * Math.exp((-dd * dd) / 1.5)
          const b = gx.gCube(cell, cell, 0.07, col, op)
          b.position.set(x, y, z)
          g.add(b)
        }
      const fr = gx.gEdge(new T.PlaneGeometry(plane, plane), col, 0.22)
      fr.position.z = z
      g.add(fr)
    }
    return g
  },
  addnorm(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const R = Math.min(w, h) * 0.34
    g.add(new T.Mesh(new T.TorusGeometry(R, 0.055, 8, 40), gx.gMat(col, 0.85)))
    g.add(gx.gCube(R * 1.05, 0.07, 0.07, col, 0.9))
    g.add(gx.gCube(0.07, R * 1.05, 0.07, col, 0.9))
    const arc = new T.Mesh(new T.TorusGeometry(w * 0.32, 0.05, 8, 44, Math.PI), gx.gMat(col, 0.55))
    arc.scale.set(1, 0.45, 1)
    arc.position.y = R * 0.1
    g.add(arc)
    return g
  },
  ffn(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const inN = 3,
      hidN = 9,
      outN = 3,
      gw = w * 0.9,
      gh = h * 0.78
    const layer = (cnt, y, sf) => {
      const a = [],
        sw = gw * sf
      for (let i = 0; i < cnt; i++) a.push([cnt > 1 ? -sw / 2 + (sw * i) / (cnt - 1) : 0, y, 0])
      return a
    }
    const L0 = layer(inN, -gh / 2, 0.42),
      L1 = layer(hidN, 0, 1),
      L2 = layer(outN, gh / 2, 0.42)
    const conn = (A, B) => A.forEach((a) => B.forEach((b) => g.add(gx.gLine([a, b], col, 0.1))))
    conn(L0, L1)
    conn(L1, L2)
    const nd = (p, o) => {
      const s = gx.gCube(0.18, 0.18, 0.18, col, o)
      s.position.set(p[0], p[1], p[2])
      g.add(s)
    }
    L0.forEach((p) => nd(p, 0.85))
    L1.forEach((p) => nd(p, 0.92))
    L2.forEach((p) => nd(p, 0.85))
    return g
  },
  dist(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const hs = [0.22, 0.4, 0.95, 0.55, 0.3, 0.72, 0.34, 0.2, 0.46],
      k = hs.length,
      gw = w * 0.9,
      bw = (gw / k) * 0.55
    for (let i = 0; i < k; i++) {
      const x = -gw / 2 + (i + 0.5) * (gw / k),
        bh = hs[i] * h * 0.82
      const b = gx.gCube(bw, bh, bw, col, 0.35 + 0.5 * hs[i])
      b.position.set(x, -h * 0.36 + bh / 2, 0)
      g.add(b)
      const e = gx.gEdge(b.geometry, col, 0.5)
      e.position.copy(b.position)
      g.add(e)
    }
    return g
  },
  cell(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1],
      d = n.size[2]
    const bw = w * 0.74,
      bh = h * 0.6,
      bd = d * 0.6
    g.add(gx.gEdge(new T.BoxGeometry(bw, bh, bd), col, 0.8))
    for (let i = 0; i < 3; i++) {
      const s = gx.gCube(0.36, 0.36, 0.36, col, 0.72)
      s.position.set(-bw / 4 + (i * bw) / 4, 0, 0)
      g.add(s)
    }
    const loop = new T.Mesh(
      new T.TorusGeometry(h * 0.24, 0.05, 8, 34, Math.PI * 1.45),
      gx.gMat(col, 0.7)
    )
    loop.position.y = bh / 2 + h * 0.14
    loop.rotation.z = -Math.PI * 0.22
    g.add(loop)
    return g
  },
  matrix(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const cols = n.cols || 6,
      rows = n.rows || 6,
      gw = w * 0.84,
      gh = h * 0.84,
      cw = (gw / cols) * 0.82,
      ch = (gh / rows) * 0.82
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const x = -gw / 2 + (c + 0.5) * (gw / cols),
          y = gh / 2 - (r + 0.5) * (gh / rows),
          hot = n.hi != null && r === n.hi
        const op = hot ? 0.95 : 0.13 + 0.5 * (0.5 + 0.5 * Math.sin(c * 0.9 + r * 1.3 + c * 0.2))
        const b = gx.gCube(cw, ch, 0.1, hot ? '#ffffff' : col, op)
        b.position.set(x, y, 0)
        g.add(b)
      }
    g.add(gx.gEdge(new T.PlaneGeometry(gw * 1.05, gh * 1.05), col, 0.3))
    return g
  },
  sum(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const R = Math.min(w, h) * 0.34
    g.add(new T.Mesh(new T.TorusGeometry(R, 0.06, 10, 44), gx.gMat(col, 0.9)))
    g.add(gx.gCube(R * 1.0, 0.08, 0.08, col, 0.95))
    g.add(gx.gCube(0.08, R * 1.0, 0.08, col, 0.95))
    return g
  },
  curve(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const segs = 48,
      gw = w * 0.78,
      amp = h * 0.3,
      fn = n.fn || 'tanh'
    const f = (u) => {
      if (fn === 'gelu')
        return Math.max(-0.18, (u * 0.5 * (1 + Math.tanh(0.7978 * (u + 0.0447 * u * u * u)))) / 2.2)
      if (fn === 'bell') return Math.exp(-u * u * 0.7) - 0.4
      if (fn === 'relu') return Math.max(0, u) * 0.5
      if (fn === 'sigmoid') return 1 / (1 + Math.exp(-u * 2)) - 0.5
      return Math.tanh(u * 1.4)
    }
    const pts = []
    for (let s = 0; s <= segs; s++) {
      const u = ((s / segs) * 2 - 1) * 2.6
      pts.push([-gw / 2 + (gw * s) / segs, f(u) * amp, 0])
    }
    g.add(gx.gLine(pts, col, 0.92))
    g.add(
      gx.gLine(
        [
          [-gw / 2, 0, 0],
          [gw / 2, 0, 0]
        ],
        col,
        0.18
      )
    )
    g.add(
      gx.gLine(
        [
          [0, -amp, 0],
          [0, amp, 0]
        ],
        col,
        0.18
      )
    )
    return g
  },
  vec(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const rows = n.rows || 4,
      gh = h * 0.82,
      ch = (gh / rows) * 0.72,
      cw = w * 0.5
    for (let r = 0; r < rows; r++) {
      const y = -gh / 2 + (r + 0.5) * (gh / rows),
        op = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(r * 1.7 + 1))
      const b = gx.gCube(cw, ch, 0.3, col, op)
      b.position.y = y
      g.add(b)
      const e = gx.gEdge(b.geometry, col, 0.5)
      e.position.y = y
      g.add(e)
    }
    return g
  },
  // ── structural glyphs for non-NN / system architectures (abstract; never data-bound) ──
  volume(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1],
      d = n.size[2]
    const N = 3,
      sx = w * 0.62,
      sy = h * 0.62,
      sz = d * 0.62,
      cs = (Math.min(sx, sy, sz) / N) * 0.6
    for (let ix = 0; ix < N; ix++)
      for (let iy = 0; iy < N; iy++)
        for (let iz = 0; iz < N; iz++) {
          const x = -sx / 2 + (ix + 0.5) * (sx / N),
            y = -sy / 2 + (iy + 0.5) * (sy / N),
            z = -sz / 2 + (iz + 0.5) * (sz / N)
          const op = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(ix * 1.3 + iy * 0.9 + iz * 1.7))
          const b = gx.gCube(cs, cs, cs, col, op)
          b.position.set(x, y, z)
          g.add(b)
        }
    g.add(gx.gEdge(new T.BoxGeometry(sx, sy, sz), col, 0.3))
    return g
  },
  router(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    g.add(gx.gCube(0.34, 0.34, 0.34, col, 0.9))
    const k = 5,
      rad = Math.min(w, h) * 0.4
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2,
        x = Math.cos(a) * rad,
        y = Math.sin(a) * rad
      g.add(
        gx.gLine(
          [
            [0, 0, 0],
            [x, y, 0]
          ],
          col,
          0.4
        )
      )
      const s = gx.gCube(0.16, 0.16, 0.16, col, 0.8)
      s.position.set(x, y, 0)
      g.add(s)
    }
    return g
  },
  cache(n, gx) {
    const g = new gx.THREE.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const rows = 5,
      gh = h * 0.72,
      cw = w * 0.58,
      ch = (gh / rows) * 0.62
    for (let r = 0; r < rows; r++) {
      const y = -gh / 2 + (r + 0.5) * (gh / rows)
      const b = gx.gCube(cw, ch, 0.4, col, 0.28 + 0.45 * (r / (rows - 1)))
      b.position.y = y
      g.add(b)
      const e = gx.gEdge(b.geometry, col, 0.45)
      e.position.y = y
      g.add(e)
    }
    return g
  },
  db(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1]
    const R = Math.min(w, h) * 0.32,
      Hh = h * 0.6
    for (let i = 0; i < 3; i++) {
      const ring = new T.Mesh(
        new T.TorusGeometry(R, 0.04, 8, 40),
        gx.gMat(col, i === 0 ? 0.85 : 0.5)
      )
      ring.rotation.x = Math.PI / 2
      ring.position.y = Hh / 2 - (i * Hh) / 2
      g.add(ring)
    }
    g.add(
      gx.gLine(
        [
          [-R, -Hh / 2, 0],
          [-R, Hh / 2, 0]
        ],
        col,
        0.5
      )
    )
    g.add(
      gx.gLine(
        [
          [R, -Hh / 2, 0],
          [R, Hh / 2, 0]
        ],
        col,
        0.5
      )
    )
    return g
  },
  // The graceful fallback: a clean labeled slab — an inset translucent core + a bright wire frame.
  // Any unknown glyph or non-NN kind renders as this abstract "module" shape.
  neutral(n, gx) {
    const T = gx.THREE,
      g = new T.Group(),
      col = n.color,
      w = n.size[0],
      h = n.size[1],
      d = n.size[2]
    g.add(gx.gCube(w * 0.5, h * 0.52, d * 0.5, col, 0.16))
    g.add(gx.gEdge(new T.BoxGeometry(w * 0.5, h * 0.52, d * 0.5), col, 0.7))
    // a small top accent bar so it reads as an oriented module, not a bare box
    const bar = gx.gCube(w * 0.42, 0.06, 0.06, col, 0.85)
    bar.position.y = h * 0.3
    g.add(bar)
    return g
  }
}

/** Resolve a node to its glyph builder, falling back kind → neutral. */
export function buildGlyph(node, gx) {
  const fn = GLYPHS[node.glyph] || GLYPHS[defaultGlyphFor(node.kind)] || GLYPHS.neutral
  try {
    return fn(node, gx)
  } catch {
    return GLYPHS.neutral(node, gx)
  }
}
