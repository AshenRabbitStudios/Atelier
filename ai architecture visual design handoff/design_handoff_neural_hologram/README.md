# Neural Hologram — Electron App Handoff

> A holographic, Iron-Man-style 3D viewer for neural-network architectures.
> Orbit a glowing model, click parts to read what they do, and **double‑click any
> component to fly in and explore its internals.**

This package is the complete build brief for turning the existing prototype into a
production **Electron desktop application**. It is written to be implemented by
Claude Code (or any developer) **without having seen the original conversation.**

---

## 0. Read this first — what the bundled file actually is

The reference file `reference/Neural Hologram.dc.html` is a **working prototype**,
not throwaway pixels. It is a single self-contained page built on **Three.js +
WebGL** with a DOM/HTML "HUD" overlay. Roughly **80% of its code is directly
portable** to the Electron app — the Three.js scene graph, the data model, the
glyph geometry builders, the drill‑down navigation, and the camera animation are
all framework-agnostic logic that should be **lifted almost verbatim** into the
new codebase.

The one part that is framework-specific is the thin wrapper class
(`class Component extends DCLogic`) and the HTML template. That wrapper is an
artifact of the prototyping environment ("Design Components"). In Electron you
will **replace the wrapper**, not the engine: pull the Three.js logic into a plain
ES module and rebuild the HUD with your UI framework of choice (React recommended).

> **Fidelity: HIGH.** Colors, fonts, sizing, easing, and interaction model are
> final and intentional. Reproduce them exactly. The accompanying docs give every
> hex value, font, and timing.

This is **not** a "recreate a mockup in our design system" task. There is no
pre‑existing host app — you are choosing the stack and standing up a new Electron
project, with the prototype's engine as the core.

---

## 1. The premise

Modern neural-network diagrams are flat, static, and dead. This app makes an
architecture feel like a **physical hologram you can walk around**:

- **Spatial.** The model is a 3D structure floating in a dark "lab." You orbit,
  zoom, and tumble it. Depth and parallax do the explaining that a flat PDF can't.
- **Self-describing.** Every component is a distinct glyph built from primitives —
  attention is a stack of fanned grid‑planes, feed‑forward is an expanding MLP
  graph, embedding is a heat‑map matrix, softmax is a probability bar chart. You
  can recognize a part by its shape before you read a word.
- **Drill-down.** Double‑click a component and the camera **flies into it**; the
  scene dissolves and rebuilds as that part's *internals* (e.g. attention unfolds
  into Q/K/V → QKᵀ → softmax → A·V → Wₒ). A **Back** control flies you out.
- **Inspectable.** Single‑click any node (top level or inside a drill‑down) and a
  HUD "Inspector" panel shows its name, role, a plain‑English description, and key
  specs.
- **Themeable.** A small tweak surface controls bloom intensity, auto‑rotation, and
  a color palette (Arc Reactor cyan / Mark L gold / Matrix green).

Two architectures ship today — a **Transformer encoder** and an **unrolled RNN** —
selectable from the HUD. The data model is generic, so more architectures are just
more data.

### Who it's for
ML educators, students, researchers explaining systems, conference demos, and
anyone who wants a "wow" way to present a model. The desktop form factor exists so
it can run **offline at a booth/lecture**, **load/save custom architectures from
disk**, and **export high‑resolution stills/video** for slides and papers.

---

## 2. Why Electron (what desktop unlocks)

The prototype is already a web page; Electron is justified by capabilities a tab
can't do cleanly:

| Capability | Why it needs desktop |
|---|---|
| **Open/Save architecture files** | Native file dialogs + filesystem; users author `.nnviz.json` models and keep a library of them. |
| **Offline-first** | Bundle Three.js + fonts locally (no CDN/importmap). Runs at a venue with no Wi‑Fi. |
| **High-res / video export** | Render the WebGL canvas to a 4K PNG or capture an MP4/WebM orbit without browser download friction. |
| **Native menus & shortcuts** | File ▸ Open/Save/Export, View ▸ palette/glow, Help. Cmd/Ctrl accelerators. |
| **Multi-window** | Compare two architectures side by side. |
| **Distribution** | Signed `.dmg` / `.exe` / `.AppImage` installers; optional auto-update. |

If the team later wants web + desktop from one codebase, the recommended structure
(engine module + framework HUD) supports shipping the same renderer to a plain web
build too.

---

