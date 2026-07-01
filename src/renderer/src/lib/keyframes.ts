import type { AnimProp, Clip, ClipTransform, Keyframe } from '../types'
import { IDENTITY_TRANSFORM } from '../types'

// ---------------------------------------------------------------------------
// Pure keyframe evaluation. No DOM / WebGL / store imports, so it is unit-tested
// in plain Node AND is the single source of truth the compositor samples for
// BOTH preview and export — guaranteeing they animate identically.
// ---------------------------------------------------------------------------

/** Two keys closer than this (seconds) are treated as the same time. */
export const KEY_EPS = 1e-4

function smoothstep(f: number): number {
  return f * f * (3 - 2 * f)
}

/**
 * Value of a keyframe track at clip-relative time `t`. Holds the first value
 * before the first key and the last value after the last key. Assumes `kfs` is
 * sorted by time (the store keeps it sorted). Returns NaN for an empty track —
 * callers fall back to the static value.
 */
export function evalKeyframes(kfs: Keyframe[], t: number): number {
  const n = kfs.length
  if (n === 0) return NaN
  if (n === 1) return kfs[0].v
  if (t <= kfs[0].t) return kfs[0].v
  if (t >= kfs[n - 1].t) return kfs[n - 1].v
  let i = 0
  while (i < n - 1 && kfs[i + 1].t <= t) i++
  const a = kfs[i]
  const b = kfs[i + 1]
  if (a.ease === 'hold') return a.v
  const span = b.t - a.t
  if (span <= KEY_EPS) return b.v
  let f = (t - a.t) / span
  if (a.ease === 'smooth') f = smoothstep(f)
  return a.v + (b.v - a.v) * f
}

/** Index of a key at (or within KEY_EPS of) time `t`, else -1. For upsert + diamonds. */
export function keyIndexAt(kfs: Keyframe[], t: number): number {
  for (let i = 0; i < kfs.length; i++) {
    if (Math.abs(kfs[i].t - t) <= KEY_EPS) return i
  }
  return -1
}

/** A time-sorted copy (does not mutate the input). */
export function sortKeys(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.t - b.t)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function finite(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback
}

/**
 * Clamp a transform into the renderable range: scale floored, crop insets in
 * [0, 0.49] with a degenerate pair rescaled, and every field finite. Guards the
 * shader against a corrupt / hand-edited static transform (the no-keyframe fast
 * path) just as the keyframe path is already guarded.
 */
export function normalizeTransform(t: ClipTransform): ClipTransform {
  let top = clamp(finite(t.crop.top, 0), 0, 0.49)
  let bottom = clamp(finite(t.crop.bottom, 0), 0, 0.49)
  let left = clamp(finite(t.crop.left, 0), 0, 0.49)
  let right = clamp(finite(t.crop.right, 0), 0, 0.49)
  if (top + bottom > 0.98) {
    const k = 0.98 / (top + bottom)
    top *= k
    bottom *= k
  }
  if (left + right > 0.98) {
    const k = 0.98 / (left + right)
    left *= k
    right *= k
  }
  return {
    scale: Math.max(0.01, finite(t.scale, 1)),
    posX: finite(t.posX, 0),
    posY: finite(t.posY, 0),
    rotationDeg: finite(t.rotationDeg, 0),
    crop: { top, right, bottom, left }
  }
}

/**
 * Rebase keyframe times when a clip's start moves by `delta` (a head trim), so
 * the animation keeps its absolute timeline position. delta > 0 = head trimmed
 * IN (reuse the split's right side: drop head keys, hold the value at the cut);
 * delta < 0 = head extended OUT (shift keys later). Returns undefined when empty.
 */
