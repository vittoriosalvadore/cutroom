import { computeScopes, scopeSampleSize, type ScopeData } from './scopes'

// ---------------------------------------------------------------------------
// Scope readback (DOM side). Draws the preview's WebGL canvas into a small 2D
// canvas and reads the pixels back for lib/scopes. Must run in the SAME task as
// the WebGL render: the preview context doesn't preserve its drawing buffer, so
// once the frame is presented a later drawImage could see a cleared buffer.
// Nearest-neighbour downscale on purpose — every sample is a real output colour
// (a smoothed downscale would invent in-between colours on the vectorscope).
// ---------------------------------------------------------------------------

export class ScopeSampler {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null

  constructor() {
    this.canvas = document.createElement('canvas')
    // CPU-backed: we read it back every sample.
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
  }

  /** Read `src` back small and compute the scopes. Null if there's nothing to read. */
  sample(src: HTMLCanvasElement): ScopeData | null {
    const ctx = this.ctx
    if (!ctx || src.width <= 0 || src.height <= 0) return null
    const { w, h } = scopeSampleSize(src.width, src.height)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(src, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    return computeScopes(img.data, w, h)
  }
}