## 3. Recommended stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest LTS, ≥ v30) | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. |
| Bundler/dev | **electron-vite** (Vite under the hood) | Fast HMR for the renderer; clean main/preload/renderer split. (Electron Forge + Vite plugin is an acceptable alternative.) |
| UI / HUD | **React + TypeScript** | The HUD is ~6 panels of declarative state. React maps cleanly onto the prototype's `renderVals()` returns. Vanilla TS is fine too if you want zero deps. |
| 3D | **three** (npm, pin a version, prototype used `0.160.0`) | Import from npm, **not** the CDN importmap. Use `three/examples/jsm/...` addons. |
| Packaging | **electron-builder** | mac/win/linux targets, signing, optional auto-update via `electron-updater`. |
| State | Local React state / a tiny store (Zustand) | App state is small: current model, selected node, view (overview/detail), tweaks. |

> Keep the **engine** (Three.js scene, data, glyphs, navigation) in a
> **framework-free** `src/engine/` module that exposes an imperative API. The HUD
> (React) only sends commands in and receives events out. This is the single most
> important architectural decision — it keeps the valuable code portable and
> testable, and prevents React re-renders from touching the render loop.

---

## 4. Target project structure

```
neural-hologram/
├─ package.json
├─ electron.vite.config.ts        # electron-vite config (main/preload/renderer)
├─ electron-builder.yml           # packaging targets, signing, icons
├─ resources/                     # app icons, installer art
├─ src/
│  ├─ main/                       # Electron MAIN process (Node)
│  │  ├─ index.ts                 # createWindow, app lifecycle
│  │  ├─ menu.ts                  # native application menu + accelerators
│  │  └─ ipc.ts                   # open/save/export handlers (dialog + fs)
│  ├─ preload/
│  │  └─ index.ts                 # contextBridge: window.api = {openModel, saveModel, exportPng, ...}
│  └─ renderer/                   # the app (browser context)
│     ├─ index.html
│     ├─ main.tsx                 # React mount + engine bootstrap
│     ├─ engine/                  # ★ framework-free 3D core (ported from prototype)
│     │  ├─ Hologram.ts           # class: scene, camera, renderer, bloom, loop, dispose
│     │  ├─ scene.ts              # renderScene(data, keepCam) — build nodes/edges/labels
│     │  ├─ glyphs.ts             # buildGlyph(node) + gCube/gLine/gEdge/gMat helpers
│     │  ├─ navigation.ts         # flyTo tween, drillInto, goBack, picking
│     │  ├─ labels.ts             # canvas-texture sprite labels
│     │  └─ palette.ts            # palette → primary/grid colors
│     ├─ data/                    # ★ architecture definitions (pure data)
│     │  ├─ transformer.ts        # getModel('transformer')
│     │  ├─ rnn.ts                # getModel('rnn')
│     │  ├─ details.ts            # getDetail(node) internals graphs
│     │  └─ schema.ts             # TS types for Node/Edge/SceneData
│     ├─ hud/                     # React HUD (ported from the HTML template)
│     │  ├─ Hud.tsx               # title, model switch / back button
│     │  ├─ Inspector.tsx         # selected-node panel
│     │  ├─ Tweaks.tsx            # glow / auto-rotate / palette controls
│     │  └─ chrome.tsx            # corner brackets, scanlines, hints, loader
│     ├─ assets/fonts/            # self-hosted Rajdhani + IBM Plex Mono (woff2)
│     └─ styles/                  # font-face + resets (the only global CSS)
└─ test/                          # engine unit tests (data integrity, glyph builds)
```

`ARCHITECTURE.md`, `DATA_MODEL.md`, and `ELECTRON_BUILD.md` in this folder document
each of these in depth.

---

## 5. Documents in this package

| File | What it covers |
|---|---|
| **README.md** (this) | Premise, why Electron, stack, project layout, port plan, roadmap. |
| **ARCHITECTURE.md** | Deep dive on the *current* prototype: scene graph, render pipeline, glyph system, drill‑down navigation, camera tween, HUD, tweaks, lifecycle — and exactly how each maps to the Electron structure. |
| **DATA_MODEL.md** | The Node/Edge/Scene schemas, the full **component catalog** (every node, its glyph, color, copy, and specs for both architectures and all drill‑down internals), and the JSON file format for user-authored models. |
| **ELECTRON_BUILD.md** | Process model, security config, preload/IPC API surface, native menu, file open/save, image/video export, offline asset bundling, `electron-vite` + `electron-builder` configs, signing, and a step‑by‑step bring‑up checklist. |
| **reference/Neural Hologram.dc.html** | The working prototype. Open it in a browser to see the target behavior. Its `<script type="text/x-dc">` block is the logic; the markup above it is the HUD template. |

