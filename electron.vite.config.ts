import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Content-Security-Policy for the packaged renderer. Build-only: Vite's dev
// server injects inline scripts for HMR. Scripts are limited to the bundle
// (+ WASM for transformers.js); media comes from the cutroom:// protocol; AI
// models and ONNX runtime WASM are fetched over https (Hugging Face / CDN).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' cutroom: blob: data: https:",
  "img-src 'self' cutroom: blob: data:",
  "media-src 'self' cutroom: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'cutroom-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
  }
}

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
    plugins: [react(), cspPlugin()],
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
