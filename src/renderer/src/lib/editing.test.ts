import { describe, it, expect } from 'vitest'
import {
  computeCrossfade,
  computeTrim,
  rippleShift,
  rippleShiftMarkers,
  snapMove,
  snapTime,
  splitClipAt,
  MIN_CLIP_SEC,
  type ClipBounds
} from './editing'

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

describe('splitClipAt', () => {
  const clip = { startSec: 2, durationSec: 4, inSec: 1 } // spans [2, 6)

  it('returns undefined at or before the clip start', () => {
    expect(splitClipAt(clip, 2)).toBeUndefined()
    expect(splitClipAt(clip, 1)).toBeUndefined()
  })
  it('returns undefined at or after the clip end', () => {
    expect(splitClipAt(clip, 6)).toBeUndefined()
    expect(splitClipAt(clip, 7)).toBeUndefined()
  })
  it('splits into two adjacent pieces at the cut', () => {
    const r = splitClipAt(clip, 3.5)! // offset 1.5 into the clip
    expect(r.left).toEqual({ startSec: 2, durationSec: 1.5, inSec: 1, fadeInSec: 0, fadeOutSec: 0, keyframes: undefined })
    expect(r.right.startSec).toBe(3.5)
    expect(r.right.durationSec).toBeCloseTo(2.5)
    expect(r.right.inSec).toBeCloseTo(2.5) // 1 + 1.5*speed(1)
  })
  it('scales the right piece inSec by speed', () => {
    const r = splitClipAt({ startSec: 0, durationSec: 4, inSec: 0, speed: 2 }, 1)!
    expect(r.right.inSec).toBeCloseTo(2) // offset 1 * speed 2
  })
  it('clamps fades so they cannot straddle the cut', () => {
    const r = splitClipAt({ ...clip, fadeInSec: 3, fadeOutSec: 3 }, 3)! // offset 1
    expect(r.left.fadeInSec).toBeCloseTo(1) // min(3, offset=1)
    expect(r.left.fadeOutSec).toBe(0)
    expect(r.right.fadeInSec).toBe(0)
    expect(r.right.fadeOutSec).toBeCloseTo(3) // min(3, rightDur=3)
  })
})

describe('rippleShift', () => {
  const clips = [
    { id: 'a', trackId: 't1', startSec: 0 },
    { id: 'b', trackId: 't1', startSec: 5 },
    { id: 'c', trackId: 't1', startSec: 10 },
    { id: 'd', trackId: 't2', startSec: 10 } // other track, must not move
  ]
  it('shifts same-track clips at/after the removed start, left by the removed duration', () => {
    const r = rippleShift(clips, 't1', 5, 2)
    expect(r.find((c) => c.id === 'a')!.startSec).toBe(0) // before the range, untouched
    expect(r.find((c) => c.id === 'b')!.startSec).toBe(3) // at the range start, shifted
    expect(r.find((c) => c.id === 'c')!.startSec).toBe(8) // after, shifted
    expect(r.find((c) => c.id === 'd')!.startSec).toBe(10) // other track, untouched
  })
  it('clamps the shifted start at 0', () => {
    const r = rippleShift([{ id: 'a', trackId: 't1', startSec: 1 }], 't1', 0, 5)
    expect(r[0].startSec).toBe(0)
  })
})

describe('rippleShiftMarkers', () => {
  it('shifts point markers at/after the removed start', () => {
    const markers = [{ timeSec: 2 }, { timeSec: 5 }, { timeSec: 10 }]
    const r = rippleShiftMarkers(markers, 5, 3)
    expect(r.map((m) => m.timeSec)).toEqual([2, 2, 7])
  })
  it('shifts both endpoints of a region marker', () => {
    const markers = [{ timeSec: 6, endSec: 9 }]
    const r = rippleShiftMarkers(markers, 5, 3)
    expect(r[0]).toEqual({ timeSec: 3, endSec: 6 })
  })
  it('leaves markers strictly before the removed range untouched', () => {
    const markers = [{ timeSec: 1, endSec: 4 }]
    const r = rippleShiftMarkers(markers, 5, 3)
    expect(r[0]).toEqual({ timeSec: 1, endSec: 4 })
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
