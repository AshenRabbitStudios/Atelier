# ARCHITECTURE.md — How the prototype works (and how it maps to Electron)

This is a precise walkthrough of the reference prototype
(`reference/Neural Hologram.dc.html`). It exists so you can lift the engine into
`src/engine/` and `src/data/` with confidence. Every subsystem below ends with a
**→ Electron** note saying where it lands.

The prototype is one file with two parts:

1. **HUD template** — HTML markup with inline styles and `{{ }}` value holes. This
   is the on-screen overlay (title, buttons, inspector, hints, frame). → becomes
   `src/hud/*` React.
2. **Logic class** — `class Component extends DCLogic { ... }` inside a
   `<script type="text/x-dc">`. This owns the entire Three.js scene and all
   interaction. → becomes `src/engine/*` + `src/data/*`.

`renderVals()` in the logic class returns a flat object of values/handlers that the
template binds to. In React this is just props/state flowing from an engine event
bus into HUD components. Treat `renderVals()`'s return shape as the HUD's view
model.

---

## 1. Runtime bootstrap

In the prototype, `async componentDidMount()`:

1. Dynamically imports Three.js + addons (via an importmap in `<helmet>`):
   `three`, `OrbitControls`, `EffectComposer`, `RenderPass`, `UnrealBloomPass`.
2. `await document.fonts.ready` (so canvas text labels use the right font).
3. Builds the renderer, scene, camera, controls, composer, atmosphere, grid.
4. Calls `buildModel(state.model)` to populate the scene.
5. Registers pointer + resize listeners and starts the rAF loop.
6. `setState({ ready: true })` to dismiss the loading overlay.

**→ Electron.** This becomes `new Hologram(canvasEl, opts)` in `engine/Hologram.ts`.
Replace the dynamic `import()`/importmap with **static npm imports**:

```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
```

Fonts are self-hosted (see ELECTRON_BUILD.md §7); still `await document.fonts.ready`
before building labels.

---

## 2. The scene graph

Created once and reused for the app's lifetime:

| Object | Construction | Purpose |
|---|---|---|
| `scene` | `new THREE.Scene()`; `scene.fog = new THREE.FogExp2(0x03070d, 0.013)` | Depth falloff into the dark. |
| `camera` | `PerspectiveCamera(45, W/H, 0.1, 220)` | Orbits via controls; animated on drill. |
| `renderer` | `WebGLRenderer({ antialias: true, alpha: true })`, `setPixelRatio(min(dpr,2))`, clear `0x000000, 0` | Transparent so the CSS radial-gradient body shows behind. |
| `controls` | `OrbitControls(camera, renderer.domElement)`, `enableDamping`, `dampingFactor 0.08`, `minDistance 8`, `maxDistance 105`, `autoRotate` (prop), `autoRotateSpeed 0.55` | Orbit/zoom + gentle idle spin. |
| `composer` | `EffectComposer` → `RenderPass` → `UnrealBloomPass(Vector2(W,H), glow, 0.55, 0.0)` | The holographic glow. **Render via `composer.render()`, not `renderer.render()`.** |
| `particles` | 420 `Points` scattered in a shell, slowly rotating | Atmosphere/parallax. |
| `grid` | `GridHelper(70, 42, gridColor, gridColor)`, opacity 0.5 | Floor; its `position.y` is set per scene. |
| `modelGroup` | `THREE.Group()` added to scene | **Holds the current architecture.** Cleared and rebuilt on every model switch / drill / back. Everything you see except particles + grid lives here. |

**→ Electron.** All of the above are fields on the `Hologram` class. Add a
`dispose()` that stops the rAF loop, disconnects the `ResizeObserver`, disposes
geometries/materials, and calls `renderer.dispose()` + removes the canvas. (The
prototype only partially disposes; do it thoroughly to avoid GPU leaks across
window reloads.)

---

## 3. Data → scene: `renderScene(data, keepCam)`

The single rendering pipeline. Both the top-level architectures and the drill-down
internals are expressed as the **same data shape** and built by the same function.

`data = { nodes, edges, floats, grid, cam, target, title?, subtitle? }`
(full schema in DATA_MODEL.md).

Steps:

1. **Clear** `modelGroup` (pop + dispose children). Reset `packets`, `pickables`,
   `selMesh`.
