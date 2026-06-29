import { defineConfig } from 'vitest/config'

// Unit tests run in Node (main-process modules + pure logic). Vite's resolver maps
// the source's `.js` import specifiers back to their `.ts` files, so no extra config
// is needed for the `electron/` modules.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['electron/**/*.ts', 'src/**/*.ts'],
      exclude: ['**/*.test.*', 'electron/preload.ts', 'electron/main.ts']
    }
  }
})
