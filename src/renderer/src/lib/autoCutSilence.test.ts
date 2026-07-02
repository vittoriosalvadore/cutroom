import { describe, it, expect } from 'vitest'
import { rangesToTimeline, totalRemovedSec, type SilenceCutRange } from './autoCutSilence'

describe('rangesToTimeline', () => {
  const clip = { startSec: 10, inSec: 0, speed: 1 }

  it('converts source-relative ranges to timeline-absolute at speed 1', () => {
    const out = rangesToTimeline([{ startSec: 2, endSec: 4 }], clip, 0, 10, 0)
    expect(out).toEqual([{ startSec: 12, endSec: 14 }])
  })

  it('clips ranges to the clip visible window', () => {
    // Range starts before the clip's visible window and ends after it.
    const out = rangesToTimeline([{ startSec: -5, endSec: 20 }], clip, 0, 10, 0)
    expect(out).toEqual([{ startSec: 10, endSec: 20 }])
  })

  it('drops ranges entirely outside the visible window', () => {
    const out = rangesToTimeline([{ startSec: 20, endSec: 25 }], clip, 0, 10, 0)
    expect(out).toEqual([])
  })

  it('shrinks ranges inward by the padding amount', () => {
    const out = rangesToTimeline([{ startSec: 2, endSec: 6 }], clip, 0, 10, 0.5)
    expect(out).toEqual([{ startSec: 12.5, endSec: 15.5 }])
  })

  it('drops a range that padding shrinks to zero or negative width', () => {
    const out = rangesToTimeline([{ startSec: 2, endSec: 2.5 }], clip, 0, 10, 0.5)
    expect(out).toEqual([])
  })

  it('scales the timeline conversion by clip speed', () => {
    // speed 2: every 1 source second is 0.5 timeline seconds.
    const fast = { startSec: 10, inSec: 0, speed: 2 }
    const out = rangesToTimeline([{ startSec: 4, endSec: 6 }], fast, 0, 20, 0)
    expect(out).toEqual([{ startSec: 12, endSec: 13 }])
  })

  it('offsets correctly when inSec is non-zero', () => {
    const trimmed = { startSec: 5, inSec: 3, speed: 1 }
    const out = rangesToTimeline([{ startSec: 4, endSec: 5 }], trimmed, 3, 13, 0)
    // srcTime 4 -> timeline 5 + (4-3) = 6 ; srcTime 5 -> timeline 5 + (5-3) = 7
    expect(out).toEqual([{ startSec: 6, endSec: 7 }])
  })
})

describe('totalRemovedSec', () => {
  it('sums range durations', () => {
    const ranges: SilenceCutRange[] = [
      { startSec: 1, endSec: 3 },
      { startSec: 10, endSec: 10.5 }
    ]
    expect(totalRemovedSec(ranges)).toBeCloseTo(2.5)
  })
  it('returns 0 for no ranges', () => {
    expect(totalRemovedSec([])).toBe(0)
  })
})

