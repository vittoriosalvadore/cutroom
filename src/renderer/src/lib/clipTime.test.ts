import { describe, it, expect } from 'vitest'
import { clipRelToSource, clipSourceSpan, clipSpeed, sourceToTimeline } from './clipTime'

const clip = { startSec: 10, durationSec: 4, inSec: 2, speed: 2 }

describe('clipTime', () => {
  it('defaults speed to 1 when missing or invalid', () => {
    expect(clipSpeed({})).toBe(1)
    expect(clipSpeed({ speed: 0 })).toBe(1)
    expect(clipSpeed({ speed: -3 })).toBe(1)
    expect(clipSpeed({ speed: 0.5 })).toBe(0.5)
  })
  it('scales the consumed source span by speed', () => {
    expect(clipSourceSpan(clip)).toBe(8)
    expect(clipSourceSpan({ ...clip, speed: undefined })).toBe(4)
  })
  it('maps clip-relative timeline offsets to source time', () => {
    expect(clipRelToSource(clip, 0)).toBe(2)
    expect(clipRelToSource(clip, 1.5)).toBe(5)
    expect(clipRelToSource({ ...clip, speed: 0.5 }, 2)).toBe(3)
  })
  it('maps source time back to the timeline (inverse of clipRelToSource)', () => {
    expect(sourceToTimeline(clip, 2)).toBe(10)
    expect(sourceToTimeline(clip, 10)).toBe(14) // end of the 8 s source span
    for (const tRel of [0, 0.3, 1, 3.9]) {
      expect(sourceToTimeline(clip, clipRelToSource(clip, tRel))).toBeCloseTo(clip.startSec + tRel)
    }
  })
})
