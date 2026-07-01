import { defineConfig } from 'vitest/config'

// Minimal config so vitest does NOT try to load electron.vite.config.ts (which
// is an electron-vite multi-target config, not a plain Vite one). Tests cover
// pure logic only (fade math, FFmpeg arg building) in a node environment.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
