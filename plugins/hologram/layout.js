// layout.js — the open LAYOUT registry. Each layout maps a scene's nodes to real [x,y,z] so the
// agent supplies STRUCTURE, not coordinates. Layouts are 3D-native: `layered` fans a rank across two
// axes, `grid`/`stack` are volumetric. A node with an explicit `pos` always wins (manual override).
// Unknown layout type → `flow`. Axis names map to indices here.

const AX = { x: 0, y: 1, z: 2 }
const GAP = 1.8 // world-unit gap between node bounding boxes

function extentAlong(node, axis) {
  return node.size?.[AX[axis]] ?? 2
}
function maxExtent(nodes, axis) {
  return nodes.reduce((m, n) => Math.max(m, extentAlong(n, axis)), 0)
}
function set3(axisA, va, axisB, vb, axisC, vc) {
  const p = [0, 0, 0]
  p[AX[axisA]] = va
  p[AX[axisB]] = vb
  p[AX[axisC]] = vc
  return p
}
const OTHER = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] }

// Place nodes evenly along one axis (a chain / tower / timeline), centred at the origin.
function flow(scene, spec) {
  const axis = spec.axis || 'y'
  const nodes = scene.nodes
  const step = spec.spacing ?? maxExtent(nodes, axis) + GAP
  const n = nodes.length
  const out = {}
  nodes.forEach((node, i) => {
    const v = (i - (n - 1) / 2) * step
    const [b, c] = OTHER[axis]
    out[node.id] = set3(axis, v, b, 0, c, 0)
  })
  return out
}

// 3D layered DAG: longest-path ranks along `rankAxis`; within a rank, fan nodes across the OTHER two
// axes in a square grid. This is the layout that genuinely uses the third dimension.
function layered(scene, spec) {
  const rankAxis = spec.rankAxis || 'y'
  const [sa, sb] = spec.spread || OTHER[rankAxis]
  const nodes = scene.nodes
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const indeg = {}
  const adj = {}
  nodes.forEach((n) => {
    indeg[n.id] = 0
    adj[n.id] = []
  })
  for (const e of scene.edges || []) {
    if (e.residual || !byId[e.a] || !byId[e.b]) continue // skip skip-connections for ranking
    adj[e.a].push(e.b)
    indeg[e.b]++
  }
  // longest-path rank; robust to cycles — when the frontier empties with nodes left (a cycle),
  // force-promote the least-constrained remaining node so every node still gets ranked.
  const rank = {}
  nodes.forEach((n) => (rank[n.id] = 0))
  const processed = new Set()
  let queue = nodes.filter((n) => indeg[n.id] <= 0).map((n) => n.id)
  while (processed.size < nodes.length) {
    if (queue.length === 0) {
      const rem = nodes
        .filter((n) => !processed.has(n.id))
        .sort((a, b) => indeg[a.id] - indeg[b.id])
      queue = [rem[0].id]
    }
    const id = queue.shift()
    if (processed.has(id)) continue
    processed.add(id)
    for (const b of adj[id]) {
      rank[b] = Math.max(rank[b], rank[id] + 1)
      if (--indeg[b] <= 0 && !processed.has(b)) queue.push(b)
    }
  }
  // group by rank, place each rank in a centred square grid across (sa, sb)
  const ranks = {}
  nodes.forEach((n) => (ranks[rank[n.id]] = ranks[rank[n.id]] || []).push(n))
  const rankStep = maxExtent(nodes, rankAxis) + GAP + 0.6
  const cellA = maxExtent(nodes, sa) + GAP
  const cellB = maxExtent(nodes, sb) + GAP
  const out = {}
  for (const [r, group] of Object.entries(ranks)) {
    const cols = Math.ceil(Math.sqrt(group.length))
    group.forEach((node, i) => {
      const gx = i % cols
      const gy = Math.floor(i / cols)
      const rowsN = Math.ceil(group.length / cols)
      const va = (gx - (cols - 1) / 2) * cellA
      const vb = (gy - (rowsN - 1) / 2) * cellB
      out[node.id] = set3(rankAxis, Number(r) * rankStep, sa, va, sb, vb)
    })
  }
  return out
}

// Parallel planes stacked along an axis (layers / heads / timesteps) — same maths as flow, distinct
// intent (the scene's `axes` should label the stack axis).
function stack(scene, spec) {
  return flow(scene, { axis: spec.axis || 'z', spacing: spec.spacing })
}

// A volumetric grid: fill an [nx,ny,nz] box in row-major (or zyx) order, centred.
function grid(scene, spec) {
  const nodes = scene.nodes
  let [nx, ny, nz] = spec.dims || [
    Math.ceil(Math.cbrt(nodes.length)),
    Math.ceil(Math.cbrt(nodes.length)),
    Math.ceil(Math.cbrt(nodes.length))
  ]
  nx = Math.max(1, nx)
  ny = Math.max(1, ny)
  nz = Math.max(1, nz)
  const cx = maxExtent(nodes, 'x') + GAP
  const cy = maxExtent(nodes, 'y') + GAP
  const cz = maxExtent(nodes, 'z') + GAP
  const out = {}
  nodes.forEach((node, i) => {
    let ix, iy, iz
    if (spec.order === 'zyx') {
      iz = i % nz
      iy = Math.floor(i / nz) % ny
      ix = Math.floor(i / (nz * ny))
    } else {
      ix = i % nx
      iy = Math.floor(i / nx) % ny
      iz = Math.floor(i / (nx * ny))
    }
    out[node.id] = [(ix - (nx - 1) / 2) * cx, (iy - (ny - 1) / 2) * cy, (iz - (nz - 1) / 2) * cz]
  })
  return out
}

// Ring of nodes around a centre, in the plane perpendicular to `axis`.
function radial(scene, spec) {
  const axis = spec.axis || 'y'
  const [a, b] = OTHER[axis]
  const nodes = scene.nodes
  const radius = spec.radius ?? Math.max(4, nodes.length * 0.9)
  const out = {}
  nodes.forEach((node, i) => {
    const t = (i / Math.max(1, nodes.length)) * Math.PI * 2
    out[node.id] = set3(axis, 0, a, Math.cos(t) * radius, b, Math.sin(t) * radius)
  })
  return out
}

function manual(scene) {
  const out = {}
  scene.nodes.forEach((n) => (out[n.id] = n.pos || [0, 0, 0]))
  return out
}

export const LAYOUTS = { manual, flow, layered, stack, grid, radial }

/** Has every node been given an explicit position? Then default to manual. */
function allPositioned(scene) {
  return scene.nodes.length > 0 && scene.nodes.every((n) => Array.isArray(n.pos))
}

/**
 * Resolve positions for a scene. Explicit `node.pos` always wins; otherwise the scene's `layout`
 * (or an inferred default) computes them. Returns id → [x,y,z].
 */
export function applyLayout(scene) {
  const spec =
    scene.layout || (allPositioned(scene) ? { type: 'manual' } : { type: 'flow', axis: 'y' })
  const fn = LAYOUTS[spec.type] || LAYOUTS.flow
  const computed = fn(scene, spec)
  // explicit pos overrides computed
  const out = {}
  for (const n of scene.nodes)
    out[n.id] = Array.isArray(n.pos) ? n.pos : computed[n.id] || [0, 0, 0]
  return out
}
