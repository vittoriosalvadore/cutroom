import { describe, it, expect } from 'vitest'
import { clampScrollSec, clampScrollY, followPlayhead, zoomAnchoredScroll } from './timelineScroll'

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
