import { describe, it, expect } from 'vitest'
import { clampScrollSec, clampScrollY, fitZoom, followPlayhead, posFromThumb, scrollExtentSec, thumbGeometry, zoomAnchoredScroll } from './timelineScroll'

describe('clampScrollSec', () => {
  it('never scrolls before 0', () => {
    expect(clampScrollSec(-5, 100, 20)).toBe(0)
  })
  it('stops once the content end reaches mid-view', () => {
    expect(clampScrollSec(500, 100, 20)).toBe(90)
    expect(clampScrollSec(50, 100, 20)).toBe(50)
  })
  it('pins to 0 when everything fits', () => {
    expect(clampScrollSec(3, 5, 20)).toBe(0)
  })
  it('recovers from NaN', () => {
    expect(clampScrollSec(NaN, 100, 20)).toBe(0)
  })
})

describe('clampScrollY', () => {
  it('clamps to the overflow height', () => {
    expect(clampScrollY(-1, 400, 300)).toBe(0)
    expect(clampScrollY(50, 400, 300)).toBe(50)
    expect(clampScrollY(500, 400, 300)).toBe(100)
    expect(clampScrollY(20, 200, 300)).toBe(0)
  })
})

describe('followPlayhead', () => {
  it('leaves the scroll alone while the playhead is visible', () => {
    expect(followPlayhead(10, 15, 20)).toBe(10)
  })
  it('pages forward when the playhead nears the right edge', () => {
    expect(followPlayhead(10, 29.5, 20)).toBeCloseTo(27.5)
  })
  it('scrolls back when the playhead jumps left of view', () => {
    expect(followPlayhead(10, 4, 20)).toBeCloseTo(2)
    expect(followPlayhead(10, 1, 20)).toBe(0)
  })
})

describe('zoomAnchoredScroll', () => {
  it('keeps the time under the cursor fixed', () => {
    const s = zoomAnchoredScroll(10, 200, 100, 200) // anchor t = 12
    expect(s + 200 / 200).toBeCloseTo(12)
  })
  it('clamps at 0', () => {
    expect(zoomAnchoredScroll(0, 100, 100, 50)).toBe(0)
  })
})

describe('scrollbar geometry', () => {
  it('extent lets the content end reach mid-view, never less than one view', () => {
    expect(scrollExtentSec(100, 20)).toBe(110)
    expect(scrollExtentSec(5, 20)).toBe(20)
    // consistent with clampScrollSec's maximum
    expect(clampScrollSec(1e9, 100, 20)).toBe(scrollExtentSec(100, 20) - 20)
  })

  it('thumb size/offset track the scroll and round-trip', () => {
    const g = thumbGeometry(45, 10, 100, 500)
    expect(g.size).toBe(50)
    expect(g.offset).toBeCloseTo(225)
    expect(posFromThumb(g.offset, 10, 100, 500)).toBeCloseTo(45)
  })

  it('keeps a minimum thumb size and fills the track when everything fits', () => {
    expect(thumbGeometry(0, 1, 10000, 400).size).toBe(28)
    expect(thumbGeometry(0, 30, 20, 400)).toEqual({ offset: 0, size: 400 })
  })

  it('fitZoom fits the duration with a margin', () => {
    expect(fitZoom(100, 1040)).toBeCloseTo(10)
    expect(fitZoom(0, 1000)).toBe(100)
  })
})
