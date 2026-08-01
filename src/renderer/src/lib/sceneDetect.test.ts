import { describe, it, expect } from 'vitest'
import { computeHistogram, histogramDistance } from './sceneDetect'

function fakeImage(pixels: number[][]): ImageData {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  })
  return { data, width: pixels.length, height: 1 } as unknown as ImageData
}

describe('computeHistogram', () => {
  it('puts all mass in one bin per channel for a solid-color image', () => {
    const hist = computeHistogram(fakeImage([[10, 10, 10], [10, 10, 10], [10, 10, 10]]))
    // 16 bins over 0..255: value 10 -> bin (10*16)>>8 = 0.
    expect(hist[0]).toBeCloseTo(1)
    expect(hist[16]).toBeCloseTo(1) // G channel's bin 0
    expect(hist[32]).toBeCloseTo(1) // B channel's bin 0
  })

  it('normalizes each channel to sum to 1 regardless of pixel count', () => {
    const hist = computeHistogram(fakeImage([[0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255]]))
    let rSum = 0
    for (let i = 0; i < 16; i++) rSum += hist[i]
    expect(rSum).toBeCloseTo(1)
  })
})

describe('histogramDistance', () => {
  it('is zero for identical histograms', () => {
    const hist = computeHistogram(fakeImage([[50, 50, 50], [50, 50, 50]]))
    expect(histogramDistance(hist, hist)).toBeCloseTo(0)
  })

  it('is (close to) 1 for a hard cut between opposite colors', () => {
    const black = computeHistogram(fakeImage([[0, 0, 0], [0, 0, 0]]))
    const white = computeHistogram(fakeImage([[255, 255, 255], [255, 255, 255]]))
    expect(histogramDistance(black, white)).toBeCloseTo(1)
  })

  it('grows with how much of the frame actually changed', () => {
    const base = Array.from({ length: 100 }, () => [100, 100, 100])
    const partial = [...base]
    partial[0] = [250, 250, 250] // 1 of 100 pixels changes drastically
    const total = base.map(() => [250, 250, 250]) // every pixel changes

    const distPartial = histogramDistance(computeHistogram(fakeImage(base)), computeHistogram(fakeImage(partial)))
    const distTotal = histogramDistance(computeHistogram(fakeImage(base)), computeHistogram(fakeImage(total)))

    expect(distPartial).toBeGreaterThan(0)
    expect(distPartial).toBeLessThan(distTotal)
  })
})
