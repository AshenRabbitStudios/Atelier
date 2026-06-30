// scene.js — normalizeScene(raw): turn an authored ArchScene (archviz/2) OR a legacy demo scene
// (archviz/1) into the resolved shape the engine renders. Fills glyph + color from `kind`, fills a
// default size, runs the layout to assign positions, derives a 3/4 default camera + grid when absent,
// and normalizes the camera fields. Pure data; no THREE. Idempotent on already-resolved scenes.
import { defaultGlyphFor, defaultColorFor, CATEGORY_COLORS } from './glyphs.js'
import { applyLayout } from './layout.js'

const DEFAULT_SIZE = {
  tokens: [6, 1.2, 2],
  embedding: [5, 2.2, 2.4],
  wave: [3.4, 2.2, 1.8],
  attention: [4, 2.8, 2.8],
  addnorm: [3.4, 1.4, 2],
  ffn: [4, 2.4, 2.4],
  dist: [4, 2.4, 2.2],
  cell: [3.4, 2.5, 2.5],
  vec: [2.2, 3, 1.6],
  matrix: [2.8, 2.8, 1.4],
  sum: [2.4, 2.4, 1.6],
  curve: [2.6, 2.6, 1.4],
  neutral: [3.2, 1.8, 2]
}
const FALLBACK_SIZE = [3, 2.2, 2]

/** A scene "looks legacy" (archviz/1) if its nodes carry `type`/`desc` rather than `kind`. */
function isLegacy(scene) {
  return scene.nodes.some((n) => n.kind == null && (n.type != null || n.desc != null))
}

/** Map a legacy node's UPPER-CASE `type` to a best-guess kind (only for color/glyph defaults). */
function kindFromType(type) {
  const t = String(type || '').toLowerCase()
  if (t.includes('attention')) return 'attention'
  if (t.includes('feed')) return 'ffn'
  if (t.includes('norm') || t.includes('residual')) return 'norm'
  if (t.includes('embed')) return 'embedding'
  if (t.includes('position')) return 'position'
  if (t.includes('output')) return 'output'
  if (t.includes('input')) return 'input'
  if (t.includes('hidden') || t.includes('state')) return 'recurrent'
  return 'data'
}

function cloneNode(n) {
  return { ...n }
}

/** Bounding box over resolved node positions ± half-size. */
function bounds(nodes) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const n of nodes) {
    for (let k = 0; k < 3; k++) {
      const c = n.pos[k]
      const e = (n.size?.[k] ?? 2) / 2
      lo[k] = Math.min(lo[k], c - e)
      hi[k] = Math.max(hi[k], c + e)
    }
  }
  return { lo, hi }
}

/** A 3/4 view framing the whole scene (used when the scene declares no camera). Shows depth. */
function frameDefault(nodes) {
  const { lo, hi } = bounds(nodes)
  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  const dist = Math.max(diag * 1.15 + 6, 14)
  const dir = [0.45, 0.32, 1] // over-the-shoulder 3/4 angle
  const len = Math.hypot(dir[0], dir[1], dir[2])
  return {
    cam: [
      center[0] + (dir[0] / len) * dist,
      center[1] + (dir[1] / len) * dist,
      center[2] + (dir[2] / len) * dist
    ],
    target: center,
    gridY: lo[1] - 2
  }
}

export function normalizeScene(raw) {
  if (!raw || !Array.isArray(raw.nodes))
    return { nodes: [], edges: [], floats: [], grid: -6, cam: [0, 2, 24], target: [0, 0, 0] }

  const legacy = isLegacy(raw)
  const scene = {
    ...raw,
    nodes: raw.nodes.map(cloneNode),
    edges: raw.edges || [],
    floats: raw.floats || []
  }

  // fill kind → glyph/color, then size
  for (const n of scene.nodes) {
    if (legacy && n.kind == null) n.kind = kindFromType(n.type)
    if (n.summary == null && n.desc != null) n.summary = n.desc // legacy desc surfaces as summary
    n.glyph = n.glyph || defaultGlyphFor(n.kind)
    n.color = n.color || defaultColorFor(n.kind) || CATEGORY_COLORS.default
    n.size = n.size || DEFAULT_SIZE[n.glyph] || FALLBACK_SIZE
  }

  // positions: explicit pos wins; else the layout computes (3D-native)
  const pos = applyLayout(scene)
  for (const n of scene.nodes) n.pos = Array.isArray(n.pos) ? n.pos : pos[n.id] || [0, 0, 0]

  // camera + grid: prefer explicit (legacy top-level cam/target/grid, or archviz/2 camera{}), else derive
  let cam = raw.cam || raw.camera?.pos
  let target = raw.target || raw.camera?.target
  let grid = raw.grid
  if (!cam || !target || grid == null) {
    const fr = frameDefault(scene.nodes)
    cam = cam || fr.cam
    target = target || fr.target
    grid = grid == null ? fr.gridY : grid
  }
  scene.cam = cam
  scene.target = target
  scene.grid = grid
  return scene
}
