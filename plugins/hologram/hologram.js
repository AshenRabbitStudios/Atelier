// hologram.js — the framework-free 3D engine, ported from the Neural Hologram prototype. Owns the
// Three.js scene, picking, and the drill-down camera tween. It knows nothing about the agent or HUD:
// scenes come in through `loadScene` (raw ArchScenes, normalized here via scene.js) — the one door for
// both demos (Library picker) and agent-pushed architectures; glyphs come from the open registry
// (glyphs.js); selection / view / drill-request changes go out through the `on*` hooks.
//
// three + addons are bundled into hologram.bundle.js (esbuild, IIFE) so the pane loads them as a
// single classic <script> — the proven path for this sandboxed/opaque-origin iframe.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { makeGlyphCtx, buildGlyph } from './glyphs.js'
import { normalizeScene } from './scene.js'

const PALETTES = {
  'Arc Reactor': { primary: '#35d7ff', grid: '#0e3b4d' },
  'Mark L Gold': { primary: '#ffc24d', grid: '#4d3a0e' },
  'Matrix Green': { primary: '#38f5a8', grid: '#0e4d33' }
}

export class Hologram {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   *   glow, autoRotate, palette — initial tweaks/state
   *   onSelect(node[]), onViewChange({view,title,subtitle,...}), onRequestExpand({path,label}),
   *   onEdge(meta), onReady()
   * Scenes are DATA: every scene — demo or real — enters through `loadScene` (the one door),
   * driven by the HUD Library picker or the agent's architecture channel. No built-in models.
   */
  constructor(container, opts) {
    this.el = container
    this.opts = opts
    this.glow = opts.glow ?? 0.9
    this.autoRotate = opts.autoRotate !== false
    this.palette = opts.palette || 'Arc Reactor'
    this.model = null // id of the loaded root scene (null until the first loadScene)
    this.view = 'overview'
    this.packets = []
    this.pickables = []
    this.selected = []
    this.tween = null
    this._lastData = null
    this._pushed = false // true once a scene is loaded and showing
    this.scenes = {} // pathKey → { scene, path, label } cache for scene recursion
    this.crumbs = [] // breadcrumb of pathKeys, root → current
    this._pending = null // a drill awaiting a scene load: { key, path, label }
    this._disposed = false
  }

  primary() {
    return (PALETTES[this.palette] || PALETTES['Arc Reactor']).primary
  }
  gridColor() {
    return (PALETTES[this.palette] || PALETTES['Arc Reactor']).grid
  }

