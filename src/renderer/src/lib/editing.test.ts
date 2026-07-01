import { describe, it, expect } from 'vitest'
import { computeCrossfade, computeTrim, snapMove, snapTime, MIN_CLIP_SEC, type ClipBounds } from './editing'

const PX = 100 // 100 px/sec -> 8px threshold = 0.08s

describe('snapTime', () => {
  it('snaps to a candidate within threshold', () => {
    expect(snapTime(5.05, [5, 10], PX)).toBe(5)
  })
  it('does not snap when outside threshold', () => {
    expect(snapTime(5.2, [5, 10], PX)).toBe(5.2)
  })
  it('picks the closest candidate', () => {
    expect(snapTime(5.02, [5, 5.06], PX)).toBe(5)
  })
})

describe('snapMove', () => {
  it('snaps the leading edge to a candidate', () => {
    expect(snapMove(4.96, 2, [5], PX)).toBe(5) // start 4.96 -> 5
  })
  it('snaps the trailing edge to a candidate', () => {
    // start 2.96, end 4.96 -> snap end to 5 -> start becomes 3
    expect(snapMove(2.96, 2, [5], PX)).toBeCloseTo(3)
  })
  it('returns raw start when nothing is close', () => {
    expect(snapMove(2.5, 2, [5], PX)).toBe(2.5)
  })
})

const base: ClipBounds = { startSec: 2, durationSec: 4, inSec: 1 }

describe('computeTrim right edge', () => {
  it('extends and shrinks duration', () => {
    expect(computeTrim(base, 'right', 1, { isMedia: true, srcDuration: 100 }).durationSec).toBe(5)
    expect(computeTrim(base, 'right', -1, { isMedia: true, srcDuration: 100 }).durationSec).toBe(3)
  })
  it('clamps to the minimum length', () => {
    expect(computeTrim(base, 'right', -10, { isMedia: true, srcDuration: 100 }).durationSec).toBe(MIN_CLIP_SEC)
  })
  it('clamps to the source out-point (inSec + dur <= srcDuration)', () => {
    // inSec 1, srcDuration 3 -> max dur 2
    expect(computeTrim(base, 'right', 10, { isMedia: true, srcDuration: 3 }).durationSec).toBe(2)
  })
})

describe('computeTrim left edge', () => {
  it('moves start, inSec and duration together for media', () => {
    const r = computeTrim(base, 'left', 1, { isMedia: true, srcDuration: 100 })
    expect(r).toEqual({ startSec: 3, durationSec: 3, inSec: 2 })
  })
  it('clamps so inSec never goes below 0', () => {
    // delta -5 would make inSec 1-5=-4; clamped to delta -1 (inSec 0)
    const r = computeTrim(base, 'left', -5, { isMedia: true, srcDuration: 100 })
    expect(r.inSec).toBe(0)
    expect(r.startSec).toBe(1)
    expect(r.durationSec).toBe(5)
  })
  it('keeps inSec for non-media clips', () => {
    const r = computeTrim({ startSec: 2, durationSec: 4, inSec: 0 }, 'left', 1, { isMedia: false, srcDuration: null })
    expect(r).toEqual({ startSec: 3, durationSec: 3, inSec: 0 })
  })
  it('clamps duration to the minimum', () => {
    const r = computeTrim(base, 'left', 10, { isMedia: true, srcDuration: 100 })
    expect(r.durationSec).toBeCloseTo(MIN_CLIP_SEC)
  })

  it('right-edge clamps by source CONSUMPTION at speed (dur*speed <= srcDuration)', () => {
    const r = computeTrim({ startSec: 0, durationSec: 4, inSec: 0 }, 'right', 10, {
      isMedia: true,
      srcDuration: 10,
      speed: 2
    })
    expect(r.durationSec).toBeCloseTo(5) // 10 / 2
  })

  it('left-edge moves the in-point by delta*speed', () => {
    const r = computeTrim({ startSec: 2, durationSec: 6, inSec: 4 }, 'left', 1, {
      isMedia: true,
      srcDuration: 100,
      speed: 2
    })
    expect(r.startSec).toBeCloseTo(3)
    expect(r.inSec).toBeCloseTo(6) // 4 + 1*2
  })
})

describe('computeCrossfade', () => {
  it('uses the existing overlap when clips already overlap', () => {
    const r = computeCrossfade({ startSec: 0, durationSec: 5 }, { startSec: 3, durationSec: 5 })
    expect(r.overlap).toBeCloseTo(2)
    expect(r.lStart).toBe(3) // not moved
  })
  it('pulls the later clip left to create a default overlap when touching', () => {
    const r = computeCrossfade({ startSec: 0, durationSec: 5 }, { startSec: 5, durationSec: 5 })
    expect(r.overlap).toBeCloseTo(0.5)
    expect(r.lStart).toBeCloseTo(4.5)
  })
  it('clamps the overlap to the shorter clip', () => {
    const r = computeCrossfade({ startSec: 0, durationSec: 1 }, { startSec: 0.4, durationSec: 5 })
    // existing overlap 0.6, but clamp to e duration 1 -> stays 0.6
    expect(r.overlap).toBeCloseTo(0.6)
  })
})