2. **Index** nodes by id (`byId`) for edge lookups.
3. **For each node** build a *module*:
   - faint bounding **box** mesh — `MeshBasicMaterial({ color, opacity: 0.045, depthWrite: false, side: DoubleSide })` sized to `node.size`. **This is the raycast pick target.**
   - faint **edges** — `LineSegments(EdgesGeometry(box), opacity 0.16)`. (Brightened white + pulsed when the node is selected.)
   - the **glyph** — `buildGlyph(node)` (§5), added as a child.
   - a **label** — `makeLabel(node.label)` sprite, positioned just above the box.
   - `mesh.userData = { node, edges, baseColor }`; pushed to `pickables`.
4. **For each edge** (§4) build a line + (optionally) a flowing packet.
5. **Floats**: free-standing label sprites (e.g. "ENCODER BLOCK × 6").
6. **Camera**: if `keepCam` is false, snap to `data.cam`/`data.target` and move the
   grid; if true (used during drills), only move the grid — the camera is being
   animated by a tween instead.

Two thin wrappers call it:

- `buildModel(key, keepCam)` → `renderScene(getModel(key), keepCam)`; stores
  `this._lastData = data` (used by `goBack` to reframe).
- `buildDetail(node)` → `renderScene(getDetail(node), true)`; stores
  `this._detailMeta = {title, subtitle}` and `this._detailData = data`.

**→ Electron.** `engine/scene.ts` exports `renderScene(ctx, data, keepCam)` where
`ctx` carries `THREE`, `modelGroup`, `pickables`, `packets`, `grid`, `camera`,
`controls`. `buildModel`/`buildDetail` are methods on `Hologram`.

---

## 4. Edges, residuals, and flowing "packets"

For each `edge = { a, b, residual?, recur?, speed? }`:

- **Normal edge**: a straight `Line` (opacity 0.32) from node A center to node B
  center, **plus** a small glowing sphere "packet". Each frame the packet's
  position is set along a `LineCurve3(A,B)` at parameter
  `u = (t * 0.16 * speed + phase) % 1` — this is the "data flowing through the
  network" effect. Packets are collected in `this.packets` and advanced in the loop.
- **Residual edge** (`residual: true`): a faint `QuadraticBezierCurve3` that bows
  out to the side (control point offset +3.6 in x), opacity 0.16, **no packet** —
  represents skip connections.
- **Recurrent edge** (`recur: true`): same as normal but colored teal `#36f0e0`
  (used for the RNN hidden-state hand-off across timesteps).

**→ Electron.** Pure function of node positions; ports verbatim. Keep `packets` as
an array the loop iterates.

---

## 5. The glyph system — `buildGlyph(node)`

This is the heart of the visual language. Each node's `glyph` string selects a
builder that returns a `THREE.Group` of primitives. **No SVG, no imported meshes —
everything is boxes, lines, torus, planes** so it reads as a wireframe hologram and
glows under bloom.

Helper primitives:
- `gMat(color, opacity)` → `MeshBasicMaterial` (transparent, no depth write).
- `gCube(w,h,d,color,opacity)` → boxed mesh.
- `gEdge(geometry, color, opacity)` → `LineSegments(EdgesGeometry(geometry))`.
- `gLine(points, color, opacity)` → poly-line from `[x,y,z]` tuples.

