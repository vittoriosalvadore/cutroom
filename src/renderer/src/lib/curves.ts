import type { ColorCurves, CurveChannel, CurvePoint } from '../types'

// ---------------------------------------------------------------------------
// RGB curves (pure). A clip's curves are four small point lists — a master
// curve applied to R, G and B alike, then one curve per channel — each
// interpolated with a monotone cubic spline (Fritsch–Carlson: smooth, but never
// overshoots between points, so a curve can't ring outside 0..1 or invert).
//
// For rendering, the four curves are composed into ONE 256-entry LUT per
// channel (out = channel(master(in)), evaluated in float before quantizing) and
// uploaded as a 256×1 RGBA texture that the compositor's fragment shader samples.
// Preview and export share that shader, so they grade identically. Pure, so it
// is unit-tested directly.
// ---------------------------------------------------------------------------

export const CURVE_CHANNELS: readonly CurveChannel[] = ['master', 'r', 'g', 'b']

/** Most points one channel may hold (keeps the widget and the spline sane). */
export const MAX_CURVE_POINTS = 16
/** Minimum x distance between neighbouring points, so a segment never has zero width. */
export const MIN_POINT_GAP = 0.01

/** LUT resolution: one entry per 8-bit code value. */
export const LUT_SIZE = 256

export function identityPoints(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 }
  ]
}

export function identityCurves(): ColorCurves {
  return { master: identityPoints(), r: identityPoints(), g: identityPoints(), b: identityPoints() }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Validate an untrusted point list: drop malformed entries, clamp to 0..1, sort
 * by x, drop points closer than MIN_POINT_GAP to the previous one, cap the
 * count. Fewer than two usable points means "no curve" -> identity.
 */
export function normalizePoints(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return identityPoints()
  const pts: CurvePoint[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const { x, y } = p as Record<string, unknown>
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
    pts.push({ x: clamp01(x), y: clamp01(y) })
  }
  pts.sort((a, b) => a.x - b.x)
  const out: CurvePoint[] = []
  for (const p of pts) {
    if (out.length > 0 && p.x - out[out.length - 1].x < MIN_POINT_GAP) continue
    out.push(p)
    if (out.length === MAX_CURVE_POINTS) break
  }
  return out.length >= 2 ? out : identityPoints()
}

/** Validate curves from a project file. Absent / garbage / all-identity -> undefined. */
export function sanitizeCurves(raw: unknown): ColorCurves | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const curves = {} as ColorCurves
  for (const ch of CURVE_CHANNELS) curves[ch] = normalizePoints(o[ch])
  return isIdentityCurves(curves) ? undefined : curves
}

/** True when a channel is exactly the default two-point diagonal. */
export function isDefaultChannel(points: CurvePoint[]): boolean {
  return points.length === 2 && points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1
}

/**
 * Fritsch–Carlson tangents for a monotone cubic Hermite spline through sorted
 * points. Interior tangents average neighbouring secants (zero at a local
 * extremum), then get scaled down wherever they would overshoot.
 */
export function monotoneTangents(points: CurvePoint[]): number[] {
  const n = points.length
  if (n < 2) return new Array(n).fill(0)
  const d: number[] = []
  for (let k = 0; k < n - 1; k++) {
    const dx = points[k + 1].x - points[k].x
    d.push(dx > 0 ? (points[k + 1].y - points[k].y) / dx : 0)
  }
  const m: number[] = new Array(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0
      m[k + 1] = 0
      continue
    }
    const a = m[k] / d[k]
    const b = m[k + 1] / d[k]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[k] = tau * a * d[k]
      m[k + 1] = tau * b * d[k]
    }
  }
  return m
}

/**
 * Compile a point list into an evaluator x -> y (both 0..1). Outside the first /
 * last point the curve holds flat, so moving an end point in x crushes (or
 * lifts) everything beyond it — the usual black/white-point behaviour.
 */
export function compileCurve(points: CurvePoint[]): (x: number) => number {
  const pts = points.length >= 2 ? points : identityPoints()
  const m = monotoneTangents(pts)
  const n = pts.length
  return (x: number): number => {
    if (x <= pts[0].x) return pts[0].y
    if (x >= pts[n - 1].x) return pts[n - 1].y
    let k = 0
    while (k < n - 2 && x > pts[k + 1].x) k++
    const p0 = pts[k]
    const p1 = pts[k + 1]
    const h = p1.x - p0.x
    const t = (x - p0.x) / h
    const t2 = t * t
    const t3 = t2 * t
    const y =
      (2 * t3 - 3 * t2 + 1) * p0.y + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * p1.y + (t3 - t2) * h * m[k + 1]
    return clamp01(y)
  }
}

/**
 * The composed RGBA LUT (LUT_SIZE × 4 bytes, alpha 255): entry i maps the 8-bit
 * input i to channel(master(i / 255)). Composition happens in float so the
 * master curve doesn't add a second quantization step.
 */
export function buildCurvesLut(curves: ColorCurves): Uint8Array {
  const master = compileCurve(curves.master)
  const chans = [compileCurve(curves.r), compileCurve(curves.g), compileCurve(curves.b)]
  const lut = new Uint8Array(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = master(i / (LUT_SIZE - 1))
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(chans[c](v) * 255)
    lut[i * 4 + 3] = 255
  }
  return lut
}

/** True when a LUT maps every code value to itself. */
export function isIdentityLut(lut: Uint8Array): boolean {
  for (let i = 0; i < LUT_SIZE; i++) {
    if (lut[i * 4] !== i || lut[i * 4 + 1] !== i || lut[i * 4 + 2] !== i) return false
  }
  return true
}

/** True when the curves are absent or render as the identity (e.g. points on the diagonal). */
export function isIdentityCurves(curves: ColorCurves | undefined): boolean {
  if (!curves) return true
  if (CURVE_CHANNELS.every((ch) => isDefaultChannel(curves[ch]))) return true
  return isIdentityLut(buildCurvesLut(curves))
}

// --- editing helpers (used by the Inspector curve widget) -------------------

/** Move point `i` to (x, y), keeping it strictly between its neighbours in x. */
export function moveCurvePoint(points: CurvePoint[], i: number, x: number, y: number): CurvePoint[] {
  if (i < 0 || i >= points.length) return points
  const lo = i > 0 ? points[i - 1].x + MIN_POINT_GAP : 0
  const hi = i < points.length - 1 ? points[i + 1].x - MIN_POINT_GAP : 1
  const nx = Math.min(hi, Math.max(lo, clamp01(x)))
  const out = points.slice()
  out[i] = { x: nx, y: clamp01(y) }
  return out
}

/** Insert a point at (x, y). Returns null when full or too close to an existing point. */
export function addCurvePoint(
  points: CurvePoint[],
  x: number,
  y: number
): { points: CurvePoint[]; index: number } | null {
  if (points.length >= MAX_CURVE_POINTS) return null
  const px = clamp01(x)
  if (points.some((p) => Math.abs(p.x - px) < MIN_POINT_GAP)) return null
  let index = points.findIndex((p) => p.x > px)
  if (index < 0) index = points.length
  const out = points.slice()
  out.splice(index, 0, { x: px, y: clamp01(y) })
  return { points: out, index }
}

/** Remove point `i`; a curve always keeps at least two points. */
export function removeCurvePoint(points: CurvePoint[], i: number): CurvePoint[] {
  if (points.length <= 2 || i < 0 || i >= points.length) return points
  return points.filter((_, k) => k !== i)
}
