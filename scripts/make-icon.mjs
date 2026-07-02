// Generates resources/atelier.ico (+ atelier.png) with no external deps.
// Draws an "A" monogram in the app's accent blue on the app's dark background,
// rasterizes at 256px, box-downscales to the standard icon sizes, encodes each
// as PNG, and packs them into a single multi-resolution .ico.
//
// Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'resources')

// --- palette (from src/styles.css default theme) ---
const BG = [0x0e, 0x10, 0x14] // --bg
const ACCENT = [0x5b, 0x9c, 0xff] // --accent
const GLOW = [0x82, 0xb3, 0xff] // --accent-2

// --- render the master bitmap at 256px, RGBA ---
const N = 256
function renderMaster() {
  const px = new Uint8Array(N * N * 4)
  // "A": two legs + crossbar, as thick segments.
  const legL = [
    [70, 202],
    [128, 54]
  ]
  const legR = [
    [128, 54],
    [186, 202]
  ]
  const bar = [
    [96, 150],
    [160, 150]
  ]
  const HALF = 15 // stroke half-width
  const set = (i, rgb, a) => {
    px[i] = rgb[0]
    px[i + 1] = rgb[1]
    px[i + 2] = rgb[2]
    px[i + 3] = a
  }
  const distSeg = (x, y, [[x1, y1], [x2, y2]]) => {
    const dx = x2 - x1
    const dy = y2 - y1
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4
      // rounded-square dark panel with a soft vignette so it reads on light taskbars too
      const cx = x - N / 2
      const cy = y - N / 2
      const r = Math.max(Math.abs(cx), Math.abs(cy))
      if (r > 122) {
        set(i, BG, 0) // transparent outside the rounded square
        continue
      }
      set(i, BG, 255)
      const d = Math.min(distSeg(x, y, legL), distSeg(x, y, legR), distSeg(x, y, bar))
      if (d < HALF) {
        set(i, ACCENT, 255) // solid stroke
      } else if (d < HALF + 10) {
        const t = 1 - (d - HALF) / 10 // outer glow, fades to bg
        for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] + (GLOW[c] - BG[c]) * t * 0.7)
      }
    }
  }
  return px
}

function downscale(src, from, to) {
  const dst = new Uint8Array(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = Math.floor(y * ratio); sy < (y + 1) * ratio; sy++) {
        for (let sx = Math.floor(x * ratio); sx < (x + 1) * ratio; sx++) {
          const i = (sy * from + sx) * 4
          r += src[i]
          g += src[i + 1]
          b += src[i + 2]
          a += src[i + 3]
          n++
        }
      }
      const j = (y * to + x) * 4
      dst[j] = Math.round(r / n)
      dst[j + 1] = Math.round(g / n)
      dst[j + 2] = Math.round(b / n)
      dst[j + 3] = Math.round(a / n)
    }
  }
  return dst
}

// --- PNG encoder (RGBA, filter 0) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, k) => {
      raw[y * (size * 4 + 1) + 1 + k] = v
    })
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO packer (PNG-compressed entries, Vista+) ---
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, idx) => {
    const o = idx * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0 // palette
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bit count
    dir.writeUInt32LE(e.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

mkdirSync(OUT_DIR, { recursive: true })
const master = renderMaster()
const sizes = [256, 64, 48, 32, 16]
const entries = sizes.map((size) => {
  const rgba = size === N ? master : downscale(master, N, size)
  return { size, png: encodePng(rgba, size) }
})
writeFileSync(resolve(OUT_DIR, 'atelier.png'), entries[0].png)
writeFileSync(resolve(OUT_DIR, 'atelier.ico'), encodeIco(entries))
console.log(`Wrote resources/atelier.ico (${sizes.join(', ')}px) and resources/atelier.png`)
