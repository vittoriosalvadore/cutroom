import type { CutroomApi } from '../../preload'

// Strongly types the preload bridge for the whole renderer.
// Kept in the renderer (not next to preload/index.ts) so it doesn't shadow that
// module's own declaration output.
declare global {
  interface Window {
    cutroom: CutroomApi
  }
}

export {}