export function rebaseTracks(
  keyframes: Partial<Record<AnimProp, Keyframe[]>>,
  delta: number
): Partial<Record<AnimProp, Keyframe[]>> | undefined {
  if (Math.abs(delta) <= KEY_EPS) return keyframes
  if (delta > 0) return splitTracksAt(keyframes, delta).right
  const out: Partial<Record<AnimProp, Keyframe[]>> = {}
  for (const key of Object.keys(keyframes) as AnimProp[]) {
    const track = keyframes[key]
    if (track && track.length > 0) out[key] = track.map((kf) => ({ ...kf, t: kf.t - delta }))
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The full transform at clip-relative time `t`: each property comes from its
 * keyframe track if present (and finite), otherwise the static transform. Crop
 * insets are clamped to a safe range and a degenerate pair (>~1 total) is
 * rescaled so the quad never inverts.
 */
export function sampleTransform(clip: Clip, t: number): ClipTransform {
  const kf = clip.keyframes
  if (!kf || Object.keys(kf).length === 0) {
    // No animation: a static transform is normalized (guards corrupt input);
    // no transform at all returns the shared identity with zero allocation.
    return clip.transform ? normalizeTransform(clip.transform) : IDENTITY_TRANSFORM
  }
  const base = clip.transform ?? IDENTITY_TRANSFORM
  const val = (prop: AnimProp, fallback: number): number => {
    const track = kf[prop]
    if (!track || track.length === 0) return fallback
    const v = evalKeyframes(track, t)
    return Number.isFinite(v) ? v : fallback
  }
  let top = clamp(val('cropTop', base.crop.top), 0, 0.49)
  let bottom = clamp(val('cropBottom', base.crop.bottom), 0, 0.49)
  let left = clamp(val('cropLeft', base.crop.left), 0, 0.49)
  let right = clamp(val('cropRight', base.crop.right), 0, 0.49)
  if (top + bottom > 0.98) {
    const k = 0.98 / (top + bottom)
    top *= k
    bottom *= k
  }
  if (left + right > 0.98) {
    const k = 0.98 / (left + right)
    left *= k
    right *= k
  }
  return {
    scale: Math.max(0.01, val('scale', base.scale)),
    posX: val('posX', base.posX),
    posY: val('posY', base.posY),
    rotationDeg: val('rotationDeg', base.rotationDeg),
    crop: { top, right, bottom, left }
  }
}

/** Opacity at time `t`: the keyframe track overrides the static value. */
export function sampleOpacity(clip: Clip, staticOpacity: number, t: number): number {
  const track = clip.keyframes?.opacity
  if (!track || track.length === 0) return staticOpacity
  const v = evalKeyframes(track, t)
  return Number.isFinite(v) ? clamp(v, 0, 1) : staticOpacity
}

/** The static value of an animatable property (the fallback when no track). */
export function staticPropValue(transform: ClipTransform, staticOpacity: number, prop: AnimProp): number {
  switch (prop) {
    case 'opacity':
      return staticOpacity
    case 'scale':
      return transform.scale
    case 'posX':
      return transform.posX
    case 'posY':
      return transform.posY
    case 'rotationDeg':
      return transform.rotationDeg
    case 'cropTop':
      return transform.crop.top
    case 'cropRight':
      return transform.crop.right
    case 'cropBottom':
      return transform.crop.bottom
    case 'cropLeft':
      return transform.crop.left
  }
}

/** A new transform with one (non-opacity) property set. */
export function withTransformProp(transform: ClipTransform, prop: AnimProp, v: number): ClipTransform {
  const t: ClipTransform = { ...transform, crop: { ...transform.crop } }
  switch (prop) {
    case 'scale':
      t.scale = v
      break
    case 'posX':
      t.posX = v
      break
    case 'posY':
      t.posY = v
      break
    case 'rotationDeg':
      t.rotationDeg = v
      break
    case 'cropTop':
      t.crop.top = v
      break
    case 'cropRight':
      t.crop.right = v
      break
    case 'cropBottom':
      t.crop.bottom = v
      break
    case 'cropLeft':
      t.crop.left = v
      break
    case 'opacity':
      break // opacity is stored on effects, handled by the caller
  }
  return t
}

/**
 * Partition keyframe tracks at a clip-relative `offset` (a split). The left half
 * keeps keys before the cut, the right half keeps keys after it rebased to start
 * at 0; both get a boundary key holding the value AT the cut, so neither side
 * pops. Returns trimmed maps (omit empty so the identity fast path is preserved).
 */
export function splitTracksAt(
  keyframes: Partial<Record<AnimProp, Keyframe[]>>,
  offset: number
): { left?: Partial<Record<AnimProp, Keyframe[]>>; right?: Partial<Record<AnimProp, Keyframe[]>> } {
  const left: Partial<Record<AnimProp, Keyframe[]>> = {}
  const right: Partial<Record<AnimProp, Keyframe[]>> = {}
  for (const key of Object.keys(keyframes) as AnimProp[]) {
    const track = keyframes[key]
    if (!track || track.length === 0) continue
    const valAt = evalKeyframes(track, offset)
    const lkeys = track.filter((kf) => kf.t < offset - KEY_EPS)
    const rkeys = track.filter((kf) => kf.t > offset + KEY_EPS).map((kf) => ({ ...kf, t: kf.t - offset }))
    lkeys.push({ t: offset, v: valAt, ease: 'smooth' })
    rkeys.unshift({ t: 0, v: valAt, ease: 'smooth' })
    left[key] = lkeys
    right[key] = rkeys
  }
  const has = (m: object): boolean => Object.keys(m).length > 0
  return { left: has(left) ? left : undefined, right: has(right) ? right : undefined }
}

/** Clamp a property value to its valid range. */
export function clampProp(prop: AnimProp, v: number): number {
  if (prop === 'opacity') return Math.max(0, Math.min(1, v))
  if (prop === 'scale') return Math.max(0.01, v)
  if (prop === 'cropTop' || prop === 'cropRight' || prop === 'cropBottom' || prop === 'cropLeft') {
    return Math.max(0, Math.min(0.49, v))
  }
  return v
}

/** True when a clip has any active transform or keyframes (else identity fast path). */
export function hasTransform(clip: Clip): boolean {
  if (clip.keyframes && Object.keys(clip.keyframes).length > 0) return true
  const tf = clip.transform
  if (!tf) return false
  return (
    tf.scale !== 1 ||
    tf.posX !== 0 ||
    tf.posY !== 0 ||
    tf.rotationDeg !== 0 ||
    tf.crop.top !== 0 ||
    tf.crop.right !== 0 ||
    tf.crop.bottom !== 0 ||
    tf.crop.left !== 0
  )
}
