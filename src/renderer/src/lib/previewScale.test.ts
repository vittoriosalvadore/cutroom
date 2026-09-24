import { describe, it, expect } from 'vitest'
import { previewScale, scaledCanvasSize } from './previewScale'

describe('previewScale', () => {
  it('maps Full / Half / Quarter to linear scales; anything else renders full', () => {
    expect(previewScale('full')).toBe(1)
    expect(previewScale('half')).toBe(0.5)
    expect(previewScale('quarter')).toBe(0.25)
    expect(previewScale('eighth')).toBe(1)
    expect(previewScale(undefined)).toBe(1)
    expect(previewScale('toString')).toBe(1) // no prototype keys
  })
})

describe('scaledCanvasSize', () => {
  it('returns the project size untouched at scale 1 (export path)', () => {
    expect(scaledCanvasSize(1920, 1080, 1)).toEqual({ w: 1920, h: 1080 })
    expect(scaledCanvasSize(1921, 1079, 1)).toEqual({ w: 1921, h: 1079 })
  })

  it('scales and rounds to whole pixels', () => {
    expect(scaledCanvasSize(1920, 1080, 0.5)).toEqual({ w: 960, h: 540 })
    expect(scaledCanvasSize(1920, 1080, 0.25)).toEqual({ w: 480, h: 270 })
    expect(scaledCanvasSize(1281, 721, 0.5)).toEqual({ w: 641, h: 361 })
  })

  it('never upscales, never collapses, and ignores garbage scales', () => {
    expect(scaledCanvasSize(1920, 1080, 4)).toEqual({ w: 1920, h: 1080 })
    expect(scaledCanvasSize(4, 4, 0.25)).toEqual({ w: 2, h: 2 })
    expect(scaledCanvasSize(1920, 1080, NaN)).toEqual({ w: 1920, h: 1080 })
    expect(scaledCanvasSize(1920, 1080, 0)).toEqual({ w: 1920, h: 1080 })
  })
})
