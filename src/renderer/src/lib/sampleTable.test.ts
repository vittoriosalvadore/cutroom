import { describe, it, expect } from 'vitest'
import {
  findKeyframeBefore,
  findSampleAtOrBefore,
  parseContentRangeTotal,
  presentationOffsetSec,
  sampleByteSpan,
  type SampleEntry
} from './sampleTable'

// A toy sample table: keyframes at samples 0 and 10 (each sample = 1/30s).
const samples: SampleEntry[] = Array.from({ length: 25 }, (_, i) => ({
  isSync: i === 0 || i === 10,
  offset: i * 1000, // bytes
  size: 800,
  time: i / 30, // 30fps, monotonic cts
  duration: 1 / 30
}))

/** Decode order with B-frames: cts is NOT monotonic across the array.
 *  Decode order:      I(0)  P(3)  B(1)  B(2)  P(6)  B(4)  B(5)
 *  Presentation time:  0     3     1     2     6     4     5   */
function s(time: number, isSync: boolean, offset = 0, size = 100): SampleEntry {
  return { isSync, offset, size, time, duration: 1 }
}
const BFRAMES: SampleEntry[] = [s(0, true), s(3, false), s(1, false), s(2, false), s(6, false), s(4, false), s(5, false)]

describe('findKeyframeBefore', () => {
  it('returns the sample at the exact time when it is a keyframe', () => {
    expect(findKeyframeBefore(samples, 10 / 30)).toBe(10)
  })
  it('returns the preceding keyframe for a time between keyframes', () => {
    // 0.4s is sample 12; preceding keyframe is sample 10
    expect(findKeyframeBefore(samples, 0.4)).toBe(10)
  })
  it('returns the first sample for a time before the first keyframe', () => {
    expect(findKeyframeBefore(samples, 0)).toBe(0)
  })
  it('clamps to the last keyframe for a time past the end', () => {
    expect(findKeyframeBefore(samples, 100)).toBe(10) // last keyframe in this toy table
  })
  it('walks back in decode order with B-frame (non-monotonic) cts', () => {
    // Target for t=3.5 is decode index 1 (cts 3); nearest sync at/before is index 0.
    expect(findKeyframeBefore(BFRAMES, 3.5)).toBe(0)
    expect(findKeyframeBefore(BFRAMES, 5.5)).toBe(0) // only one keyframe in the fixture
  })
  it('handles an empty table and pre-start times', () => {
    expect(findKeyframeBefore([], 1)).toBe(0)
    expect(findKeyframeBefore(samples, -5)).toBe(0)
  })
})

describe('findSampleAtOrBefore', () => {
  it('picks the presented sample with monotonic cts', () => {
    expect(findSampleAtOrBefore(samples, 0.4)).toBe(12)
    expect(findSampleAtOrBefore(samples, 10 / 30)).toBe(10) // exact hit
  })
  it('clamps to the first/last presented frame at the extremes', () => {
    expect(findSampleAtOrBefore(samples, -1)).toBe(0)
    expect(findSampleAtOrBefore(samples, 100)).toBe(24)
  })
  it('is correct with B-frame (non-monotonic) cts', () => {
    // t=2.5 -> presented frame is cts 2, which sits at DECODE index 3.
    expect(findSampleAtOrBefore(BFRAMES, 2.5)).toBe(3)
    // t=3.5 -> presented frame is cts 3, decode index 1 (before the Bs in decode order).
    expect(findSampleAtOrBefore(BFRAMES, 3.5)).toBe(1)
    // t=4.2 -> presented frame is cts 4, decode index 5.
    expect(findSampleAtOrBefore(BFRAMES, 4.2)).toBe(5)
  })
  it('tolerates float error when the request lands on a frame boundary', () => {
    const tenths: SampleEntry[] = Array.from({ length: 20 }, (_, i) => s(i / 10, i === 0))
    // 1.2 - 1.1 = 0.09999999999999987 must still resolve to the frame at 0.1s.
    expect(findSampleAtOrBefore(tenths, 1.2 - 1.1)).toBe(1)
    // Export's srcTime = inSec + (t - startSec) * speed for a clip starting at
    // 1.1s: every output frame must hit its own source frame, never the previous.
    for (let k = 0; k < 25; k++) {
      expect(findSampleAtOrBefore(samples, 0 + (1.1 + k / 30 - 1.1) * 1)).toBe(k)
    }
  })
  it('does not select the next frame just because it is close', () => {
    expect(findSampleAtOrBefore(samples, 11 / 30 - 0.001)).toBe(10)
  })
})

describe('presentationOffsetSec', () => {
  it('uses the edit list media_time (B-frame delay) when present', () => {
    // 15360 timescale, first cts 1024 (2 frames at 30fps), elst media_time 1024.
    expect(presentationOffsetSec([{ segment_duration: 10000, media_time: 1024 }], 1024, 15360, 1000)).toBeCloseTo(
      1024 / 15360
    )
  })
  it('subtracts leading empty edits (a presentation delay)', () => {
    const edits = [
      { segment_duration: 500, media_time: -1 }, // 0.5s empty, movie timescale 1000
      { segment_duration: 10000, media_time: 0 }
    ]
    expect(presentationOffsetSec(edits, 0, 90000, 1000)).toBeCloseTo(-0.5)
  })
  it('falls back to the minimum cts without an edit list', () => {
    expect(presentationOffsetSec(undefined, 3000, 30000, 1000)).toBeCloseTo(0.1)
    expect(presentationOffsetSec([], 0, 30000, 1000)).toBe(0)
    expect(presentationOffsetSec([{ segment_duration: 5, media_time: -1 }], 600, 600, 600)).toBe(1)
  })
})

describe('parseContentRangeTotal', () => {
  it('reads the total from 206 and 416 forms', () => {
    expect(parseContentRangeTotal('bytes 0-1048575/5000000')).toBe(5000000)
    expect(parseContentRangeTotal('bytes */1234')).toBe(1234)
  })
  it('returns null when absent or unknown', () => {
    expect(parseContentRangeTotal(null)).toBeNull()
    expect(parseContentRangeTotal('bytes 0-99/*')).toBeNull()
  })
})

describe('sampleByteSpan', () => {
  const T: SampleEntry[] = [s(0, true, 1000, 50), s(1, false, 1200, 30), s(2, false, 1100, 40)]

  it('covers min offset to max offset+size across the range (order-independent)', () => {
    expect(sampleByteSpan(T, 0, 2)).toEqual({ start: 1000, end: 1230 })
  })
  it('handles a single sample', () => {
    expect(sampleByteSpan(T, 1, 1)).toEqual({ start: 1200, end: 1230 })
  })
  it('rejects invalid ranges', () => {
    expect(sampleByteSpan(T, 2, 1)).toBeNull()
    expect(sampleByteSpan(T, -1, 1)).toBeNull()
    expect(sampleByteSpan(T, 0, 3)).toBeNull()
    expect(sampleByteSpan([], 0, 0)).toBeNull()
  })
})