---

## 6. Port plan (recommended order)

1. **Scaffold** `electron-vite` React+TS app; get a blank secure window rendering.
   (ELECTRON_BUILD.md §1–3.)
2. **Vendor assets**: install `three`; copy Rajdhani + IBM Plex Mono woff2 into
   `assets/fonts/` and wire `@font-face`. Remove all CDN/importmap usage.
3. **Port the engine** (`src/engine/`): move `componentDidMount`'s Three setup into
   `Hologram.ts`; move `renderScene`, `buildGlyph`+helpers, `makeLabel`,
   `frameCamera`, `flyTo`/`drillInto`/`goBack`/`pick`, and the rAF loop. Replace
   `this.setState(...)` calls with **event emits** (e.g. `engine.on('select', node)`,
   `engine.on('viewchange', {view, title, subtitle})`). Expose an imperative API:
   `setModel(key)`, `setPalette(name)`, `setGlow(n)`, `setAutoRotate(bool)`,
   `drillInto(nodeId)`, `back()`, `dispose()`.
4. **Port the data** (`src/data/`): copy `getModel` and `getDetail` verbatim into
   typed modules. (DATA_MODEL.md has the schemas and full content.)
5. **Rebuild the HUD** (`src/hud/`) in React from the HTML template — same inline
   styles, same copy, same layout. It subscribes to engine events for the title,
   inspector content, and view state, and calls engine methods on click.
6. **Wire tweaks** to engine setters (and persist to disk/localStorage).
7. **Add desktop features**: native menu, Open/Save `.nnviz.json`, PNG export.
8. **Package** with electron-builder; smoke-test installers on each OS.

Each step is independently runnable. Do not try to keep the `DCLogic` wrapper — it
will fight React and the build system.

---

## 7. Non-negotiable fidelity notes

- **Inline-style HUD, dark bloom scene.** The look depends on UnrealBloom over a
  near‑black background (`#03070d`). Don't drop post-processing.
- **Two fonts only:** Rajdhani (display/labels) + IBM Plex Mono (body/HUD). No
  substitutes.
- **Glyphs are built from primitives** (boxes, lines, torus, planes) — never SVG,
  never imported meshes. Keep it that way; it's the aesthetic.
- **Drill-down is the headline feature.** The fly‑in tween (≈620 ms in, ≈720 ms to
  reframe, `easeInOutCubic`), the scene swap, and the Back fly‑out must feel smooth.
- **Selection vs. drill:** single‑click = inspect (raycast pick), double‑click =
  drill in. A click is only a click if pointer moved < 6 px and was held < 450 ms.

---

## 8. Roadmap / stretch (post-MVP, optional)

- **Model loader UI**: browse a library of `.nnviz.json` files; drag‑drop to open.
- **Authoring**: a side editor to add nodes/edges and see them live (the data model
  already supports it).
- **More architectures**: CNN, U‑Net, diffusion UNet, Mixture‑of‑Experts, full
  encoder‑decoder Transformer with cross‑attention (the decoder is a natural next
  add — see DATA_MODEL.md notes).
- **Animated forward pass**: pulse activations along edges to show inference flow
  (the packet system is already the basis for this).
- **Video export**: scripted orbit → WebM/MP4 for slides.
- **Annotations**: pin notes in 3D space; export an annotated still.

---

## 9. Quick reference — design tokens

| Token | Value |
|---|---|
| Background (scene + body) | `#03070d` (fog `FogExp2(0x03070d, 0.013)`) |
| Primary (Arc Reactor) | `#35d7ff` · grid `#0e3b4d` |
| Primary (Mark L Gold) | `#ffc24d` · grid `#4d3a0e` |
| Primary (Matrix Green) | `#38f5a8` · grid `#0e4d33` |
| Accent — attention/teal | `#36f0e0` |
| Accent — feed-forward/gold | `#ffce7a` |
| Accent — output/rose | `#ff8fb0` |
| Accent — white-cyan | `#bfefff` |
| HUD text | `#cfeefc` / dim `#7fb8cf` / label `#5aa9c4` |
| Display font | **Rajdhani** 400/500/600/700 |
| Mono/body font | **IBM Plex Mono** 400/500 |
| Bloom | `UnrealBloomPass(strength≈0.9, radius≈0.55, threshold≈0)` |
| Camera | `PerspectiveCamera(fov 45, near 0.1, far 220)` |
| Fly tween easing | `easeInOutCubic`, in ≈620 ms, reframe ≈720 ms |

Full per-component values are in **DATA_MODEL.md**.
