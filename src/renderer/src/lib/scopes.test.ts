import { describe, it, expect } from 'vitest'
import {
  cbcr709,
  computeScopes,
  density,
  luma709,
  maxCount,
  scopeSampleSize,
  shouldSample,
  VECTORSCOPE_SIZE,
  vectorscopeXY
} from './scopes'

/** RGBA pixels from a list of [r, g, b] (alpha 255). */
function pixels(colors: [number, number, number][]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(colors.length * 4)
  colors.forEach(([r, g, b], i) => px.set([r, g, b, 255], i * 4))
  return px
}

describe('scopeSampleSize', () => {
  it('scales to 256 wide keeping aspect, never upscales', () => {
    expect(scopeSampleSize(1920, 1080)).toEqual({ w: 256, h: 144 })
    expect(scopeSampleSize(1080, 1920)).toEqual({ w: 256, h: 455 })
    expect(scopeSampleSize(100, 50)).toEqual({ w: 100, h: 50 })
    expect(scopeSampleSize(0, 0)).toEqual({ w: 1, h: 1 })
  })
})

describe('BT.709 helpers', () => {
  it('luma709 weights green most and maps white/black to the ends', () => {
    expect(luma709(255, 255, 255)).toBe(255)
    expect(luma709(0, 0, 0)).toBe(0)
    expect(luma709(0, 255, 0)).toBe(182)
    expect(luma709(255, 0, 0)).toBe(54)
    expect(luma709(0, 0, 255)).toBe(18)
  })

  it('cbcr709 is zero for greys and ±0.5 at the primaries', () => {
    const [cb, cr] = cbcr709(0.4, 0.4, 0.4)
    expect(cb).toBeCloseTo(0, 12)
    expect(cr).toBeCloseTo(0, 12)
    expect(cbcr709(0, 0, 1)[0]).toBeCloseTo(0.5, 12)
    expect(cbcr709(1, 0, 0)[1]).toBeCloseTo(0.5, 12)
  })

  it('vectorscopeXY puts neutral in the centre, red up-left, blue right', () => {
    expect(vectorscopeXY(0, 0)).toEqual([128, 128])
    const [rx, ry] = vectorscopeXY(...cbcr709(0.75, 0, 0))
    expect(rx).toBeLessThan(128)
    expect(ry).toBeLessThan(128)
    const [bx] = vectorscopeXY(...cbcr709(0, 0, 0.75))
    expect(bx).toBeGreaterThan(200)
  })
})

describe('computeScopes', () => {
  it('bins the histogram per channel and luma', () => {
    const s = computeScopes(pixels([[255, 0, 0], [255, 0, 0], [0, 0, 255], [128, 128, 128]]), 4, 1)
    expect(s.histogram.r[255]).toBe(2)
    expect(s.histogram.r[0]).toBe(1)
    expect(s.histogram.b[255]).toBe(1)
    expect(s.histogram.luma[54]).toBe(2)
    expect(s.histogram.luma[128]).toBe(1)
    let total = 0
    for (const v of s.histogram.luma) total += v
    expect(total).toBe(4)
  })

  it('builds the waveform per column (level-major layout)', () => {
    // 2×2: left column black over white, right column mid-grey twice.
    const s = computeScopes(pixels([[0, 0, 0], [100, 100, 100], [255, 255, 255], [100, 100, 100]]), 2, 2)
    expect(s.waveform.length).toBe(256 * 2)
    expect(s.waveform[0 * 2 + 0]).toBe(1)
    expect(s.waveform[255 * 2 + 0]).toBe(1)
    expect(s.waveform[100 * 2 + 1]).toBe(2)
  })

  it('plots the vectorscope at the same place as vectorscopeXY/cbcr709', () => {
    const colors: [number, number, number][] = [[191, 0, 0], [0, 191, 191], [40, 90, 200], [128, 128, 128]]
    const s = computeScopes(pixels(colors), colors.length, 1)
    for (const [r, g, b] of colors) {
      const [x, y] = vectorscopeXY(...cbcr709(r / 255, g / 255, b / 255))
      expect(s.vectorscope[y * VECTORSCOPE_SIZE + x]).toBeGreaterThan(0)
    }
    expect(s.vectorscope[128 * VECTORSCOPE_SIZE + 128]).toBe(1) // the grey
  })

  it('tolerates a short buffer', () => {
    const s = computeScopes(new Uint8ClampedArray(4), 4, 4)
    expect(maxCount(s.histogram.luma)).toBe(1)
  })
})

describe('density / throttle', () => {
  it('density is log-scaled 0..1', () => {
    expect(density(0, 100)).toBe(0)
    expect(density(100, 100)).toBe(1)
    expect(density(10, 100)).toBeGreaterThan(0.5) // log scale lifts sparse cells
    expect(density(5, 0)).toBe(0)
  })

  it('maxCount honours a sub-range', () => {
    expect(maxCount([9, 1, 2, 9], 1, 3)).toBe(2)
  })

  it('shouldSample gates by interval', () => {
    expect(shouldSample(1000, 900, 125)).toBe(false)
    expect(shouldSample(1025, 900, 125)).toBe(true)
    expect(shouldSample(0, -Infinity)).toBe(true)
  })
})
