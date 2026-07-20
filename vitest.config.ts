import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests run in Node (main-process modules + pure logic). Vite's resolver maps
// the source's `.js` import specifiers back to their `.ts` files, so no extra config
// is needed for the `electron/` modules. Renderer modules use the `@shared` alias
// (mirrors electron.vite.config.ts / tsconfig.web.json).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'electron/shared')
    }
  },
  test: {
    environment: 'node',
    // Plugin backends are plain JS (they run outside the app's TS build), but their pure parsers
    // are unit-tested here — include agent-flow's git porcelain parser suite (`.test.mjs`).
    include: ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'plugins/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['electron/**/*.ts', 'src/**/*.ts'],
      exclude: ['**/*.test.*', 'electron/preload.ts', 'electron/main.ts']
    }
  }
})