  async init() {
    try {
      await document.fonts.ready
    } catch {
      /* fonts best-effort; labels still draw */
    }
    if (this._disposed) return
    const el = this.el
    const W = el.clientWidth || 800
    const H = el.clientHeight || 600

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x03070d, 0.013)
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 220)
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(W, H)
    renderer.setClearColor(0x000000, 0)
    el.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 6
    controls.maxDistance = 140
    controls.autoRotate = this.autoRotate
    controls.autoRotateSpeed = 0.55
    controls.enablePan = true
    controls.screenSpacePanning = true // pan moves up/down/left/right in screen space
    controls.enableRotate = false // left-drag rotation is custom (orbits the selected node off-centre)
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN
    }

    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), this.glow, 0.55, 0.0)
    composer.addPass(bloom)

    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.controls = controls
    this.composer = composer
    this.bloom = bloom
    this.modelGroup = new THREE.Group()
    scene.add(this.modelGroup)
    this.gx = makeGlyphCtx(THREE)

    // particle atmosphere
    const pc = 420
    const pp = new Float32Array(pc * 3)
    for (let i = 0; i < pc; i++) {
      const r = 18 + Math.random() * 22
      const a = Math.random() * Math.PI * 2
      const b = Math.acos(2 * Math.random() - 1)
      pp[i * 3] = r * Math.sin(b) * Math.cos(a)
      pp[i * 3 + 1] = (Math.random() * 2 - 1) * 16
      pp[i * 3 + 2] = r * Math.sin(b) * Math.sin(a)
    }
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(pp, 3))
    this.particles = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        color: this.primary(),
        size: 0.07,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      })
    )
    scene.add(this.particles)

    // floor grid
    this.grid = new THREE.GridHelper(70, 42, this.gridColor(), this.gridColor())
    this.grid.material.transparent = true
    this.grid.material.opacity = 0.5
    scene.add(this.grid)

    // Boot empty — scenes arrive through loadScene (the Library picker or the agent's architecture
    // channel). Park the camera at a sensible default; the first loadScene reframes.
    this.camera.position.set(0, 3, 30)
    this.controls.target.set(0, 0, 0)
    this.controls.update()
    this.opts.onViewChange?.({ view: 'empty', title: 'Hologram', subtitle: '' })

    // interaction: click vs drag, double-click to drill
    const dom = renderer.domElement
    let down = null
    this._onDown = (e) => {
      down = {
        x: e.clientX,
        y: e.clientY,
        lx: e.clientX,
        ly: e.clientY,
        t: Date.now(),
        button: e.button,
        dragged: false
      }
    }
    this._onMove = (e) => {
      if (!down || down.button !== 0 || this.tween) return
      const dx = e.clientX - down.lx
      const dy = e.clientY - down.ly
      down.lx = e.clientX
      down.ly = e.clientY
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) down.dragged = true
      if (down.dragged) this.rotateAroundPivot(dx, dy)
    }
    this._onUp = (e) => {
      if (!down) return
      // a left click (no drag) selects; a left drag rotated; middle/right were pan
      if (e.button === 0 && !down.dragged && Date.now() - down.t < 450) this.pick(e)
      down = null
    }
    this._onDbl = (e) => {
      if (this.tween) return
      const m = this.pickAt(e)
      if (m) this.drillInto(m.userData.node)
    }
    dom.addEventListener('pointerdown', this._onDown)
    dom.addEventListener('pointermove', this._onMove)
    dom.addEventListener('pointerup', this._onUp)
    dom.addEventListener('dblclick', this._onDbl)

    this.ro = new ResizeObserver(() => this.onResize())
    this.ro.observe(el)

    const clock = new THREE.Clock()
    this._raf = () => {
      if (this._disposed) return
      const t = clock.getElapsedTime()
      if (this.tween) {
        let p = (performance.now() - this.tween.t0) / this.tween.dur
        if (p > 1) p = 1
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
        camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e)
        controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e)
        camera.lookAt(controls.target)
        if (p >= 1) {
          const cb = this.tween.onDone
          this.tween = null
          controls.enabled = true
          if (cb) cb()
        }
      } else {
        controls.update()
      }
      if (this.particles) this.particles.rotation.y = t * 0.02
      for (const pk of this.packets) {
        const u = (t * 0.16 * pk.speed + pk.phase) % 1
        pk.m.position.copy(pk.curve.getPoint(u))
      }
      for (const m of this.selected) {
        const s = 1 + 0.05 * Math.sin(t * 4.5)
        m.scale.setScalar(s)
        m.userData.edges.material.opacity = 0.7 + 0.3 * Math.sin(t * 4.5)
      }
      composer.render()
      this.frame = requestAnimationFrame(this._raf)
    }
    this._raf()
    this.opts.onReady?.()
  }

  onResize() {
    const el = this.el
    if (!el || !this.renderer) return
    const W = el.clientWidth || 800
    const H = el.clientHeight || 600
    this.camera.aspect = W / H
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(W, H)
    this.composer.setSize(W, H)
  }

  renderScene(data, keepCam) {
    const g = this.modelGroup
    // Thorough disposal (the prototype under-disposed): geometry + material + any sprite texture.
    while (g.children.length) {
      const c = g.children.pop()
      this._disposeObject(c)
    }
    this.packets = []
    this.pickables = []
    this.edgePickables = []
    this.selected = []

    const byId = {}
    data.nodes.forEach((n) => (byId[n.id] = n))

    data.nodes.forEach((n) => {
      const [w, h, d] = n.size
      const mat = new THREE.MeshBasicMaterial({
        color: n.color,
        transparent: true,
        opacity: 0.045,
        depthWrite: false,
        side: THREE.DoubleSide
      })
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
        new THREE.LineBasicMaterial({ color: n.color, transparent: true, opacity: 0.16 })
      )
      mesh.add(edges)
      mesh.add(buildGlyph(n, this.gx)) // glyph from the open registry (abstract; not data-bound)
      mesh.position.set(n.pos[0], n.pos[1], n.pos[2])
      mesh.userData = { node: n, edges, baseColor: n.color }
      const lab = this.makeLabel(n.label, '#eafaff')
      lab.position.set(0, h / 2 + 0.66, 0)
      mesh.add(lab)
      g.add(mesh)
      this.pickables.push(mesh)
    })

    data.edges.forEach((e) => {
      if (!byId[e.a] || !byId[e.b]) return // tolerate dangling edges from agent-authored scenes
      const aNode = byId[e.a]
      const bNode = byId[e.b]
      const recur = e.recur || e.kind === 'recurrent'
      const residual = e.residual || e.kind === 'residual' || e.kind === 'skip'
      const col = e.style?.color || (recur ? '#36f0e0' : this.primary())
      const meta = { edge: e, aLabel: aNode.label, bLabel: bNode.label }

      // Auto-routed orthogonal polyline: anchors on the node faces and turns (right angles) around
      // any intermediate node it would otherwise pass through. The scene carries no coordinates —
      // positions are layout-derived, so routing is computed here from the resolved boxes.
      const pts = this._routeOrthogonal(aNode, bNode, data.nodes, residual)
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: col,
          transparent: true,
          opacity: residual ? 0.16 : recur ? 0.5 : 0.32
        })
      )
      line.userData = meta
      g.add(line)
      this.edgePickables.push(line)

      if (residual || e.style?.packet === false) return // residual/skip + opt-out flows carry no packet
      const path = new THREE.CurvePath()
      for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]))
      const pm = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 8, 8),
        new THREE.MeshBasicMaterial({ color: col })
      )
      g.add(pm)
      this.packets.push({
        curve: path,
        m: pm,
        phase: Math.random(),
        speed: e.speed || e.style?.speed || 1
      })
    })

    ;(data.floats || []).forEach((f) => {
      const lab = this.makeLabel(f.t, '#5fa6bf', 0.7)
      lab.position.set(f.pos[0], f.pos[1], f.pos[2])
      g.add(lab)
    })

    if (keepCam) {
      if (this.grid) this.grid.position.y = data.grid
    } else {
      this.frameCamera(data)
    }
  }

  // Compute an axis-aligned (orthogonal) route from node A to node B that leaves/enters on the
  // node faces and detours around any *other* node it would pass through. Returns Vector3[] (the
  // polyline corners). Pure geometry over resolved positions — no scene coordinates involved.
  _routeOrthogonal(aNode, bNode, nodes, residual) {
    const V = THREE.Vector3
    const ac = aNode.pos
    const bc = bNode.pos
    const ah = aNode.size.map((s) => s / 2)
    const bh = bNode.size.map((s) => s / 2)
    const d = [bc[0] - ac[0], bc[1] - ac[1], bc[2] - ac[2]]
    // dominant travel axis = where A and B differ most; route runs mainly along it
    let m = 0
    for (let k = 1; k < 3; k++) if (Math.abs(d[k]) > Math.abs(d[m])) m = k
    const [p, q] = [
      [1, 2],
      [0, 2],
      [0, 1]
    ][m]
    const sgn = d[m] >= 0 ? 1 : -1
    const stub = 0.9 // straight bit off each face before any turn
    const margin = 0.9 // clearance kept around every obstacle box

    const aFace = ac.slice()
    aFace[m] = ac[m] + sgn * ah[m]
    const bFace = bc.slice()
    bFace[m] = bc[m] - sgn * bh[m]
    const aOutM = ac[m] + sgn * (ah[m] + stub)
    const bInM = bc[m] - sgn * (bh[m] + stub)

    // obstacle boxes (every node except the two endpoints), inflated by the clearance margin
    const obstacles = nodes
      .filter((n) => n !== aNode && n !== bNode)
      .map((n) => ({
        lo: [
          n.pos[0] - n.size[0] / 2 - margin,
          n.pos[1] - n.size[1] / 2 - margin,
          n.pos[2] - n.size[2] / 2 - margin
        ],
        hi: [
          n.pos[0] + n.size[0] / 2 + margin,
          n.pos[1] + n.size[1] / 2 + margin,
          n.pos[2] + n.size[2] / 2 + margin
        ]
      }))
    // does an axis-aligned segment s→e overlap any obstacle box?
    const segHits = (s, e) => {
      const lo = [Math.min(s[0], e[0]), Math.min(s[1], e[1]), Math.min(s[2], e[2])]
      const hi = [Math.max(s[0], e[0]), Math.max(s[1], e[1]), Math.max(s[2], e[2])]
      return obstacles.some(
        (o) =>
          lo[0] <= o.hi[0] &&
          hi[0] >= o.lo[0] &&
          lo[1] <= o.hi[1] &&
          hi[1] >= o.lo[1] &&
          lo[2] <= o.hi[2] &&
          hi[2] >= o.lo[2]
      )
    }
    // build the orthogonal corner list for a lateral lane (lp on axis p, lq on axis q)
    const build = (lp, lq) => {
      const pts = []
      const cur = aFace.slice()
      const push = () => pts.push(new V(cur[0], cur[1], cur[2]))
      push()
      cur[m] = aOutM
      push()
      if (cur[p] !== lp) {
        cur[p] = lp
        push()
      }
      if (cur[q] !== lq) {
        cur[q] = lq
        push()
      }
      cur[m] = bInM
      push()
      if (cur[p] !== bFace[p]) {
        cur[p] = bFace[p]
        push()
      }
      if (cur[q] !== bFace[q]) {
        cur[q] = bFace[q]
        push()
      }
      cur[m] = bFace[m]
      push()
      return pts
    }
    const clear = (pts) => {
      for (let i = 0; i < pts.length - 1; i++)
        if (segHits([pts[i].x, pts[i].y, pts[i].z], [pts[i + 1].x, pts[i + 1].y, pts[i + 1].z]))
          return false
      return true
    }
    // candidate lanes: straight columns first (skipped for residual so a skip-edge always bows
    // clear of the spine), then widening lateral offsets on p, then on q.
    const cands = []
    if (!residual) {
      cands.push([bc[p], bc[q]])
      cands.push([ac[p], ac[q]])
    }
    const offs = residual
      ? [3.2, 4.6, 6.0, -3.2, -4.6, -6.0]
      : [3.0, 4.4, 5.8, 7.2, -3.0, -4.4, -5.8, -7.2]
    const baseP = (ac[p] + bc[p]) / 2
    const baseQ = (ac[q] + bc[q]) / 2
    for (const o of offs) cands.push([baseP + o, bc[q]])
    for (const o of offs) cands.push([bc[p], baseQ + o])
    for (const [lp, lq] of cands) {
      const pts = build(lp, lq)
      if (clear(pts)) return pts
    }
    // nothing clean found: fall back to the straight face-to-face segment (never worse than before)
    return [new V(aFace[0], aFace[1], aFace[2]), new V(bFace[0], bFace[1], bFace[2])]
  }

  frameCamera(data) {
    if (!this.camera) return
    this.camera.position.set(data.cam[0], data.cam[1], data.cam[2])
    this.controls.target.set(data.target[0], data.target[1], data.target[2])
    this.controls.update()
    if (this.grid) this.grid.position.y = data.grid
  }

  makeLabel(text, color, scale) {
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 128
    const ctx = c.getContext('2d')
    ctx.font = '600 56px Rajdhani, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = color
    ctx.shadowBlur = 2.8 // label glow only — dialed to ~20%; node/edge glow + bloom untouched
    ctx.fillStyle = color
    ctx.fillText(text, 256, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
    )
    const wScale = (scale || 1) * Math.min(6.4, Math.max(2.4, text.length * 0.26 + 1))
    sp.scale.set(wScale, wScale * 0.25, 1)
    return sp
  }

  // ---------- picking (single-click = inspect) ----------
  pickAt(e) {
    const dom = this.renderer.domElement
    const r = dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    )
    const rc = new THREE.Raycaster()
    rc.setFromCamera(ndc, this.camera)
    const hits = rc.intersectObjects(this.pickables, false)
    return hits.length ? hits[0].object : null
  }
  pick(e) {
    if (this.tween) return
    const m = this.pickAt(e)
    if (m) {
      this.selectMesh(m, e.shiftKey)
      return
    }
    const ed = this.pickEdge(e)
    if (ed) {
      this.selectEdge(ed)
      return
    }
    if (!e.shiftKey) this.deselect()
  }
  // Raycast the edge lines (with a small screen-space threshold) so the data flowing on an edge is
  // inspectable. Nodes take priority; edges are only tested when no node is hit.
  pickEdge(ev) {
    if (!this.edgePickables || !this.edgePickables.length) return null
    const dom = this.renderer.domElement
    const r = dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    )
    const rc = new THREE.Raycaster()
    rc.setFromCamera(ndc, this.camera)
    rc.params.Line.threshold = 0.45
    const hits = rc.intersectObjects(this.edgePickables, false)
    return hits.length ? hits[0].object : null
  }
  selectEdge(line) {
    this.deselect()
    this.opts.onEdge?.(line.userData)
  }
  // click = replace the selection; shift-click = add/toggle. onSelect receives the full node array.
  selectMesh(mesh, additive) {
    const i = this.selected.indexOf(mesh)
    if (additive) {
      if (i >= 0) {
        this.restore(mesh)
        this.selected.splice(i, 1)
      } else {
        this.highlight(mesh)
        this.selected.push(mesh)
      }
    } else if (!(this.selected.length === 1 && i === 0)) {
      this.selected.forEach((m) => this.restore(m))
      this.selected = [mesh]
      this.highlight(mesh)
    }
    this.opts.onSelect?.(this.selected.map((m) => m.userData.node))
  }
  highlight(mesh) {
    mesh.userData.edges.material.color.set('#ffffff')
    mesh.material.opacity = 0.12
  }
  restore(mesh) {
    mesh.userData.edges.material.color.set(mesh.userData.baseColor)
    mesh.userData.edges.material.opacity = 0.16
    mesh.material.opacity = 0.045
    mesh.scale.setScalar(1)
  }
  deselect() {
    if (this.selected.length) {
      this.selected.forEach((m) => this.restore(m))
      this.selected = []
      this.opts.onSelect?.([])
    }
  }

  // ---------- public commands (HUD / agent drive these) ----------
  // Load a scene — the ONE door. Same path for a demo from the Library picker and a scene from the
  // agent's `architecture` channel. Scenes are cached by their `path` so drill/Back navigate locally;
  // loading a child fulfils a pending drill request.
  loadScene(raw) {
    const path = Array.isArray(raw.path) && raw.path.length ? raw.path : [raw.id || 'architecture']
    const key = path.join('/')
    const d = normalizeScene(raw)
    this.scenes[key] = { scene: d, path, label: d.title || path[path.length - 1] }
    this._lastData = d
    this._pushed = true
    this.deselect()
    if (this._pending && this._pending.key === key) {
      // fulfils a pending drill request → descend into it
      this._pending = null
      this.crumbs.push(key)
      this._displayPushed(d, 'drill')
    } else if (this.crumbs.length && this.crumbs[this.crumbs.length - 1] === key) {
      // a re-push of the level on screen (e.g. the agent enriched a node) → keep the camera
      this.model = raw.id || path[path.length - 1]
      this.renderScene(d, true)
      this._emitView()
    } else {
      // a fresh root / jump → reset the breadcrumb and reframe
      this.model = raw.id || path[path.length - 1]
      this.crumbs = [key]
      this._displayPushed(d, 'reframe')
    }
  }
  _displayPushed(d, mode) {
    this.view = this.crumbs.length > 1 ? 'detail' : 'overview'
    if (mode === 'reframe') {
      this.renderScene(d, false)
      this._emitView()
    } else {
      this.renderScene(d, true)
      this._emitView()
      this.flyTo(
        new THREE.Vector3(d.cam[0], d.cam[1], d.cam[2]),
        new THREE.Vector3(d.target[0], d.target[1], d.target[2]),
        mode === 'drill' ? 720 : 640,
        () => {
          this.controls.autoRotate = this.autoRotate
        }
      )
    }
  }
  _emitView(extra) {
    const cur = this.scenes[this.crumbs[this.crumbs.length - 1]]
    this.opts.onViewChange?.({
      view: this.crumbs.length > 1 ? 'detail' : 'overview',
      title: cur?.scene.title || cur?.label || 'Architecture',
      subtitle: cur?.scene.subtitle || '',
      crumbs: this.crumbs.map((k) => this.scenes[k]?.label || k),
      canBack: this.crumbs.length > 1,
      ...(extra || {})
    })
  }
  // The current level's addressable nodes — the pane publishes this on the `selection` channel so the
  // agent always knows what scene is loaded and which node ids/paths are valid targets (no guessing).
  currentIndex() {
    const nodes = (this.pickables || [])
      .filter((m) => m.userData && m.userData.node)
      .map((m) => {
        const n = m.userData.node
        return {
          id: n.id,
          label: n.label,
          kind: n.type || n.kind || '',
          expandable: !!(n.expandable || (Array.isArray(n.childrenPath) && n.childrenPath.length))
        }
      })
    return {
      model: this.model,
      view: this.view,
      path: this.crumbs.slice(),
      crumbs: this.crumbs.map((k) => this.scenes[k]?.label || k),
      nodes
    }
  }
  // Agent → pane control: highlight a node and (for 'focus') fly the camera to frame it. The target may
  // be given as a fully-qualified path array (`target:['scene','child','nodeId']` — last segment is the
  // node, the rest is the cached scene path) or the legacy `{path, nodeId}` pair. `action:'select'`
  // highlights without moving the camera; 'focus' (default) also flies in. Returns false when it can't
  // yet (mid-tween, or the level isn't loaded) so the pane can retry on its next poll — e.g. right
  // after the agent pushes a scene.
  focusNode(cmd) {
    if (!cmd) return true
    let nodeId = cmd.nodeId
    let path = cmd.path
    if (Array.isArray(cmd.target) && cmd.target.length) {
      const t = cmd.target.filter((s) => s != null && s !== '')
      nodeId = t[t.length - 1]
      path = t.slice(0, -1)
    }
    if (!nodeId) return true
    if (this.tween) return false
    if (this._pushed && Array.isArray(path) && path.length) {
      const key = path.join('/')
      const cur = this.crumbs[this.crumbs.length - 1]
      if (key !== cur) {
        if (!this.scenes[key]) return false // level not pushed yet — retry next tick
        const idx = this.crumbs.indexOf(key)
        this.crumbs = idx >= 0 ? this.crumbs.slice(0, idx + 1) : [key]
        this.renderScene(this.scenes[key].scene, true)
        this._emitView()
      }
    }
    const mesh = this.pickables.find((m) => m.userData.node && m.userData.node.id === nodeId)
    if (!mesh) return false
    this.selected.forEach((m) => this.restore(m))
    this.selected = [mesh]
    this.highlight(mesh)
    this.opts.onSelect?.([mesh.userData.node])
    if (cmd.action === 'select') return true // highlight + inspector only, no camera move
    const np = mesh.position.clone()
    const dir = this.camera.position.clone().sub(np)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    dir.normalize()
    const s = mesh.userData.node.size || [3, 3, 3]
    const dist = Math.max(s[0], s[1], s[2]) * 2.2 + 6
    this.flyTo(np.clone().add(dir.multiplyScalar(dist)), np, 700, () => {
      this.controls.autoRotate = this.autoRotate
    })
    return true
  }
  setGlow(n) {
    this.glow = n
    if (this.bloom) this.bloom.strength = n
  }
  setAutoRotate(b) {
    this.autoRotate = b
    if (this.controls) this.controls.autoRotate = b
  }
  setPalette(name) {
    this.palette = name
    if (this.grid) this.grid.material.color.set(this.gridColor())
    if (this.particles) this.particles.material.color.set(this.primary())
    if (this._pushed) {
      const cur = this.scenes[this.crumbs[this.crumbs.length - 1]]
      if (cur) this.renderScene(cur.scene, true)
    }
  }

  // ---------- camera: orbit around the selected node, off-centre ----------
  // Left-drag tumbles the view around the last-selected node's centre (or the current look-point when
  // nothing is selected) WITHOUT re-aiming — so a panned, off-centre architecture stays exactly where
  // you put it and you orbit the thing you picked. OrbitControls' own rotate is disabled; we keep its
  // target on the camera's look-axis each frame so pan / zoom / damping keep working and never fight.
  rotateAroundPivot(dx, dy) {
    const T = THREE
    const cam = this.camera
    const sel = this.selected[this.selected.length - 1]
    const p = sel ? sel.userData.node.pos : null
    const O = p ? new T.Vector3(p[0], p[1], p[2]) : this.controls.target.clone()
    const speed = 0.005
    const offset = cam.position.clone().sub(O)
    const qy = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), -dx * speed)
    const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
    right.y = 0
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
    else right.normalize()
    const qp = new T.Quaternion().setFromAxisAngle(right, -dy * speed)
    const q = qy.clone().multiply(qp)
    let newOffset = offset.clone().applyQuaternion(q)
    const ang = newOffset
      .clone()
      .normalize()
      .angleTo(new T.Vector3(0, 1, 0))
    if (ang < 0.12 || ang > Math.PI - 0.12) {
      // near a pole → keep yaw only, drop the pitch (prevents flipping over the top)
      newOffset = offset.clone().applyQuaternion(qy)
      cam.quaternion.premultiply(qy)
    } else {
      cam.quaternion.premultiply(q)
    }
    cam.position.copy(O).add(newOffset)
    const dist = cam.position.distanceTo(this.controls.target)
    const fwd = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
    this.controls.target.copy(cam.position).add(fwd.multiplyScalar(dist))
  }

  // ---------- drill-down navigation ----------
  flyTo(toPos, toTarget, dur, onDone) {
    this.controls.enabled = false
    this.controls.autoRotate = false
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: toTarget.clone(),
      t0: performance.now(),
      dur,
      onDone
    }
  }
  drillInto(node) {
    if (this.tween || !this._pushed) return
    this._drillPushed(node)
  }
  goBack() {
    if (this.tween) return
    this._backPushed()
  }

  // ---------- scene recursion (drill by path, cached, lazy) ----------
  _drillPushed(node) {
    if (!node.expandable && !(Array.isArray(node.childrenPath) && node.childrenPath.length)) return
    this.deselect()
    const curPath = this.scenes[this.crumbs[this.crumbs.length - 1]]?.path || []
    const childPath =
      Array.isArray(node.childrenPath) && node.childrenPath.length
        ? node.childrenPath
        : [...curPath, node.id]
    const key = childPath.join('/')
    if (this.scenes[key]) {
      this.crumbs.push(key)
      this._displayPushed(this.scenes[key].scene, 'drill')
      return
    }
    // not authored yet → ask the agent to push it; show a pending hint
    this._pending = { key, path: childPath, label: node.label }
    this.opts.onRequestExpand?.({ path: childPath, label: node.label })
    this._emitView({ requesting: node.label })
  }
  _backPushed() {
    this.deselect()
    this._pending = null
    if (this.crumbs.length <= 1) return
    this.crumbs.pop()
    this._displayPushed(this.scenes[this.crumbs[this.crumbs.length - 1]].scene, 'back')
  }

  // ---------- disposal ----------
  _disposeObject(obj) {
    obj.traverse?.((c) => {
      if (c.geometry) c.geometry.dispose?.()
      const m = c.material
      if (m) {
        if (Array.isArray(m))
          m.forEach((mm) => {
            mm.map?.dispose?.()
            mm.dispose?.()
          })
        else {
          m.map?.dispose?.()
          m.dispose?.()
        }
      }
    })
  }
  dispose() {
    this._disposed = true
    cancelAnimationFrame(this.frame)
    this.ro?.disconnect()
    const dom = this.renderer?.domElement
    if (dom) {
      dom.removeEventListener('pointerdown', this._onDown)
      dom.removeEventListener('pointermove', this._onMove)
      dom.removeEventListener('pointerup', this._onUp)
      dom.removeEventListener('dblclick', this._onDbl)
    }
    if (this.modelGroup)
      while (this.modelGroup.children.length) this._disposeObject(this.modelGroup.children.pop())
    this.particles?.geometry?.dispose?.()
    this.particles?.material?.dispose?.()
    this.grid?.geometry?.dispose?.()
    this.grid?.material?.dispose?.()
    this.composer?.dispose?.()
    this.renderer?.dispose?.()
    if (dom && dom.parentNode) dom.parentNode.removeChild(dom)
  }
}