Glyph builders (each fits inside the node's `size` box, centered at local origin):

| `glyph` | What it draws | Reads as |
|---|---|---|
| `tokens` | a row of lit/unlit cubes | a token sequence |
| `embedding` | a 7×5 grid of cells, opacity = a sine pattern | an embedding/heat-map matrix |
| `wave` | 4 stacked sine poly-lines at rising frequencies | sinusoidal positional encoding |
| `attention` | up to 4 fanned grid-planes (in z), each a 4×4 cell grid brighter on the diagonal, framed | multi-head attention pattern |
| `addnorm` | a flat torus (norm) + a `⊕` cross + a flattened skip arc | residual + layer-norm |
| `ffn` | a 3→9→3 node-graph with connecting lines (fan out then in) | the 512→2048→512 MLP expansion |
| `dist` | a row of vertical bars of varied height | a softmax probability distribution |
| `cell` | a box frame + 3 inner gate cubes + a self-loop torus arc | an RNN recurrent cell |
| `vec` | a vertical stack of `rows` cells (rows configurable) | a feature vector |
| `matrix` | a `cols × rows` grid; optional `hi` highlights one row in white | a weight matrix / lookup table |
| `sum` | a torus ring + `+` cross | an add/junction |
| `curve` | an activation curve poly-line (`fn`: `tanh` / `gelu` / `bell`) with faint axes | a non-linearity / normalization |
| _default_ | a small translucent cube | fallback |

`matrix`, `sum`, and `curve` are used mostly by the **drill-down internals**; the
rest appear at the top level too.

**→ Electron.** `engine/glyphs.ts` — a `buildGlyph(THREE, node)` switch plus the
four `g*` helpers. This is the file most worth porting **character-for-character**;
the constants (counts, opacities, sizes) are tuned. Add unit tests that each glyph
returns a non-empty group for a representative node.

---

## 6. Labels — `makeLabel(text, color, scale)`

Text is drawn to a 512×128 `<canvas>` with a glow (`shadowBlur`), turned into a
`CanvasTexture`, and mounted as a `Sprite` (always faces camera, `depthTest:false`
so labels float above geometry). Sprite width scales with text length (capped).

**→ Electron.** `engine/labels.ts`. Because it rasterizes a font, **call it only
after `document.fonts.ready`**. If you later support DPI changes, regenerate at a
higher canvas resolution for crispness.

---

## 7. Interaction model

### Picking (single-click = inspect)
- `pointerdown` records position + time. `pointerup` counts as a *click* only if
  the pointer moved **< 6 px** and the press lasted **< 450 ms** (so dragging the
  orbit never selects).
- `pick(e)` → `pickAt(e)` builds NDC coords from the canvas rect, raycasts against
  `this.pickables` (the bounding boxes only — glyph children are decorative and not
  pickable), and returns the first hit mesh or null.
- Hit → `selectMesh(mesh)`: brighten its edge wireframe to white, raise box
  opacity, store `selMesh`, and surface `mesh.userData.node` to the HUD (inspector).
  Miss → `deselect()`.
- The animate loop **pulses** the selected node (scale + edge-opacity sine).

### Drilling (double-click = enter internals)
- `dblclick` (ignored while already in a detail view or mid-tween) → `pickAt` →
  `drillInto(node)`.
- `drillInto(node)`:
  1. `deselect()`.
  2. Compute a camera point just outside the node along the current view direction;
     `flyTo(closePos, nodeCenter, 620ms)`.
  3. On arrival: `buildDetail(node)` (swaps the scene to the internals graph for
     `node.glyph`), set view = `detail`, then `flyTo(detail.cam, detail.target,
     720ms)` to frame the internals. Restore auto-rotate when done.
- `goBack()`:
  1. `deselect()`, clear detail meta.
  2. `buildModel(currentModel, /*keepCam*/ true)` — rebuild the overview **without**
     snapping the camera (it's mid-space from the drill).
  3. set view = `overview`, then `flyTo(overview.cam, overview.target, 720ms)` to
     fly back out.

### Camera tween — `flyTo(toPos, toTarget, dur, onDone)`
- Disables `controls` + auto-rotate, stores `{fromPos, toPos, fromTarget, toTarget,
  t0, dur, onDone}` in `this.tween`.
- The animate loop, when a tween is active, lerps `camera.position` and
  `controls.target` with **`easeInOutCubic`**, calls `camera.lookAt(target)`, and
  on completion re-enables controls and fires `onDone`. When no tween is active it
  calls `controls.update()` as normal.

> **Gotcha that bit the prototype:** `DCLogic.setState(obj, callback)` ignores the
> callback. The fix was to call `buildModel`/`buildDetail` **imperatively right
> after** `setState`, not in a callback. In Electron this disappears — the engine
> is imperative; the HUD just reacts to emitted events. Don't reintroduce
> callback-after-setState patterns.

**→ Electron.** `engine/navigation.ts`: `pickAt`, `pick`, `selectMesh`, `restore`,
`deselect`, `drillInto`, `goBack`, `flyTo`, and the tween branch of the loop.
Replace every `this.setState(...)` with an event emit:
- select/deselect → `emit('select', node | null)`
- drill/back → `emit('viewchange', { view, title, subtitle })`
The HUD listens and updates. Keep all Three.js mutation inside the engine.

---

## 8. The render loop

Per frame (`requestAnimationFrame`):
1. If `this.tween`: advance it (lerp camera/target, `lookAt`, maybe finish).
   Else: `controls.update()`.
2. Rotate `particles` slowly.
3. Advance every packet along its edge curve.
4. If a node is selected, pulse its scale + edge opacity.
5. `composer.render()`.

**→ Electron.** Same loop in `Hologram`. **Pause it when the window is hidden**
(`document.visibilitychange` / Electron `browser-window-blur` is optional) to save
GPU. Cancel the frame in `dispose()`.

---

## 9. The HUD (overlay)

DOM layered over the canvas, all **inline styles**, `pointer-events: none` except
on interactive controls so orbit drags pass through to the canvas.

| Region | Content | Bound to |
|---|---|---|
| Top-left | Overline, **title**, subtitle | `title`/`subtitle` (model or detail meta) |
| Top-left, below | **Transformer / RNN** buttons (overview) **or** **← Back to overview** (detail) | `overview`/`inDetail`, `setModel`, `goBack` |
| Top-right | **Inspector** panel: type tag, name, description, specs list — or a "no component selected" prompt | `selected` node |
| Bottom-center | Hints: *Drag to orbit · Scroll to zoom · Click to inspect · Double-click to dive in* | static |
| Edges/overlay | Corner brackets, scanline animation, vignette | static (decorative) |
| Full-screen | Loading overlay until `ready` | `notReady` |

**→ Electron.** Each region is a small React component in `src/hud/`. The view
model is exactly the prototype's `renderVals()` return: `{ title, subtitle, inDetail,
overview, selected: { label, type, desc, specs }, notReady }` plus handlers
`{ setModel, goBack }`. Keep the inline styles verbatim for fidelity; the only
global CSS is `@font-face`, the `@keyframes` (scanline `hscan`, pulse `hpulse`,
spinner `spin`), and body resets.

---

## 10. Tweaks / props

Three configurable values, read from props in the prototype, applied live in
`componentDidUpdate`:

| Tweak | Type | Effect |
|---|---|---|
| `glow` | number 0–2 (default 0.9) | `bloom.strength` |
| `autoRotate` | boolean (default true) | `controls.autoRotate` |
| `palette` | `'Arc Reactor' \| 'Mark L Gold' \| 'Matrix Green'` | recolors primary structural nodes, grid, particles; rebuilds the current scene |

`palette` maps to `{ primary, gridColor }` and the structural glyphs use the
primary; the teal/gold/rose accents are independent of palette.

**→ Electron.** Expose `engine.setGlow(n)`, `engine.setAutoRotate(b)`,
`engine.setPalette(name)`. Build a `Tweaks.tsx` panel (sliders/toggle/segmented) and
**persist** the values (to `localStorage` or a small JSON settings file via the
preload API) so they survive restarts.

---

## 11. Resize

A `ResizeObserver` on the canvas container updates `camera.aspect`,
`renderer.setSize`, and `composer.setSize`.

**→ Electron.** Same; also handle Electron window state (full-screen toggle,
display change). Debounce if needed.

---

## 12. Known prototype caveats to clean up in the port

- **Disposal is partial.** Geometries are disposed on scene clear but materials and
  textures (label canvases, sprite materials) are not fully released. Implement
  thorough disposal in `renderScene`'s clear step and in `Hologram.dispose()`.
- **WebGL screenshot quirk.** `preserveDrawingBuffer` is not set, so generic
  DOM-snapshot capture reads stale pixels. For the **export** feature (and any
  testing), either set `preserveDrawingBuffer: true` on the renderer **or** call
  `composer.render()` immediately before `canvas.toBlob(...)` in the same tick.
  (See ELECTRON_BUILD.md §6.)
- **One benign console message** (`SCRIPT failed to load:` with an empty URL) comes
  from the prototyping runtime, not the app code. It will not exist in the Electron
  build.
- **No deep nesting of drills.** Double-click inside a detail view is intentionally
  ignored. Keep that, or design an explicit breadcrumb if you add multi-level drill.
