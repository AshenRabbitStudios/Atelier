// entry.js — esbuild bundle entry. Pulls the engine + demo data (and, transitively, three + its
// addons) into one classic IIFE script (hologram.bundle.js) and hangs the public surface off
// window, so index.html can drive it from a plain inline <script> with no module loading.
// Rebuild with: npm run build:hologram  (see package.json / build.mjs).
import { Hologram } from './hologram.js'
import { getModel, getDetail } from './architectures.js'

window.Hologram = Hologram
window.HoloArch = { getModel, getDetail }
