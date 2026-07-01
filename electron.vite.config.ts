import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite drives three separate builds: main process, preload, and the
// renderer (the UI). Keeping them in one config file keeps the wiring obvious.
export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps node_modules out of the main bundle so native
    // modules (e.g. a future fluent-ffmpeg) load from node_modules at runtime.
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    // Whisper transcription runs in a Web Worker (ES module). transformers.js
    // loads its WASM/model dynamically, so keep Vite from pre-bundling it.
    worker: {
      format: 'es'
    },
    optimizeDeps: {
      exclude: ['@xenova/transformers']
    }
  }
})
