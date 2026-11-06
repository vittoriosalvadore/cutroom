// ---------------------------------------------------------------------------
// Video scopes (pure). The preview output is read back small (~256 px wide,
// nearest-neighbour so every sample is a real output colour) and reduced here to
//   • a histogram — 256 bins each for R, G, B and luma,
//   • a luma waveform — per image column, a 256-level count of luma values,
//   • a vectorscope — a 2D count of BT.709 Cb/Cr (colour hue + saturation).
// Luma is BT.709 (Rec. 709 is what the export tags), computed on the 8-bit
// display values. All three are plain counts; the Scopes panel maps them to
// brightness. Pure (typed arrays in, typed arrays out), so it is unit-tested.
// ---------------------------------------------------------------------------

/** Width the preview is read back at for the scopes. */
export const SCOPE_SAMPLE_WIDTH = 256
/** Minimum time between scope readbacks (8 Hz): cheap enough to run during playback. */
export const SCOPE_INTERVAL_MS = 125
/** Vectorscope plot resolution (square). */
export const VECTORSCOPE_SIZE = 256

const KR = 0.2126
const KG = 0.7152
const KB = 0.0722

/** Readback size: SCOPE_SAMPLE_WIDTH wide (never upscaled), aspect kept, at least 1 px. */
export function scopeSampleSize(w: number, h: number, maxW = SCOPE_SAMPLE_WIDTH): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 1, h: 1 }
  const sw = Math.min(maxW, Math.round(w))
  return { w: Math.max(1, sw), h: Math.max(1, Math.round((h * sw) / w)) }
}

/** BT.709 luma of 8-bit RGB, as an 8-bit code value (0..255). */
export function luma709(r: number, g: number, b: number): number {
  return Math.round(KR * r + KG * g + KB * b)
}

/** BT.709 colour-difference of 0..1 RGB: Cb, Cr each in -0.5..0.5. */
export function cbcr709(r: number, g: number, b: number): [number, number] {
  const y = KR * r + KG * g + KB * b
  return [(b - y) / (2 * (1 - KB)), (r - y) / (2 * (1 - KR))]
}

/** Vectorscope pixel for (Cb, Cr): centre = neutral, Cb to the right, Cr up. */
export function vectorscopeXY(cb: number, cr: number, size = VECTORSCOPE_SIZE): [number, number] {
  const x = Math.min(size - 1, Math.max(0, Math.floor((cb + 0.5) * size)))
  const y = Math.min(size - 1, Math.max(0, Math.floor((0.5 - cr) * size)))
  return [x, y]
}

export interface Histogram {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  luma: Uint32Array
}

export interface ScopeData {
  /** Readback width/height the counts were computed from. */
  w: number
  h: number
  histogram: Histogram
  /** waveform[level * w + x] = pixels in column x whose luma is `level` (0..255). */
  waveform: Uint32Array
  /** vectorscope[y * VECTORSCOPE_SIZE + x] = pixels plotted at (x, y). */
  vectorscope: Uint32Array
}

/**
 * One pass over RGBA pixels (row-major, `w` × `h`) computing all three scopes.
 * Alpha is ignored — the preview canvas is opaque.
 */
export function computeScopes(px: ArrayLike<number>, w: number, h: number): ScopeData {
  const histogram: Histogram = {
    r: new Uint32Array(256),
    g: new Uint32Array(256),
    b: new Uint32Array(256),
    luma: new Uint32Array(256)
  }
  const waveform = new Uint32Array(256 * w)
  const size = VECTORSCOPE_SIZE
  const vectorscope = new Uint32Array(size * size)
  // Cb/Cr scale factors for 8-bit input (divide by 255 folded in).
  const cbK = 1 / (255 * 2 * (1 - KB))
  const crK = 1 / (255 * 2 * (1 - KR))
  const n = Math.min(w * h, Math.floor(px.length / 4))
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const r = px[o]
    const g = px[o + 1]
    const b = px[o + 2]
    histogram.r[r]++
    histogram.g[g]++
    histogram.b[b]++
    const yf = KR * r + KG * g + KB * b
    const y = Math.round(yf)
    histogram.luma[y]++
    waveform[y * w + (i % w)]++
    const vx = Math.floor(((b - yf) * cbK + 0.5) * size)
    const vy = Math.floor((0.5 - (r - yf) * crK) * size)
    vectorscope[(vy < 0 ? 0 : vy >= size ? size - 1 : vy) * size + (vx < 0 ? 0 : vx >= size ? size - 1 : vx)]++
  }
  return { w, h, histogram, waveform, vectorscope }
}

/** Largest count in `arr[from..to)` (used to scale histograms without letting a clipped end bin dominate). */
export function maxCount(arr: ArrayLike<number>, from = 0, to = arr.length): number {
  let m = 0
  for (let i = from; i < to; i++) if (arr[i] > m) m = arr[i]
  return m
}

/**
 * Brightness 0..1 for a scope cell holding `count` of `max`. Logarithmic, so a
 * few stray pixels still show while a flat colour field doesn't blow out.
 */
export function density(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  return Math.min(1, Math.log1p(count) / Math.log1p(max))
}

/** Throttle gate: may a new readback run at `now` given the last one at `last`? */
export function shouldSample(now: number, last: number, intervalMs = SCOPE_INTERVAL_MS): boolean {
  return now - last >= intervalMs
}

/** Vectorscope graticule targets: 75% colour bars (the standard reference boxes). */
export const VECTORSCOPE_TARGETS: { label: string; rgb: [number, number, number] }[] = [
  { label: 'R', rgb: [0.75, 0, 0] },
  { label: 'Mg', rgb: [0.75, 0, 0.75] },
  { label: 'B', rgb: [0, 0, 0.75] },
  { label: 'Cy', rgb: [0, 0.75, 0.75] },
  { label: 'G', rgb: [0, 0.75, 0] },
  { label: 'Yl', rgb: [0.75, 0.75, 0] }
]
