// entry.js — esbuild bundle entry. Pulls the engine (and, transitively, three + its addons) into one
// classic IIFE script (hologram.bundle.js) and hangs the public surface off window, so index.html can
// drive it from a plain inline <script> with no module loading. Scenes are DATA now (plugins/hologram
// /scenes/*.json), loaded through the one door — the Library picker or the agent's architecture channel.
// Rebuild with: npm run build:hologram  (see package.json / build.mjs).
import { Hologram } from './hologram.js'

window.Hologram = Hologram
