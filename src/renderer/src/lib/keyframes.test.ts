import { describe, it, expect } from 'vitest'
import {
  evalKeyframes,
  keyIndexAt,
  sortKeys,
  sampleTransform,
  sampleOpacity,
  hasTransform,
  normalizeTransform,
  rebaseTracks
} from './keyframes'
import type { Clip, Keyframe } from '../types'

const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease })
const clip = (over: Partial<Clip>): Clip =>
  ({ id: 'c', trackId: 't', mediaId: 'm', startSec: 0, durationSec: 10, inSec: 0, ...over }) as Clip

describe('evalKeyframes', () => {
  it('holds before the first and after the last key', () => {
    const kf = [k(1, 10), k(3, 30)]
    expect(evalKeyframes(kf, 0)).toBe(10)
    expect(evalKeyframes(kf, 1)).toBe(10)
    expect(evalKeyframes(kf, 5)).toBe(30)
  })
  it('is a single constant for one key', () => {
    expect(evalKeyframes([k(2, 7)], 0)).toBe(7)
    expect(evalKeyframes([k(2, 7)], 99)).toBe(7)
  })
  it('interpolates linearly at the midpoint', () => {
    expect(evalKeyframes([k(0, 0), k(2, 100)], 1)).toBeCloseTo(50)
  })
  it('holds with ease=hold and eases with smooth', () => {
    expect(evalKeyframes([k(0, 0, 'hold'), k(2, 100)], 1)).toBe(0)
    // smoothstep(0.5) = 0.5 -> 50, but smoothstep at 0.25 = 0.156
    expect(evalKeyframes([k(0, 0, 'smooth'), k(4, 100)], 1)).toBeCloseTo(15.625)
  })
  it('handles coincident times without NaN (returns the later value)', () => {
    expect(evalKeyframes([k(1, 10), k(1, 20)], 1)).toBe(10) // t<=first returns first
    const r = evalKeyframes([k(0, 0), k(1, 10), k(1, 20)], 1)
    expect(Number.isFinite(r)).toBe(true)
  })
  it('returns NaN for an empty track', () => {
    expect(Number.isNaN(evalKeyframes([], 1))).toBe(true)
  })
})

describe('keyIndexAt / sortKeys', () => {
  it('finds a key within epsilon', () => {
    expect(keyIndexAt([k(0, 0), k(1, 1)], 1.00001)).toBe(1)
    expect(keyIndexAt([k(0, 0), k(1, 1)], 0.5)).toBe(-1)
  })
  it('sorts a copy without mutating the source', () => {
    const src = [k(3, 3), k(1, 1), k(2, 2)]
    const out = sortKeys(src)
    expect(out.map((x) => x.t)).toEqual([1, 2, 3])
    expect(src.map((x) => x.t)).toEqual([3, 1, 2]) // unchanged
  })
})

describe('sampleTransform', () => {
  it('returns the static transform when there are no keyframes', () => {
    const t = { scale: 2, posX: 0.1, posY: 0, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } }
    expect(sampleTransform(clip({ transform: t }), 5)).toEqual(t)
  })
  it('is identity for a bare clip', () => {
    expect(sampleTransform(clip({}), 0).scale).toBe(1)
  })
  it('keyframes override per property; finite NaN falls back', () => {
    const c = clip({ keyframes: { scale: [k(0, 1), k(10, 3)] } })
    expect(sampleTransform(c, 5).scale).toBeCloseTo(2)
  })
  it('floors scale and clamps crop on the keyframe path', () => {
    const c = clip({ keyframes: { scale: [k(0, -5)], cropTop: [k(0, 0.8)], cropBottom: [k(0, 0.8)] } })
    const r = sampleTransform(c, 0)
    expect(r.scale).toBe(0.01) // floored
    expect(r.crop.top).toBeLessThanOrEqual(0.49) // clamped
    expect(r.crop.bottom).toBeLessThanOrEqual(0.49)
    expect(r.crop.top + r.crop.bottom).toBeLessThanOrEqual(0.98 + 1e-9)
  })
})

describe('sampleOpacity / hasTransform', () => {
  it('falls back to the static opacity without a track', () => {
    expect(sampleOpacity(clip({}), 0.5, 3)).toBe(0.5)
  })
  it('keyframes override and clamp opacity', () => {
    expect(sampleOpacity(clip({ keyframes: { opacity: [k(0, 0), k(10, 1)] } }), 1, 5)).toBeCloseTo(0.5)
  })
  it('hasTransform is false for a default clip (identity fast path)', () => {
    expect(hasTransform(clip({}))).toBe(false)
    expect(hasTransform(clip({ transform: { scale: 1, posX: 0, posY: 0, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } } }))).toBe(false)
    expect(hasTransform(clip({ keyframes: { scale: [k(0, 1)] } }))).toBe(true)
    expect(hasTransform(clip({ transform: { scale: 1.5, posX: 0, posY: 0, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } } }))).toBe(true)
  })
  it('sampleTransform normalizes a corrupt STATIC transform on the fast path', () => {
    const c = clip({ transform: { scale: -5, posX: 0.1, posY: Infinity, rotationDeg: 0, crop: { top: 0.7, right: 0.7, bottom: 0, left: 0 } } })
    const r = sampleTransform(c, 0)
    expect(r.scale).toBe(0.01) // finite-but-too-small -> floored
    expect(r.posY).toBe(0) // Infinity -> default
    expect(r.crop.top).toBeLessThanOrEqual(0.49)
  })
})

describe('normalizeTransform', () => {
  it('floors a too-small scale, defaults non-finite, clamps crop', () => {
    const r = normalizeTransform({ scale: 0, posX: 5, posY: NaN, rotationDeg: 720, crop: { top: 0.9, right: 0, bottom: 0, left: 0 } })
    expect(r.scale).toBe(0.01) // finite 0 -> floored
    expect(r.posX).toBe(5)
    expect(r.posY).toBe(0) // NaN -> default
    expect(r.rotationDeg).toBe(720)
    expect(r.crop.top).toBe(0.49)
  })
  it('defaults a NaN scale to 1 (not the floor)', () => {
    expect(normalizeTransform({ scale: NaN, posX: 0, posY: 0, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } }).scale).toBe(1)
  })
})

describe('rebaseTracks', () => {
  it('rebases earlier and holds the cut value on a head trim (delta>0)', () => {
    const r = rebaseTracks({ scale: [k(0, 1), k(4, 5)] }, 2)!
    expect(r.scale![0].t).toBe(0)
    expect(r.scale![0].v).toBeCloseTo(3) // value held at the cut
    expect(r.scale![1].t).toBe(2) // 4 - 2
  })
  it('shifts later on a head extension (delta<0)', () => {
    const r = rebaseTracks({ posX: [k(1, 0.2)] }, -2)!
    expect(r.posX![0].t).toBe(3)
  })
  it('returns the input unchanged for ~zero delta', () => {
    const kf = { scale: [k(0, 1)] }
    expect(rebaseTracks(kf, 0)).toBe(kf)
  })
})
